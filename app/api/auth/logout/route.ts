/**
 * 로그아웃 — 세션 폐기 + 쿠키 삭제
 */
import { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createClient as createSvc } from '@supabase/supabase-js'
import { getClientIp } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const svc = createSvc(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

export async function POST(req: NextRequest) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, { ...options, path: '/' })
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  await supabase.auth.signOut()

  if (user) {
    svc.from('audit_log').insert({
      action: 'logout',
      user_id: user.id,
      ip: getClientIp(req),
      user_agent: req.headers.get('user-agent') || null,
    }).then(() => {}, () => {})
  }

  return Response.json({ ok: true })
}
