/**
 * SOS 세션 시작 + 보호자 공유 토큰 발급
 * 익명 사용자 허용. user_id / guardian_id 는 null.
 *
 * POST { lng, lat, name? }
 * → { session_id, token, share_url }
 *
 * 토큰은 클라이언트에 1회만 전달, DB에는 SHA-256 hash 만 저장.
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const Body = z.object({
  lng: z.number(),
  lat: z.number(),
  name: z.string().max(40).nullable().optional(),
  // 안내 경로 (GeoJSON LineString) — 보호자에게 공유
  planned_route: z.object({
    type: z.literal('LineString'),
    coordinates: z.array(z.tuple([z.number(), z.number()])).min(2),
  }).nullable().optional(),
  planned_route_label: z.string().max(40).nullable().optional(),
  // 목적지 좌표 (보호자 페이지에서 도착지 마커 표시용)
  destination_lng: z.number().nullable().optional(),
  destination_lat: z.number().nullable().optional(),
})

function randomToken() {
  // 24 bytes → 32자 base64url (충돌 가능성 무시 가능)
  return crypto.randomBytes(24).toString('base64url')
}
function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })
  }
  const { lng, lat, name, planned_route, planned_route_label, destination_lng, destination_lat } = parsed.data

  // 1) sos_session 생성 (익명, expires_at 2시간)
  const insertPayload: Record<string, unknown> = {
    user_id: null,
    destination_name: name ?? null,
    status: 'active',
    // last_location: PostGIS WKT
    last_location: `SRID=4326;POINT(${lng} ${lat})`,
    last_location_at: new Date().toISOString(),
  }
  if (planned_route) insertPayload.planned_route = planned_route
  if (planned_route_label) insertPayload.planned_route_label = planned_route_label
  if (destination_lng != null) insertPayload.destination_lng = destination_lng
  if (destination_lat != null) insertPayload.destination_lat = destination_lat
  // PostGIS destination geography 도 같이 저장
  if (destination_lng != null && destination_lat != null) {
    insertPayload.destination = `SRID=4326;POINT(${destination_lng} ${destination_lat})`
  }

  const { data: sess, error: sessErr } = await supabase
    .from('sos_sessions')
    .insert(insertPayload)
    .select('id, started_at, expires_at')
    .single()

  if (sessErr || !sess) {
    return new Response(JSON.stringify({ error: 'session_create_failed', detail: sessErr?.message }), { status: 500 })
  }

  // 2) 보호자 공유 토큰
  const token = randomToken()
  const tokenHash = sha256(token)

  const { error: linkErr } = await supabase.from('guardian_links').insert({
    sos_id: sess.id,
    guardian_id: null,
    token_hash: tokenHash,
    expires_at: sess.expires_at,
  })
  if (linkErr) {
    // 세션은 만들었으니 정리 (best effort)
    await supabase.from('sos_sessions').update({ status: 'aborted', ended_at: new Date().toISOString() }).eq('id', sess.id)
    return new Response(JSON.stringify({ error: 'link_create_failed', detail: linkErr.message }), { status: 500 })
  }

  // 3) 감사 로그
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || null
  const ua = req.headers.get('user-agent') || null
  await supabase.from('audit_log').insert({
    action: 'sos_start',
    ip, user_agent: ua,
    meta: { session_id: sess.id },
  })

  const proto = req.headers.get('x-forwarded-proto') || 'http'
  const host = req.headers.get('host') || 'localhost:3000'
  const shareUrl = `${proto}://${host}/sos/share/${token}`

  return Response.json({
    session_id: sess.id,
    token,
    share_url: shareUrl,
    started_at: sess.started_at,
    expires_at: sess.expires_at,
  })
}
