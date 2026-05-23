/**
 * 안심 경로 라우팅
 * - OSRM foot 프로파일로 3개 후보 생성:
 *   ① 빠른 길 (직선)
 *   ② 안심 길 (균형 핫스팟 경유)
 *   ③ 밝은 길 (야간 가중치 핫스팟 경유)
 * - 각 경로에 대해 PostGIS route_safety RPC 호출
 * - 결과 비교 카드 데이터 반환
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  start: z.object({ lng: z.number(), lat: z.number() }),
  end: z.object({ lng: z.number(), lat: z.number() }),
})

const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
})

type LngLat = { lng: number; lat: number }

// 도보 속도 계산 (Tmap 자체 totalTime 무시하고 통일 계산)
const WALK_M_PER_SEC = 1.25  // 4.5km/h

import { tmapPedestrianRoute } from '@/lib/tmap'

// OSRM 폴백 (Tmap 실패 시)
async function osrmRoute(coords: LngLat[], alternatives = false) {
  const path = coords.map(c => `${c.lng},${c.lat}`).join(';')
  const altQ = alternatives ? '&alternatives=3' : ''
  const url = `${OSRM}/route/v1/foot/${path}?overview=full&geometries=geojson&steps=false${altQ}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`OSRM ${res.status}`)
  const json = await res.json()
  const routes = json.routes || []
  if (routes.length === 0) return []
  return routes.map((r: any) => ({
    geometry: r.geometry,
    distance_m: Math.round(r.distance),
    duration_s: Math.round(r.distance / WALK_M_PER_SEC),
  }))
}

// Tmap 메인 라우팅 (경유지 가능, 경로 1개 반환)
async function tmapOne(start: LngLat, end: LngLat, waypoints: LngLat[] = []) {
  const r = await tmapPedestrianRoute(start, end, waypoints)
  if (!r) return null
  return r
}

// 두 LineString 이 충분히 다른지 판정 (Hausdorff-like 근사)
function routesAreDifferent(a: any, b: any, minDiffM = 50) {
  // 단순 거리 비교: 거리 차이 또는 좌표 평균 거리
  const dDist = Math.abs(a.distance_m - b.distance_m)
  if (dDist > 100) return true
  // 평균 위경도 차이
  const avg = (geom: any) => {
    const c = geom.coordinates
    const lng = c.reduce((s: number, p: number[]) => s + p[0], 0) / c.length
    const lat = c.reduce((s: number, p: number[]) => s + p[1], 0) / c.length
    return [lng, lat]
  }
  const [a1, a2] = avg(a.geometry)
  const [b1, b2] = avg(b.geometry)
  const dist = Math.sqrt((a1 - b1) ** 2 + (a2 - b2) ** 2) * 111000 // 도 → m 근사
  return dist > minDiffM
}

async function findHotspot(center: LngLat, mode: 'balanced' | 'night'): Promise<LngLat | null> {
  const { data, error } = await supabase.rpc('safety_hotspots', {
    center_lng: center.lng,
    center_lat: center.lat,
    radius_m: 500,
    mode,
  })
  if (error || !data || data.length === 0) return null
  // 상위 1개 선택
  return { lng: data[0].lng, lat: data[0].lat }
}

async function scoreRoute(geometry: any) {
  const { data, error } = await supabase.rpc('route_safety_default', {
    path_geojson: geometry,
  })
  if (error) {
    console.warn('route_safety:', error.message)
    return null
  }
  return data
}

export async function POST(req: NextRequest) {
  const json = await req.json()
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })
  }
  const { start, end } = parsed.data

  try {
    // === 후보 경로 수집 (Tmap 우선, 실패 시 OSRM 폴백) ===
    type Candidate = {
      geometry: any
      distance_m: number
      duration_s: number
      origin: 'fast' | 'balanced' | 'night'
    }

    // ========= Haversine =========
    const haversineM = (a: LngLat, b: LngLat) => {
      const R = 6371000
      const toRad = (d: number) => d * Math.PI / 180
      const dLat = toRad(b.lat - a.lat)
      const dLng = toRad(b.lng - a.lng)
      const x = Math.sin(dLat/2)**2 +
                Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2
      return 2 * R * Math.asin(Math.sqrt(x))
    }
    const directDist = haversineM(start, end)

    // ========= STEP 1. 빠른 길 먼저 (폴리라인 확보) =========
    const fastR = await tmapOne(start, end)
    if (!fastR) {
      const fallback = await osrmRoute([start, end])
      if (fallback.length === 0) {
        return new Response(JSON.stringify({ error: 'all_routing_failed' }), { status: 502 })
      }
      const score = await scoreRoute(fallback[0].geometry)
      return Response.json({
        candidates: [{
          key: 'fast', label: '빠른 길', icon: '⚡',
          route: { geometry: fallback[0].geometry, distance_m: fallback[0].distance_m, duration_s: fallback[0].duration_s },
          score, recommended: true,
        }],
        is_night: score?.is_night ?? false,
        hour: score?.hour ?? null,
        _debug: { tmap: 'failed_fallback_osrm' },
      })
    }

    // ========= STEP 2. 빠른 길 폴리라인 위 청킹 =========
    // 거리별 청킹 파라미터: 빠른 길 실거리(우회 포함) 기준
    const realDist = fastR.distance_m
    const chunkParams = (() => {
      if (realDist < 800)   return { intervalM: 300, radiusM: 250 }
      if (realDist < 2000)  return { intervalM: 500, radiusM: 350 }
      if (realDist < 4000)  return { intervalM: 800, radiusM: 450 }
      return                       { intervalM: 1200, radiusM: 550 }
    })()

    // 폴리라인 따라 누적거리 계산하면서 intervalM 마다 점 샘플링
    // 도착지 근처(60%~) 는 청킹 제외 — 도착지 너머 핫스팟 잡혀 왕복 경로 생기는 거 방지
    const coords = fastR.geometry.coordinates as [number, number][]
    const chunkPoints: LngLat[] = []
    let cumDist = 0
    let lastSample = realDist * 0.15  // 출발 15% 이후부터 샘플
    const sampleUntil = realDist * 0.75  // 도착 25% 전까지 (왕복 방지 + 충분한 청킹)
    for (let i = 1; i < coords.length; i++) {
      const prev: LngLat = { lng: coords[i-1][0], lat: coords[i-1][1] }
      const cur:  LngLat = { lng: coords[i][0],   lat: coords[i][1]   }
      const seg = haversineM(prev, cur)
      cumDist += seg
      if (cumDist >= lastSample && cumDist <= sampleUntil) {
        chunkPoints.push(cur)
        lastSample += chunkParams.intervalM
      }
      if (cumDist > sampleUntil) break
    }

    // ========= STEP 3. 각 청킹 점에서 핫스팟 발굴 (병렬) =========
    const hotspotResults = chunkPoints.length === 0 ? [] : await Promise.all(
      chunkPoints.map(p =>
        supabase.rpc('safety_hotspots', {
          center_lng: p.lng, center_lat: p.lat,
          radius_m: chunkParams.radiusM, mode: 'balanced'
        })
      )
    )

    // 청킹 점당 top 1개씩만 → 진짜 다른 위치 보장
    const hotspotMap = new Map<string, LngLat & { score: number }>()
    hotspotResults.forEach((res) => {
      const data = (res.data || []) as Array<{ lng: number; lat: number; score: number }>
      const best = data[0]
      if (!best) return
      const key = `${best.lng.toFixed(4)}_${best.lat.toFixed(4)}`
      if (!hotspotMap.has(key)) hotspotMap.set(key, best)
    })

    // 도착지/출발지 너무 가까운 핫스팟 drop (왕복 경로 방지)
    // 거리 비례 (직선거리 × 20%, 최소 120m, 최대 350m)
    const minFromEnd = Math.max(120, Math.min(350, directDist * 0.20))
    const minFromStart = Math.max(80, Math.min(200, directDist * 0.12))
    const allHotspots = Array.from(hotspotMap.values()).filter(h => {
      const dEnd = haversineM({ lng: h.lng, lat: h.lat }, end)
      const dStart = haversineM({ lng: h.lng, lat: h.lat }, start)
      return dEnd >= minFromEnd && dStart >= minFromStart
    })

    // 점수순 상위 N개 (Tmap 호출 절감)
    const maxHotspots = realDist < 1500 ? 3 : realDist < 4000 ? 4 : 5
    const balTop: LngLat[] = allHotspots
      .sort((a, b) => b.score - a.score)
      .slice(0, maxHotspots)
      .map(h => ({ lng: h.lng, lat: h.lat }))

    // ========= STEP 4. 안심 후보 Tmap 호출 (병렬) =========
    const safeRawResults = balTop.length === 0 ? [] : await Promise.all(
      balTop.map(wp => tmapOne(start, end, [wp]))
    )
    const safeRaws = safeRawResults.filter(Boolean)

    // 결과 경로가 도착지를 한 번 통과 후 되돌아오는 패턴 검사
    // 경로 폴리라인 끝에서 두 번째 이상 지점에서 도착지 근처(80m)를 지나면 = 왕복
    const isRoundTrip = (route: any) => {
      const cs = route.geometry.coordinates as [number, number][]
      if (cs.length < 8) return false
      // 마지막 몇 점은 도착지 근처이니 제외
      const checkUntil = Math.max(0, cs.length - 4)
      for (let i = 2; i < checkUntil; i++) {
        const p = { lng: cs[i][0], lat: cs[i][1] }
        if (haversineM(p, end) < 80) return true
      }
      return false
    }

    const allCandidates: Candidate[] = [{ ...fastR, origin: 'fast' }]
    for (const r of safeRaws) {
      if (!isRoundTrip(r)) allCandidates.push({ ...r, origin: 'balanced' })
    }

    // 우회 1.6배 까지만 허용
    const fastest = allCandidates.reduce((a, b) => b.distance_m < a.distance_m ? b : a)
    const filtered = allCandidates.filter(c => c.distance_m <= fastest.distance_m * 1.6)

    // 모든 후보 점수 계산 (병렬)
    const scored = await Promise.all(
      filtered.map(async (c) => ({ ...c, scoreData: await scoreRoute(c.geometry) }))
    )

    // === 후보 중복 제거 + 점수순 정렬 ===
    // 비슷한 경로 제거 (50m 이내)
    const unique: typeof scored = []
    for (const c of scored) {
      const isDup = unique.some(u => !routesAreDifferent(c, u, 50))
      if (!isDup) unique.push(c)
    }

    // 점수 내림차순 정렬 후 상위 3개
    const top3 = unique
      .sort((a, b) => (b.scoreData?.score ?? 0) - (a.scoreData?.score ?? 0))
      .slice(0, 3)

    type Card = {
      key: string
      label: string
      route: { geometry: any; distance_m: number; duration_s: number }
      score: any
      recommended?: boolean
    }

    const candidates: Card[] = top3.map((c, i) => ({
      key: `route_${i + 1}`,
      label: `경로 ${i + 1}`,
      route: { geometry: c.geometry, distance_m: c.distance_m, duration_s: c.duration_s },
      score: c.scoreData,
    }))

    // 추천: 점수 1위
    if (candidates[0]) candidates[0].recommended = true

    return Response.json({
      candidates,
      is_night: top3[0]?.scoreData?.is_night ?? false,
      hour: top3[0]?.scoreData?.hour ?? null,
      _debug: {
        direct_dist_m: Math.round(directDist),
        fast_dist_m: realDist,
        chunk_points: chunkPoints.length,
        hotspots_found: balTop.length,
        candidates_requested: 1 + balTop.length,
        unique_count: unique.length,
        returned: candidates.length,
      },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: 'internal', message: e.message }), { status: 500 })
  }
}
