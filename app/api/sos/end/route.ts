/**
 * SOS 세션 종료
 * POST { session_id }
 * → { ok: true }
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
})

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })
  }
  const { session_id } = parsed.data

  const { error } = await supabase
    .from('sos_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', session_id)
    .in('status', ['active'])

  if (error) return new Response(JSON.stringify({ error: 'update_failed', detail: error.message }), { status: 500 })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || null
  const ua = req.headers.get('user-agent') || null
  await supabase.from('audit_log').insert({
    action: 'sos_end',
    ip, user_agent: ua,
    meta: { session_id },
  })

  return Response.json({ ok: true })
}
