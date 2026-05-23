/**
 * 좌표 → POI 정확 클릭 매칭
 * 카카오 Local 카테고리 검색을 작은 반경으로 호출 → 클릭 좌표에서 8m 이내일 때만 채택
 * (빈 도로/건물 클릭 시 카드 안 뜨도록)
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const KAKAO_KEY = process.env.KAKAO_REST_KEY || ''

// POI 아이콘 위를 정확히 클릭한 경우만 매칭 (15m 이내)
const MAX_DIST_M = 15

const Q = z.object({
  lng: z.coerce.number(),
  lat: z.coerce.number(),
  radius: z.coerce.number().optional(),
})

// 카카오 Local 카테고리 그룹 코드 (전체 18종 — 누락 시 빈 결과 가능)
const CATEGORIES = [
  'FD6', // 음식점
  'CE7', // 카페
  'CS2', // 편의점
  'MT1', // 대형마트
  'BK9', // 은행
  'HP8', // 병원
  'PM9', // 약국
  'AT4', // 관광명소
  'PO3', // 공공기관
  'CT1', // 문화시설
  'OL7', // 주유,충전소
  'SC4', // 학교
  'SW8', // 지하철역
  'PK6', // 주차장
  'AC5', // 학원
  'AD5', // 숙박
  'PS3', // 어린이집,유치원
  'AG2', // 중개업소
]

async function categorySearch(cat: string, lng: number, lat: number, radius: number) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/category.json')
  url.searchParams.set('category_group_code', cat)
  url.searchParams.set('x', String(lng))
  url.searchParams.set('y', String(lat))
  url.searchParams.set('radius', String(radius))
  url.searchParams.set('sort', 'distance')
  url.searchParams.set('size', '3')

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return []
    const json = await res.json()
    return (json.documents || []) as any[]
  } catch {
    return []
  }
}

// 카테고리 그룹 코드 없는 POI (공원, 오피스텔, 교회, 빌라 등) 보강용
const KEYWORDS = ['공원', '센터', '빌라', '오피스텔', '아파트', '교회', '세차', '학원']

async function keywordSearch(q: string, lng: number, lat: number, radius: number) {
  const url = new URL('https://dapi.kakao.com/v2/local/search/keyword.json')
  url.searchParams.set('query', q)
  url.searchParams.set('x', String(lng))
  url.searchParams.set('y', String(lat))
  url.searchParams.set('radius', String(radius))
  url.searchParams.set('sort', 'distance')
  url.searchParams.set('size', '5')

  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return []
    const json = await res.json()
    return (json.documents || []) as any[]
  } catch {
    return []
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const parsed = Q.safeParse({
    lng: sp.get('lng'),
    lat: sp.get('lat'),
    radius: sp.get('radius') ?? undefined,
  })
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })
  }
  const { lng, lat } = parsed.data
  // 카카오 검색 자체 반경은 충분히 넓게 (가까운 POI 다 가져와 거리순 정렬)
  // — 그러나 최종 매칭은 MAX_DIST_M 이내 만 채택
  const searchRadius = parsed.data.radius ?? 100

  // 카테고리 검색 + 키워드 검색 병렬 (카테고리 코드 없는 POI 도 매칭)
  const [catDocs, kwDocs] = await Promise.all([
    Promise.all(CATEGORIES.map(c => categorySearch(c, lng, lat, searchRadius))).then(a => a.flat()),
    Promise.all(KEYWORDS.map(k => keywordSearch(k, lng, lat, searchRadius))).then(a => a.flat()),
  ])

  // id 기준 dedup
  const seen = new Set<string>()
  const docs = [...catDocs, ...kwDocs].filter(d => {
    if (seen.has(d.id)) return false
    seen.add(d.id)
    return true
  })

  if (docs.length === 0) {
    return Response.json({ place: null, reason: 'no_poi_nearby' })
  }

  docs.sort((a, b) => parseFloat(a.distance) - parseFloat(b.distance))
  const top = docs[0]
  const dist = parseFloat(top.distance)

  // 너무 멀면 빈 영역 클릭으로 간주 — 카드 안 띄움
  if (dist > MAX_DIST_M) {
    return Response.json({ place: null, reason: 'too_far', nearest_distance_m: dist })
  }

  return Response.json({
    place: {
      id: `poi_${top.id}`,
      name: top.place_name,
      address: top.road_address_name || top.address_name || '',
      category: top.category_group_name || top.category_name?.split('>').pop()?.trim() || '',
      lng: parseFloat(top.x),
      lat: parseFloat(top.y),
    },
    distance_m: dist,
  })
}
