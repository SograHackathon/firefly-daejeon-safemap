/**
 * 보호자 페이지에서 사용자 위치 조회
 * GET /api/sos/share/[token]
 * → { status, last_location, last_location_at, started_at, expires_at, destination_name }
 */
import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params
  if (!token || token.length < 16) {
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })
  }

  const hash = sha256(token)
  const { data: viewData, error } = await supabase.rpc('sos_view_by_token', { p_token_hash: hash })

  if (error) {
    return new Response(JSON.stringify({ error: 'lookup_failed', detail: error.message }), { status: 500 })
  }
  if (!viewData) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
  }

  const view: any = viewData
  // OTP 미인증이면 위치/경로 노출 X — RPC 가 last_location 을 null 로 비워서 보냄
  // 추가 컬럼 (planned_route 등) 도 인증 후에만 가져옴
  let extraFields: Record<string, any> = {
    planned_route: null,
    planned_route_label: null,
    destination_lng: null,
    destination_lat: null,
  }
  if (!view.needs_otp) {
    const { data: extra } = await supabase
      .from('guardian_links')
      .select('sos_sessions ( planned_route, planned_route_label, destination_lng, destination_lat )')
      .eq('token_hash', hash)
      .maybeSingle()
    const sess: any = (extra as any)?.sos_sessions || null
    extraFields = {
      planned_route: sess?.planned_route ?? null,
      planned_route_label: sess?.planned_route_label ?? null,
      destination_lng: sess?.destination_lng ?? null,
      destination_lat: sess?.destination_lat ?? null,
    }
  }
  const merged = { ...view, ...extraFields }

  // 감사 로그 (best effort)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || null
  const ua = req.headers.get('user-agent') || null
  supabase.from('guardian_audit').insert({
    link_id: null,
    ip, user_agent: ua,
    action: 'view',
    meta: { token_hash: hash.slice(0, 8) },
  }).then(() => {}, () => {})

  return Response.json(merged)
}
