/**
 * Next.js 미들웨어
 * - Supabase 세션 자동 갱신 (HttpOnly · Secure · SameSite 쿠키)
 * - 추가 보안 헤더 (next.config.ts 와 함께)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: { headers: req.headers } })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => req.cookies.set(name, value))
          res = NextResponse.next({ request: { headers: req.headers } })
          cookiesToSet.forEach(({ name, value, options }) =>
            res.cookies.set({
              name,
              value,
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

  // 세션 강제 갱신 (만료 임박 시 자동 회전)
  const { data: { user } } = await supabase.auth.getUser()

  // 비로그인 시 보호 경로 → /auth/login 으로 리다이렉트
  const path = req.nextUrl.pathname
  const isPublic =
    path.startsWith('/auth/') ||
    path.startsWith('/api/') ||            // API 들은 각자 인증/Rate Limit 처리
    path.startsWith('/sos/share/') ||      // 보호자 페이지는 토큰만으로 접근
    path.startsWith('/_next/') ||
    path === '/favicon.ico' ||
    // 정적 파일 (public 폴더 이미지/SVG/woff 등)은 로그인 무관 통과
    /\.(?:jpe?g|png|svg|ico|webp|gif|avif|woff2?|ttf|otf|css|js|map|json|txt|xml)$/i.test(path)

  if (!user && !isPublic) {
    const url = req.nextUrl.clone()
    url.pathname = '/auth/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  return res
}

export const config = {
  matcher: [
    /*
     * Next 내부 정적 파일과 image optimizer 는 제외
     * 그 외 모든 경로에서 미들웨어 작동 (세션 갱신)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)',
  ],
}
