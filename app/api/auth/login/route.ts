/**
 * 로그인
 * - Rate Limit 3계층:
 *     · IP 단위 (10분 100회)
 *     · 계정 단위 (10분 5회 — BruteForce 방어)
 *     · 액션 단위 (1분 3회 per IP)
 * - Supabase Auth signInWithPassword (bcrypt 검증, HttpOnly 쿠키 자동 설정)
 * - 실패 시 감사 로그
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { RATE, tooManyResponse, getClientIp } from '@/lib/rate-limit'
import { createClient as createSvc } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const svc = createSvc(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

const Body = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(72),
})

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)

  // 계층 1 + 3
  const ipLimit = RATE.ip(ip)
  if (!ipLimit.ok) return tooManyResponse(ipLimit)

  const json = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }
  const { email, password } = parsed.data

  // 계층 2: 계정 단위 (BruteForce)
  const accountLimit = RATE.login(email)
  if (!accountLimit.ok) {
    svc.from('audit_log').insert({
      action: 'login_blocked',
      ip,
      user_agent: req.headers.get('user-agent') || null,
      meta: { email, reason: 'rate_limit_account', retry_after_sec: accountLimit.retryAfterSec },
    }).then(() => {}, () => {})
    return tooManyResponse(accountLimit)
  }

  // 계층 3: 액션 (IP 당 분당 3회 — 너무 빠른 연속 시도 방지)
  const actionLimit = RATE.action('login', ip)
  if (!actionLimit.ok) return tooManyResponse(actionLimit)

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, {
              ...options,
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'strict',
              path: '/',
            })
          )
        },
      },
    }
  )

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error || !data?.user) {
    svc.from('audit_log').insert({
      action: 'login_fail',
      ip,
      user_agent: req.headers.get('user-agent') || null,
      meta: { email, reason: error?.message || 'no_user' },
    }).then(() => {}, () => {})

    return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    })
  }

  svc.from('audit_log').insert({
    action: 'login_ok',
    user_id: data.user.id,
    ip,
    user_agent: req.headers.get('user-agent') || null,
  }).then(() => {}, () => {})

  return Response.json({ ok: true, user_id: data.user.id })
}
