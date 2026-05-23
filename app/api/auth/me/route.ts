/**
 * 현재 로그인된 사용자 정보 조회 (브라우저 polling 용)
 */
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createClient as createSvc } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const svc = createSvc(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

export async function GET() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},
      },
    }
  )

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    return Response.json({ user: null })
  }

  // profiles 에서 phone / phone_verified 조회 (service role)
  const { data: profile } = await svc.from('profiles')
    .select('phone, phone_verified, display_name')
    .eq('id', user.id)
    .single()

  return Response.json({
    user: {
      id: user.id,
      email: user.email,
      display_name: profile?.display_name || user.user_metadata?.display_name || user.email?.split('@')[0],
      phone: profile?.phone || null,
      phone_verified: !!profile?.phone_verified,
    }
  })
}
