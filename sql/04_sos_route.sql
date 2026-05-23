-- ============================================================
-- SOS 세션에 안내 경로 + 목적지 좌표 컬럼 추가
-- Supabase SQL Editor 에서 실행
-- ============================================================

alter table public.sos_sessions
  add column if not exists planned_route jsonb,
  add column if not exists planned_route_label text,
  add column if not exists destination_lng double precision,
  add column if not exists destination_lat double precision;
