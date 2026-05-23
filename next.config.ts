import type { NextConfig } from "next";

/**
 * 8대 보안 설계 중 #8 (API 키 유출 · 보안 헤더) 의 보안 헤더 일괄 적용.
 * CSP: 카카오맵 SDK / Supabase / Tmap 외부 도메인 허용 + 인라인 스크립트 차단
 * HSTS: HTTPS 강제 (production 한정)
 * X-Frame-Options: clickjacking 차단
 * Referrer-Policy: 외부 사이트로 referrer 누설 최소화
 * Permissions-Policy: 사용 안 하는 API 차단 (camera/mic 등)
 */
const isProd = process.env.NODE_ENV === 'production'

// CSP 화이트리스트
// 카카오맵 SDK 가 http://t1.daumcdn.net 으로 sub-resource 로드 → http 도 허용
const CSP = [
  "default-src 'self'",
  // Kakao Maps SDK + worker (http 도 허용 — SDK 가 http 로 sub-resource 호출)
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://dapi.kakao.com https://*.daumcdn.net http://*.daumcdn.net https://*.kakao.com https://*.kakaocdn.net",
  "style-src 'self' 'unsafe-inline' https://*.daumcdn.net http://*.daumcdn.net https://*.kakao.com https://*.kakaocdn.net",
  "img-src 'self' data: blob: https://*.daumcdn.net http://*.daumcdn.net https://*.kakao.com https://*.daum.net https://*.kakaocdn.net https://map.daum.net",
  "font-src 'self' data: https://*.daumcdn.net http://*.daumcdn.net https://*.kakaocdn.net",
  // BFF · Kakao Local · Supabase REST · Tmap REST · OSRM 호출 허용
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://dapi.kakao.com https://*.daumcdn.net http://*.daumcdn.net https://*.kakao.com https://*.daum.net https://*.kakaocdn.net https://apis.openapi.sk.com https://router.project-osrm.org",
  // 카카오 SDK 가 worker 사용 가능성
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // 외부 iframe 금지
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), payment=(), usb=(), geolocation=(self)'
  },
  // HSTS — production 만 (localhost 개발 환경에선 적용 X)
  ...(isProd ? [{
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  }] : []),
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ]
  },
};

export default nextConfig;
