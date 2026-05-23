/**
 * 카카오 reverse geocoding (좌표 → 주소)
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'

export const runtime = 'nodejs'

const KAKAO_KEY = process.env.KAKAO_REST_KEY || ''

const Query = z.object({
  lng: z.string(),
  lat: z.string(),
})

export async function GET(req: NextRequest) {
  const parsed = Query.safeParse({
    lng: req.nextUrl.searchParams.get('lng') || '',
    lat: req.nextUrl.searchParams.get('lat') || '',
  })
  if (!parsed.success) return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })

  const { lng, lat } = parsed.data
  const url = new URL('https://dapi.kakao.com/v2/local/geo/coord2address.json')
  url.searchParams.set('x', lng)
  url.searchParams.set('y', lat)

  const res = await fetch(url.toString(), {
    headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
  })
  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'upstream', status: res.status }), { status: res.status })
  }
  const data = await res.json()
  const doc = data.documents?.[0]
  if (!doc) return Response.json({ address: null })

  // 도로명주소 우선, 없으면 지번주소
  const road = doc.road_address?.address_name
  const lot = doc.address?.address_name
  const region3 = doc.address?.region_3depth_name  // 동/리
  const buildingName = doc.road_address?.building_name

  // 짧은 표시 라벨: 동 이름 + 건물명 또는 도로명 마지막 부분
  let shortLabel: string
  if (buildingName) {
    shortLabel = buildingName
  } else if (road) {
    // 도로명 마지막 (예: "대학로 99" → "대학로 99")
    const parts = road.split(' ')
    shortLabel = parts.slice(-2).join(' ')
  } else if (region3) {
    shortLabel = region3
  } else {
    shortLabel = '내 위치'
  }

  return Response.json({
    address: road || lot,
    short: shortLabel,
    region: region3,
    building: buildingName || null,
  })
}
