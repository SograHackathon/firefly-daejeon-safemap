-- ============================================================
-- RLS 정책 v1
-- 01_schema.sql 실행 후 이어서 실행
-- ============================================================

-- ============================================================
-- 1. 공공데이터 테이블 (전체 읽기 허용, 쓰기 차단)
-- ============================================================
alter table public.cctv enable row level security;
alter table public.lights enable row level security;
alter table public.bells enable row level security;
alter table public.cvs enable row level security;
alter table public.danger_zones enable row level security;
alter table public.blindspots enable row level security;

drop policy if exists "cctv_select_all" on public.cctv;
create policy "cctv_select_all" on public.cctv for select using (true);

drop policy if exists "lights_select_all" on public.lights;
create policy "lights_select_all" on public.lights for select using (true);

drop policy if exists "bells_select_all" on public.bells;
create policy "bells_select_all" on public.bells for select using (true);

drop policy if exists "cvs_select_all" on public.cvs;
create policy "cvs_select_all" on public.cvs for select using (true);

drop policy if exists "danger_select_all" on public.danger_zones;
create policy "danger_select_all" on public.danger_zones for select using (true);

drop policy if exists "blindspots_select_all" on public.blindspots;
create policy "blindspots_select_all" on public.blindspots for select using (true);

-- ============================================================
-- 2. profiles - 본인 것만 select/update
-- ============================================================
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_self" on public.profiles;
create policy "profiles_select_self" on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles for update
  using (auth.uid() = id);

-- ============================================================
-- 3. guardians - 본인 보호자만 관리
-- ============================================================
alter table public.guardians enable row level security;

drop policy if exists "guardians_select_self" on public.guardians;
create policy "guardians_select_self" on public.guardians for select
  using (auth.uid() = user_id);

drop policy if exists "guardians_insert_self" on public.guardians;
create policy "guardians_insert_self" on public.guardians for insert
  with check (auth.uid() = user_id);

drop policy if exists "guardians_update_self" on public.guardians;
create policy "guardians_update_self" on public.guardians for update
  using (auth.uid() = user_id);

drop policy if exists "guardians_delete_self" on public.guardians;
create policy "guardians_delete_self" on public.guardians for delete
  using (auth.uid() = user_id);

-- ============================================================
-- 4. sos_sessions - 본인 SOS 만
-- ============================================================
alter table public.sos_sessions enable row level security;

drop policy if exists "sos_select_self" on public.sos_sessions;
create policy "sos_select_self" on public.sos_sessions for select
  using (auth.uid() = user_id);

drop policy if exists "sos_insert_self" on public.sos_sessions;
create policy "sos_insert_self" on public.sos_sessions for insert
  with check (auth.uid() = user_id);

drop policy if exists "sos_update_self" on public.sos_sessions;
create policy "sos_update_self" on public.sos_sessions for update
  using (auth.uid() = user_id);

-- ============================================================
-- 5. guardian_links - 본인 SOS 의 링크만
-- 보호자(비로그인)는 API Route 에서 service key 로 처리
-- ============================================================
alter table public.guardian_links enable row level security;

drop policy if exists "glinks_select_owner" on public.guardian_links;
create policy "glinks_select_owner" on public.guardian_links for select
  using (
    exists (
      select 1 from public.sos_sessions s
      where s.id = sos_id and s.user_id = auth.uid()
    )
  );

-- ============================================================
-- 6. reports - 모두 읽기, 본인만 작성
-- ============================================================
alter table public.reports enable row level security;

drop policy if exists "reports_select_approved" on public.reports;
create policy "reports_select_approved" on public.reports for select
  using (status = 'approved' or user_id = auth.uid());

drop policy if exists "reports_insert_self" on public.reports;
create policy "reports_insert_self" on public.reports for insert
  with check (auth.uid() = user_id);

drop policy if exists "reports_update_self" on public.reports;
create policy "reports_update_self" on public.reports for update
  using (auth.uid() = user_id);

-- ============================================================
-- 7. audit_log / guardian_audit / rate_limit - 백엔드 전용
-- (RLS 켜두고 select 정책 없음 = anon/authenticated 차단)
-- ============================================================
alter table public.audit_log enable row level security;
alter table public.guardian_audit enable row level security;
alter table public.rate_limit enable row level security;

-- 본인 audit 만 조회 허용 (선택)
drop policy if exists "audit_select_self" on public.audit_log;
create policy "audit_select_self" on public.audit_log for select
  using (auth.uid() = user_id);
