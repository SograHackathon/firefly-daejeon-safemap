-- ============================================================
-- 대전 안심맵 DB 스키마 v1
-- Supabase SQL Editor 에서 이 파일 통째로 실행
-- ============================================================

-- PostGIS 확장 (이미 enabled 일 것)
create extension if not exists postgis;
create extension if not exists "uuid-ossp";

-- ============================================================
-- 1. 공공데이터 정적 테이블 (사전 적재용)
-- ============================================================

-- 1-1. CCTV
create table if not exists public.cctv (
  id bigserial primary key,
  source text not null,                  -- 'daejeon_crime' | 'daejeon_vehicle' | 'daejeon_traffic'
  source_id text,                        -- 원본 데이터셋 row id
  purpose text,                          -- '방범' | '차량방범' | '교통관제'
  address text,
  road_address text,
  district text,                         -- '유성구' | '서구' ...
  installed_at date,
  geom geography(Point, 4326) not null,  -- WGS84 위경도
  raw jsonb,
  created_at timestamptz default now()
);
create index if not exists cctv_geom_idx on public.cctv using gist (geom);
create index if not exists cctv_district_idx on public.cctv (district);

-- 1-2. 보안등(가로등)
create table if not exists public.lights (
  id bigserial primary key,
  source text not null,
  source_id text,
  address text,
  district text,
  geom geography(Point, 4326) not null,
  raw jsonb,
  created_at timestamptz default now()
);
create index if not exists lights_geom_idx on public.lights using gist (geom);

-- 1-3. 안전비상벨
create table if not exists public.bells (
  id bigserial primary key,
  source text not null,
  source_id text,
  name text,
  address text,
  district text,
  geom geography(Point, 4326) not null,
  raw jsonb,
  created_at timestamptz default now()
);
create index if not exists bells_geom_idx on public.bells using gist (geom);

-- 1-4. 편의점 (24시간 필드 포함)
create table if not exists public.cvs (
  id bigserial primary key,
  brand text,                            -- 'GS25' | 'CU' | '7-Eleven' ...
  name text,
  address text,
  district text,
  is_24h boolean default false,
  geom geography(Point, 4326) not null,
  raw jsonb,
  created_at timestamptz default now()
);
create index if not exists cvs_geom_idx on public.cvs using gist (geom);
create index if not exists cvs_24h_idx on public.cvs (is_24h);

-- 1-5. 보행자 교통사고 다발지역 (TAAS)
create table if not exists public.danger_zones (
  id bigserial primary key,
  source_id text,
  district text,
  -- 시간대별 사고건수 (TAAS 4구간)
  acc_morning int default 0,             -- 06:00 ~ 11:59
  acc_afternoon int default 0,           -- 12:00 ~ 17:59
  acc_evening int default 0,             -- 18:00 ~ 21:59
  acc_night int default 0,               -- 22:00 ~ 05:59
  acc_total int default 0,
  casualty int default 0,                -- 사상자 수
  death int default 0,                   -- 사망자
  injury int default 0,                  -- 부상자
  year_from int,
  year_to int,
  geom geography(Polygon, 4326) not null, -- 반경 150m 폴리곤
  raw jsonb,
  created_at timestamptz default now()
);
create index if not exists danger_geom_idx on public.danger_zones using gist (geom);

-- ============================================================
-- 2. 사각지대 사전 계산 결과
-- ============================================================
create table if not exists public.blindspots (
  id bigserial primary key,
  district text,
  area_m2 numeric,
  geom geography(Polygon, 4326) not null,
  computed_at timestamptz default now(),
  cctv_radius_m int default 50           -- 계산 시 사용한 반경
);
create index if not exists blindspots_geom_idx on public.blindspots using gist (geom);

-- ============================================================
-- 3. 사용자 / 인증 / 보호자
-- ============================================================

-- Supabase auth.users 와 1:1 매핑
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  phone text,                            -- 본인 인증용
  phone_verified boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 보호자 (사전 등록)
create table if not exists public.guardians (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  name text not null,                    -- '엄마', '아빠'
  phone text not null,                   -- 보호자 폰
  phone_verified boolean default false,  -- SMS 인증 완료 여부
  verification_code text,                -- 인증 코드 (hash)
  verification_expires_at timestamptz,
  created_at timestamptz default now(),
  unique (user_id, phone)
);

-- ============================================================
-- 4. SOS 세션
-- ============================================================
create table if not exists public.sos_sessions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  destination geography(Point, 4326),
  destination_name text,
  status text default 'active' check (status in ('active','ended','expired','aborted')),
  started_at timestamptz default now(),
  ended_at timestamptz,
  expires_at timestamptz default (now() + interval '2 hours'),
  last_location geography(Point, 4326),
  last_location_at timestamptz
);
create index if not exists sos_user_idx on public.sos_sessions (user_id);
create index if not exists sos_status_idx on public.sos_sessions (status);

-- 보호자 토큰 (각 SOS 세션 당 보호자별로 발급)
create table if not exists public.guardian_links (
  id uuid primary key default uuid_generate_v4(),
  sos_id uuid references public.sos_sessions(id) on delete cascade not null,
  guardian_id uuid references public.guardians(id) on delete cascade not null,
  token_hash text not null unique,       -- token 의 SHA256 hash (raw token 저장 X)
  otp_hash text,                         -- 보호자 OTP hash
  otp_attempts int default 0,
  otp_verified boolean default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists glinks_token_idx on public.guardian_links (token_hash);
create index if not exists glinks_sos_idx on public.guardian_links (sos_id);

-- 보호자 조회 감사 로그
create table if not exists public.guardian_audit (
  id bigserial primary key,
  link_id uuid references public.guardian_links(id) on delete cascade,
  ip text,
  user_agent text,
  action text not null,                  -- 'view' | 'otp_attempt' | 'otp_success' | 'otp_fail'
  meta jsonb,
  created_at timestamptz default now()
);

-- ============================================================
-- 5. 시민 제보
-- ============================================================
create table if not exists public.reports (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references public.profiles(id) on delete set null,
  type text not null check (type in ('blindspot','light_broken','danger_path','other')),
  description text,
  photo_url text,
  -- 50m 그리드 좌표 (k-익명화)
  grid_geom geography(Point, 4326) not null,
  status text default 'pending' check (status in ('pending','approved','rejected')),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  created_at timestamptz default now()
);
create index if not exists reports_grid_idx on public.reports using gist (grid_geom);
create index if not exists reports_status_idx on public.reports (status);

-- ============================================================
-- 6. Rate Limit / Audit
-- ============================================================
create table if not exists public.rate_limit (
  key text primary key,
  count int default 1,
  window_start timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists public.audit_log (
  id bigserial primary key,
  user_id uuid,
  action text not null,
  ip text,
  user_agent text,
  meta jsonb,
  created_at timestamptz default now()
);
create index if not exists audit_user_idx on public.audit_log (user_id);
create index if not exists audit_action_idx on public.audit_log (action);

-- ============================================================
-- 7. 자동 업데이트 트리거
-- ============================================================
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists profiles_set_updated on public.profiles;
create trigger profiles_set_updated
before update on public.profiles
for each row execute function public.tg_set_updated_at();

-- ============================================================
-- 8. auth.users 신규 가입 시 profiles 자동 생성
-- ============================================================
create or replace function public.tg_handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.tg_handle_new_user();
