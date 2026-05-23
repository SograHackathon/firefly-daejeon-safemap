/**
 * SOS 위치 업데이트 (사용자 → DB)
 * POST { session_id, lng, lat }
 * → { ok: true, status }
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

const Body = z.object({
  session_id: z.string().uuid(),
  lng: z.number(),
  lat: z.number(),
})

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })
  }
  const { session_id, lng, lat } = parsed.data

  // 활성 + 만료 안 됨 만
  const { data: sess, error: sErr } = await supabase
    .from('sos_sessions')
    .select('status, expires_at')
    .eq('id', session_id)
    .single()

  if (sErr || !sess) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
  if (sess.status !== 'active') return new Response(JSON.stringify({ error: 'inactive', status: sess.status }), { status: 410 })
  if (new Date(sess.expires_at).getTime() < Date.now()) {
    await supabase.from('sos_sessions').update({ status: 'expired' }).eq('id', session_id)
    return new Response(JSON.stringify({ error: 'expired' }), { status: 410 })
  }

  const { error: upErr } = await supabase
    .from('sos_sessions')
    .update({
      last_location: `SRID=4326;POINT(${lng} ${lat})`,
      last_location_at: new Date().toISOString(),
    })
    .eq('id', session_id)

  if (upErr) return new Response(JSON.stringify({ error: 'update_failed', detail: upErr.message }), { status: 500 })

  return Response.json({ ok: true, status: 'active' })
}
