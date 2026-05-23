-- ============================================================
-- RPC 함수 5종
-- Supabase SQL Editor 에서 01_schema.sql, 02_rls.sql 다음에 실행
-- ============================================================
--
-- 1) points_in_bbox        : 4종 점 레이어 bbox 조회
-- 2) danger_in_bbox        : 사고다발 폴리곤 bbox 조회
-- 3) point_safety          : 사용자 위치 반경 안전점수
-- 4) safety_hotspots       : 영역 내 안전 핫스팟 후보 좌표
-- 5) route_safety_default  : 경로 폴리라인 점수
--
-- 가중치 (README 명세)
--   CCTV    0.28
--   보안등  0.22
--   비상벨  0.15
--   편의점  0.15
--   사고    0.13 (페널티)
--   시간대  0.07 (야간 보정으로 흡수)
--
-- 야간 (20~06시) 보정
--   보안등 × 1.5, 편의점 × 1.3, 사고 × 1.5
-- ============================================================


-- ============================================================
-- 1. points_in_bbox  (cctv/lights/bells/cvs 4종)
-- ============================================================
drop function if exists public.points_in_bbox(text, float, float, float, float, int);

create or replace function public.points_in_bbox(
  layer text,
  min_lng float,
  min_lat float,
  max_lng float,
  max_lat float,
  max_n int default 500
)
returns table (id bigint, lat float, lng float)
language plpgsql stable
security definer
set search_path = public
as $$
declare
  bbox geography := st_setsrid(st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326), 4326)::geography;
begin
  if layer = 'cctv' then
    return query
      select c.id,
             st_y(c.geom::geometry)::float,
             st_x(c.geom::geometry)::float
      from public.cctv c
      where c.geom && bbox
      limit max_n;
  elsif layer = 'lights' then
    return query
      select l.id,
             st_y(l.geom::geometry)::float,
             st_x(l.geom::geometry)::float
      from public.lights l
      where l.geom && bbox
      limit max_n;
  elsif layer = 'bells' then
    return query
      select b.id,
             st_y(b.geom::geometry)::float,
             st_x(b.geom::geometry)::float
      from public.bells b
      where b.geom && bbox
      limit max_n;
  elsif layer = 'cvs' then
    return query
      select v.id,
             st_y(v.geom::geometry)::float,
             st_x(v.geom::geometry)::float
      from public.cvs v
      where v.geom && bbox
      limit max_n;
  end if;
end
$$;

grant execute on function public.points_in_bbox(text, float, float, float, float, int) to anon, authenticated;


-- ============================================================
-- 2. danger_in_bbox  (사고다발 폴리곤)
-- ============================================================
drop function if exists public.danger_in_bbox(float, float, float, float, int);

create or replace function public.danger_in_bbox(
  min_lng float,
  min_lat float,
  max_lng float,
  max_lat float,
  max_n int default 200
)
returns table (
  id bigint,
  coords jsonb,
  casualty int,
  acc_total int
)
language sql stable
security definer
set search_path = public
as $$
  with bbox as (
    select st_setsrid(st_makeenvelope(min_lng, min_lat, max_lng, max_lat, 4326), 4326)::geography as g
  )
  select
    d.id,
    (st_asgeojson(d.geom)::jsonb)->'coordinates' as coords,
    d.casualty,
    d.acc_total
  from public.danger_zones d, bbox
  where d.geom && bbox.g
  limit max_n;
$$;

grant execute on function public.danger_in_bbox(float, float, float, float, int) to anon, authenticated;


-- ============================================================
-- 3. point_safety  (사용자 위치 반경 안전점수)
-- ============================================================
drop function if exists public.point_safety(float, float, int);

create or replace function public.point_safety(
  user_lng float,
  user_lat float,
  radius_m int default 50
)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  user_pt geography := st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography;
  hour_now int := extract(hour from now() at time zone 'Asia/Seoul')::int;
  night boolean := (hour_now >= 20 or hour_now < 6);

  cnt_cctv int;
  cnt_lights int;
  cnt_bells int;
  cnt_cvs int;
  cnt_cvs_24h int;

  -- 정규화 (50m 반경 기대 최대치)
  cctv_norm float;
  lights_norm float;
  bells_norm float;
  cvs_norm float;

  weight_cctv float := 0.28;
  weight_lights float := 0.22;
  weight_bells float := 0.15;
  weight_cvs float := 0.15;
  total_weight float;
  score float;
begin
  select count(*) into cnt_cctv   from public.cctv   where st_dwithin(geom, user_pt, radius_m);
  select count(*) into cnt_lights from public.lights where st_dwithin(geom, user_pt, radius_m);
  select count(*) into cnt_bells  from public.bells  where st_dwithin(geom, user_pt, radius_m);
  select count(*) into cnt_cvs    from public.cvs    where st_dwithin(geom, user_pt, radius_m);
  select count(*) into cnt_cvs_24h from public.cvs   where is_24h and st_dwithin(geom, user_pt, radius_m);

  -- 50m 반경 기대 최대 (도시 평균치 기반)
  cctv_norm   := least(cnt_cctv::float   / 3, 1.0);    -- 3대 이상이면 만점
  lights_norm := least(cnt_lights::float / 6, 1.0);    -- 6대
  bells_norm  := least(cnt_bells::float  / 1, 1.0);    -- 1대
  cvs_norm    := least((case when night then cnt_cvs_24h else cnt_cvs end)::float / 2, 1.0);

  if night then
    weight_lights := weight_lights * 1.5;
    weight_cvs    := weight_cvs * 1.3;
  end if;

  total_weight := weight_cctv + weight_lights + weight_bells + weight_cvs;

  score := (
    cctv_norm   * weight_cctv +
    lights_norm * weight_lights +
    bells_norm  * weight_bells +
    cvs_norm    * weight_cvs
  ) / total_weight * 100;

  return jsonb_build_object(
    'score', round(score)::int,
    'is_night', night,
    'hour', hour_now,
    'radius_m', radius_m,
    'counts', jsonb_build_object(
      'cctv',   cnt_cctv,
      'lights', cnt_lights,
      'bells',  cnt_bells,
      'cvs',    cnt_cvs
    )
  );
end
$$;

grant execute on function public.point_safety(float, float, int) to anon, authenticated;


-- ============================================================
-- 4. safety_hotspots  (영역 내 안전 핫스팟 후보)
--    candidates = 반경 내 CCTV / 비상벨 / 편의점 좌표
--    each candidate score = 주변 시설 가중 카운트
-- ============================================================
drop function if exists public.safety_hotspots(float, float, int, text);

create or replace function public.safety_hotspots(
  center_lng float,
  center_lat float,
  radius_m int default 500,
  mode text default 'balanced'
)
returns table (lng float, lat float, score float)
language plpgsql stable
security definer
set search_path = public
as $$
declare
  center geography := st_setsrid(st_makepoint(center_lng, center_lat), 4326)::geography;
  hour_now int := extract(hour from now() at time zone 'Asia/Seoul')::int;
  night boolean := (hour_now >= 20 or hour_now < 6);
  use_night boolean := (mode = 'night') or (mode = 'balanced' and night);
begin
  return query
  with raw_candidates as (
    -- 반경 내 CCTV
    select st_x(c.geom::geometry) as cx, st_y(c.geom::geometry) as cy
    from public.cctv c
    where st_dwithin(c.geom, center, radius_m)
    union all
    -- 반경 내 비상벨
    select st_x(b.geom::geometry), st_y(b.geom::geometry)
    from public.bells b
    where st_dwithin(b.geom, center, radius_m)
    union all
    -- 야간이면 24h 편의점 후보 추가
    select st_x(v.geom::geometry), st_y(v.geom::geometry)
    from public.cvs v
    where st_dwithin(v.geom, center, radius_m)
      and (not use_night or v.is_24h)
  ),
  dedup as (
    -- 좌표 4자리(약 10m) dedup → 후보 줄임
    select distinct on (round(cx::numeric, 4), round(cy::numeric, 4))
      cx, cy
    from raw_candidates
  ),
  scored as (
    select
      d.cx as lng_,
      d.cy as lat_,
      (
        -- CCTV(120m, ×2.0)
        coalesce((
          select count(*) from public.cctv
          where st_dwithin(geom, st_setsrid(st_makepoint(d.cx, d.cy), 4326)::geography, 120)
        ), 0)::float * 2.0
        +
        -- 비상벨(250m, ×5.0)
        coalesce((
          select count(*) from public.bells
          where st_dwithin(geom, st_setsrid(st_makepoint(d.cx, d.cy), 4326)::geography, 250)
        ), 0)::float * 5.0
        +
        -- 보안등(50m, ×0.5)
        coalesce((
          select count(*) from public.lights
          where st_dwithin(geom, st_setsrid(st_makepoint(d.cx, d.cy), 4326)::geography, 50)
        ), 0)::float * 0.5
        +
        -- 야간 한정 24h 편의점(150m, ×6.0)
        case when use_night then
          coalesce((
            select count(*) from public.cvs
            where is_24h
              and st_dwithin(geom, st_setsrid(st_makepoint(d.cx, d.cy), 4326)::geography, 150)
          ), 0)::float * 6.0
        else 0 end
      ) as raw_score
    from dedup d
  )
  select s.lng_, s.lat_, s.raw_score
  from scored s
  where s.raw_score > 0
  order by s.raw_score desc
  limit 30;
end
$$;

grant execute on function public.safety_hotspots(float, float, int, text) to anon, authenticated;


-- ============================================================
-- 5. route_safety_default  (경로 폴리라인 점수)
--    입력: GeoJSON LineString
--    버퍼: 100m
-- ============================================================
drop function if exists public.route_safety_default(jsonb);

create or replace function public.route_safety_default(
  path_geojson jsonb
)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  line geometry := st_setsrid(st_geomfromgeojson(path_geojson::text), 4326);
  buf geography := st_buffer(line::geography, 100);   -- 100m 버퍼

  cnt_cctv int;
  cnt_lights int;
  cnt_bells int;
  cnt_cvs int;
  cnt_cvs_24h int;
  cnt_danger int;
  danger_casualty int;

  hour_now int := extract(hour from now() at time zone 'Asia/Seoul')::int;
  night boolean := (hour_now >= 20 or hour_now < 6);

  route_len_m float := st_length(line::geography);
  route_len_km float := greatest(route_len_m / 1000, 0.1);

  -- 정규화 (km 당 기대 최대치)
  cctv_norm float;
  lights_norm float;
  bells_norm float;
  cvs_norm float;
  danger_safety float;   -- 1 = 안전, 0 = 매우 위험

  weight_cctv float := 0.28;
  weight_lights float := 0.22;
  weight_bells float := 0.15;
  weight_cvs float := 0.15;
  weight_danger float := 0.13;
  total_weight float;
  score float;
begin
  select count(*) into cnt_cctv   from public.cctv   where geom && buf and st_intersects(geom, buf);
  select count(*) into cnt_lights from public.lights where geom && buf and st_intersects(geom, buf);
  select count(*) into cnt_bells  from public.bells  where geom && buf and st_intersects(geom, buf);
  select count(*) into cnt_cvs    from public.cvs    where geom && buf and st_intersects(geom, buf);
  select count(*) into cnt_cvs_24h from public.cvs   where is_24h and geom && buf and st_intersects(geom, buf);
  select count(*), coalesce(sum(casualty), 0)
    into cnt_danger, danger_casualty
    from public.danger_zones
    where geom && buf and st_intersects(geom, buf);

  -- km 당 시설 밀도 기준 정규화
  cctv_norm   := least((cnt_cctv::float   / route_len_km) / 10, 1.0);   -- 10대/km
  lights_norm := least((cnt_lights::float / route_len_km) / 30, 1.0);   -- 30대/km
  bells_norm  := least((cnt_bells::float  / route_len_km) / 2,  1.0);   -- 2대/km
  cvs_norm    := least(
    ((case when night then cnt_cvs_24h else cnt_cvs end)::float / route_len_km) / 4,
    1.0
  );

  -- 사고 페널티 (사상자 비례, 1 - penalty 가 곧 안전 점수)
  danger_safety := 1.0 - least(danger_casualty::float / 10, 1.0);

  if night then
    weight_lights := weight_lights * 1.5;
    weight_cvs    := weight_cvs * 1.3;
    weight_danger := weight_danger * 1.5;
  end if;

  total_weight := weight_cctv + weight_lights + weight_bells + weight_cvs + weight_danger;

  score := (
    cctv_norm     * weight_cctv +
    lights_norm   * weight_lights +
    bells_norm    * weight_bells +
    cvs_norm      * weight_cvs +
    danger_safety * weight_danger
  ) / total_weight * 100;

  return jsonb_build_object(
    'score', round(score)::int,
    'is_night', night,
    'hour', hour_now,
    'distance_m', round(route_len_m)::int,
    'counts', jsonb_build_object(
      'cctv',         cnt_cctv,
      'lights',       cnt_lights,
      'bells',        cnt_bells,
      'cvs',          cnt_cvs,
      'cvs_24h',      cnt_cvs_24h,
      'danger_zones', cnt_danger
    ),
    'penalty', jsonb_build_object(
      'casualty_total', danger_casualty,
      'danger_safety',  round(danger_safety::numeric, 2)
    ),
    'weights_applied', jsonb_build_object(
      'cctv', weight_cctv, 'lights', weight_lights,
      'bells', weight_bells, 'cvs', weight_cvs, 'danger', weight_danger
    )
  );
end
$$;

grant execute on function public.route_safety_default(jsonb) to anon, authenticated;


-- ============================================================
-- 동작 확인 쿼리 (선택)
-- ============================================================
-- select public.points_in_bbox('cctv', 127.34, 36.35, 127.36, 36.37, 50);
-- select public.point_safety(127.3454, 36.3672, 100);
-- select public.safety_hotspots(127.3454, 36.3672, 500, 'balanced');
-- select public.route_safety_default(
--   '{"type":"LineString","coordinates":[[127.345,36.367],[127.350,36.370]]}'::jsonb
-- );
