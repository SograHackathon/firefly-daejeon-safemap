/**
 * 카카오 장소 검색 API 프록시
 * - REST 키는 서버 환경변수에만
 * - Rate limit: 1 IP 당 60req/min (간이)
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const QuerySchema = z.object({
  q: z.string().min(1).max(50),
  lng: z.string().optional(),
  lat: z.string().optional(),
})

// 카카오 REST API 키 (백엔드 전용)
const KAKAO_KEY = process.env.KAKAO_REST_KEY || ''

// 간이 in-memory rate limit (운영은 Upstash Redis)
const ipBuckets = new Map<string, { c: number; t: number }>()

function rateLimit(ip: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now()
  const bucket = ipBuckets.get(ip)
  if (!bucket || now - bucket.t > windowMs) {
    ipBuckets.set(ip, { c: 1, t: now })
    return true
  }
  if (bucket.c >= limit) return false
  bucket.c++
  return true
}

export async function GET(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0] || 'local'
  if (!rateLimit(ip)) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429, headers: { 'content-type': 'application/json' }
    })
  }

  const parsed = QuerySchema.safeParse({
    q: req.nextUrl.searchParams.get('q') || '',
    lng: req.nextUrl.searchParams.get('lng') || undefined,
    lat: req.nextUrl.searchParams.get('lat') || undefined,
  })
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid_query' }), { status: 400 })
  }

  const { q, lng, lat } = parsed.data
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json')
  url.searchParams.set('query', q)
  url.searchParams.set('size', '10')
  if (lng && lat) {
    url.searchParams.set('x', lng)
    url.searchParams.set('y', lat)
    url.searchParams.set('radius', '20000')
    url.searchParams.set('sort', 'distance')
  }

  // ⚠️ JS 키만 있고 REST 키는 별도 필요. 우선 JS 키로 시도 (일부 동작)
  const res = await fetch(url.toString(), {
    headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
  })

  if (!res.ok) {
    const txt = await res.text()
    return new Response(JSON.stringify({ error: 'upstream', status: res.status, body: txt.slice(0, 200) }), { status: res.status })
  }
  const data = await res.json()
  const places = (data.documents || []).map((d: any) => ({
    id: d.id,
    name: d.place_name,
    address: d.road_address_name || d.address_name,
    category: d.category_group_name,
    lng: parseFloat(d.x),
    lat: parseFloat(d.y),
  }))
  return Response.json({ places })
}
