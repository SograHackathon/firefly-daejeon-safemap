/**
 * 회원가입 (이메일 인증 없음 — autoconfirm)
 * - Zod 검증 + Rate Limit + 비밀번호 5조건 + 흔한비번/이메일 포함 차단
 * - Supabase admin.createUser → 자동 로그인 X. 가입 후 /auth/login 으로 이동
 * - 휴대폰 번호는 회원가입에서 수집 X. SOS 시 사용자가 직접 입력 (localStorage)
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { RATE, tooManyResponse, getClientIp } from '@/lib/rate-limit'
import { createClient as createSvc } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const svc = createSvc(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

const COMMON_PASSWORDS = [
  'password', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyui', 'qwerty123', 'iloveyou', 'admin1234', 'letmein',
  'welcome1', 'monkey123', 'football', 'master123', 'firefly1',
]

const Body = z.object({
  email: z.string().email('이메일 형식이 올바르지 않습니다').max(254),
  password: z.string()
    .min(10, '비밀번호는 10자 이상')
    .max(72, '비밀번호는 72자 이내')
    .regex(/[a-z]/, '소문자 1자 이상 포함')
    .regex(/[A-Z]/, '대문자 1자 이상 포함')
    .regex(/[0-9]/, '숫자 1자 이상 포함')
    .regex(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/, '특수문자(!@#$ 등) 1자 이상'),
  password_confirm: z.string(),
  display_name: z.string().min(1).max(40).optional(),
}).superRefine((data, ctx) => {
  if (data.password !== data.password_confirm) {
    ctx.addIssue({ code: 'custom', path: ['password_confirm'], message: '비밀번호가 일치하지 않습니다' })
  }
  const lower = data.password.toLowerCase()
  for (const w of COMMON_PASSWORDS) {
    if (lower.includes(w)) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: '추측이 쉬운 비밀번호는 사용할 수 없습니다' })
      return
    }
  }
  const local = data.email.split('@')[0]
  if (local.length >= 4 && lower.includes(local.toLowerCase())) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: '비밀번호에 이메일이 포함될 수 없습니다' })
  }
  if (/(.)\1{2,}/.test(data.password)) {
    ctx.addIssue({ code: 'custom', path: ['password'], message: '같은 문자가 3회 이상 반복될 수 없습니다' })
  }
})

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)

  const ipLimit = RATE.ip(ip)
  if (!ipLimit.ok) return tooManyResponse(ipLimit)
  const actionLimit = RATE.action('signup', ip)
  if (!actionLimit.ok) return tooManyResponse(actionLimit)

  const json = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({
      error: 'invalid',
      issues: parsed.error.issues.map(i => i.message),
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }
  const { email, password, display_name } = parsed.data

  // admin.createUser: user 만 만들고 session 발급 X → 회원가입 후 별도 로그인 필요
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      display_name: display_name || email.split('@')[0],
    },
  })

  if (error || !data.user) {
    svc.from('audit_log').insert({
      action: 'signup_fail',
      ip,
      user_agent: req.headers.get('user-agent') || null,
      meta: { email, reason: error?.message || 'no_user' },
    }).then(() => {}, () => {})
    return new Response(JSON.stringify({ error: 'signup_failed', detail: error?.message || '가입 실패' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })
  }

  // profiles 의 display_name 만 업데이트 (phone 은 회원가입에서 수집 X)
  await svc.from('profiles')
    .update({ display_name: display_name || email.split('@')[0] })
    .eq('id', data.user.id)

  svc.from('audit_log').insert({
    action: 'signup_ok',
    user_id: data.user.id,
    ip,
    user_agent: req.headers.get('user-agent') || null,
  }).then(() => {}, () => {})

  return Response.json({
    ok: true,
    user_id: data.user.id,
  })
}
