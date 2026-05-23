-- ============================================================
-- SOS 보호자 OTP + 토큰 조회 RPC
-- Supabase SQL Editor 에서 실행
-- ============================================================

-- 0) 익명 SOS 허용을 위해 user_id / guardian_id NULL 허용
alter table public.sos_sessions  alter column user_id     drop not null;
alter table public.guardian_links alter column guardian_id drop not null;

-- 1) 토큰 hash 로 SOS 세션 + 보호자링크 조회 (RLS 우회용 SECURITY DEFINER)
--    otp_verified 가 false 면 위치/경로는 null 반환 (= 보호자가 OTP 인증 전)
create or replace function public.sos_view_by_token(p_token_hash text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_link  record;
  v_sess  record;
  v_show_loc boolean;
begin
  select * into v_link
  from guardian_links
  where token_hash = p_token_hash
    and revoked_at is null
    and expires_at > now()
  limit 1;

  if not found then
    return null;
  end if;

  select * into v_sess
  from sos_sessions
  where id = v_link.sos_id
  limit 1;

  if not found then
    return null;
  end if;

  -- OTP 검증 통과해야만 위치/경로 노출
  v_show_loc := v_link.otp_verified is true;

  return jsonb_build_object(
    'status', v_sess.status,
    'started_at', v_sess.started_at,
    'ended_at', v_sess.ended_at,
    'expires_at', v_sess.expires_at,
    'destination_name', v_sess.destination_name,
    'needs_otp', not v_show_loc,
    'otp_attempts', v_link.otp_attempts,
    'last_location', case
      when v_show_loc and v_sess.last_location is not null
      then jsonb_build_object(
        'lng', st_x(v_sess.last_location::geometry),
        'lat', st_y(v_sess.last_location::geometry)
      )
      else null end,
    'last_location_at', case when v_show_loc then v_sess.last_location_at else null end
  );
end;
$$;

grant execute on function public.sos_view_by_token(text) to anon, authenticated;


-- 2) OTP 검증 RPC — attempts 5회 초과 시 토큰 자동 revoke
create or replace function public.sos_verify_otp(p_token_hash text, p_otp_hash text)
returns jsonb
language plpgsql
security definer
volatile
set search_path = public
as $$
declare
  v_link record;
begin
  select * into v_link
  from guardian_links
  where token_hash = p_token_hash
    and revoked_at is null
    and expires_at > now()
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- 5회 이상 실패하면 토큰 자체 revoke
  if v_link.otp_attempts >= 5 then
    update guardian_links
       set revoked_at = now()
     where id = v_link.id;
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts', 'revoked', true);
  end if;

  -- 이미 인증된 경우
  if v_link.otp_verified is true then
    return jsonb_build_object('ok', true, 'already_verified', true);
  end if;

  if v_link.otp_hash = p_otp_hash then
    update guardian_links
       set otp_verified = true
     where id = v_link.id;
    return jsonb_build_object('ok', true);
  else
    update guardian_links
       set otp_attempts = otp_attempts + 1
     where id = v_link.id;
    return jsonb_build_object('ok', false, 'error', 'invalid', 'attempts_left', 5 - (v_link.otp_attempts + 1));
  end if;
end;
$$;

grant execute on function public.sos_verify_otp(text, text) to anon, authenticated;


-- 3) 시민 제보 k-익명화 그리드 카운트 RPC (해당 셀의 누적 제보 수 반환)
create or replace function public.reports_grid_count(p_grid_lng float, p_grid_lat float)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from reports
  where st_x(grid_geom::geometry) = p_grid_lng
    and st_y(grid_geom::geometry) = p_grid_lat
    and status in ('pending','approved');
$$;

grant execute on function public.reports_grid_count(float, float) to anon, authenticated;
