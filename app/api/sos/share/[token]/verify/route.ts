/**
 * 보호자 OTP 검증 (Guardian Auth Lv2)
 * POST /api/sos/share/[token]/verify  { otp }
 * - 정상: { ok: true }
 * - 실패: { ok: false, attempts_left }
 * - 5회 누적 실패: 토큰 자체 revoke
 *
 * Rate Limit: IP 단위 + token 단위
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { RATE, getClientIp } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

const Body = z.object({ otp: z.string().regex(/^\d{6}$/) })

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params
  if (!token || token.length < 16) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 })
  }

  // Rate Limit (IP + token 단위 OTP 시도)
  const ip = getClientIp(req)
  const ipRl = RATE.ip(ip)
  if (!ipRl.ok) {
    return new Response(JSON.stringify({ error: 'rate_limit_ip', retry_after_sec: ipRl.retryAfterSec }), {
      status: 429, headers: { 'Retry-After': String(ipRl.retryAfterSec) },
    })
  }
  const actRl = RATE.action('otp', token.slice(0, 16))
  if (!actRl.ok) {
    return new Response(JSON.stringify({ error: 'rate_limit_action', retry_after_sec: actRl.retryAfterSec }), {
      status: 429, headers: { 'Retry-After': String(actRl.retryAfterSec) },
    })
  }

  const json = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid_otp_format' }), { status: 400 })
  }

  const tokenHash = sha256(token)
  const otpHash = sha256(parsed.data.otp)

  const { data, error } = await supabase.rpc('sos_verify_otp', {
    p_token_hash: tokenHash,
    p_otp_hash: otpHash,
  })

  // 감사 로그
  const ua = req.headers.get('user-agent') || null
  const result = (data as any) || {}
  await supabase.from('guardian_audit').insert({
    link_id: null,
    ip, user_agent: ua,
    action: result.ok ? 'otp_success' : 'otp_fail',
    meta: { token_hash: tokenHash.slice(0, 8), error: result.error || null },
  }).then(() => {}, () => {})

  if (error) {
    return new Response(JSON.stringify({ error: 'rpc_failed', detail: error.message }), { status: 500 })
  }

  if (!result.ok) {
    // revoked 케이스
    if (result.revoked) {
      return new Response(JSON.stringify({ error: 'too_many_attempts', revoked: true }), { status: 403 })
    }
    return Response.json({ ok: false, attempts_left: result.attempts_left ?? 0 }, { status: 401 })
  }

  return Response.json({ ok: true })
}
