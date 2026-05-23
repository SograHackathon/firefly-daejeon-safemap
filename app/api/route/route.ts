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

    // start-end 직선 위 균등 chunk 샘플링 — swap 시 동일한 hotspot pool 보장 (양방향 대칭)
    const numChunks =
      realDist < 800  ? 2 :
      realDist < 2000 ? 3 :
      realDist < 4000 ? 4 : 5
    const chunkPoints: LngLat[] = []
    for (let i = 1; i <= numChunks; i++) {
      const t = i / (numChunks + 1)
      chunkPoints.push({
        lng: start.lng + (end.lng - start.lng) * t,
        lat: start.lat + (end.lat - start.lat) * t,
      })
    }

    // ========= STEP 3. 각 청킹 점에서 핫스팟 발굴 (balanced + night 병렬) =========
    const balancedPromises = chunkPoints.map(p =>
      supabase.rpc('safety_hotspots', {
        center_lng: p.lng, center_lat: p.lat,
        radius_m: chunkParams.radiusM, mode: 'balanced'
      }).then(r => ({ mode: 'balanced' as const, data: r.data || [] }))
    )
    const nightPromises = chunkPoints.map(p =>
      supabase.rpc('safety_hotspots', {
        center_lng: p.lng, center_lat: p.lat,
        radius_m: chunkParams.radiusM, mode: 'night'
      }).then(r => ({ mode: 'night' as const, data: r.data || [] }))
    )
    const hotspotResults = chunkPoints.length === 0 ? [] : await Promise.all([
      ...balancedPromises, ...nightPromises
    ])

    // 청킹 점당 top 3개씩 — chunk 위치가 방향 따라 달라도 pool 충분히 커지게 (swap 비대칭 완화)
    const hotspotMap = new Map<string, LngLat & { score: number; mode: 'balanced' | 'night' }>()
    hotspotResults.forEach(({ mode, data }) => {
      const arr = data as Array<{ lng: number; lat: number; score: number }>
      arr.slice(0, 3).forEach(best => {
        const key = `${best.lng.toFixed(4)}_${best.lat.toFixed(4)}`
        const existing = hotspotMap.get(key)
        if (!existing || best.score > existing.score) {
          hotspotMap.set(key, { ...best, mode })
        }
      })
    })

    // 도착지/출발지 너무 가까운 핫스팟 drop (왕복 경로 방지)
    // 양 끝 동일한 보호 거리 — 출/도착 swap 시 후보 수 비대칭 해소
    const endProtect = Math.max(100, Math.min(220, directDist * 0.12))
    const minFromEnd = endProtect
    const minFromStart = endProtect
    const allHotspots = Array.from(hotspotMap.values()).filter(h => {
      const dEnd = haversineM({ lng: h.lng, lat: h.lat }, end)
      const dStart = haversineM({ lng: h.lng, lat: h.lat }, start)
      return dEnd >= minFromEnd && dStart >= minFromStart
    })

    // 점수순 상위 N개 (Tmap 호출 절감) — 다양화 더 강화
    const maxHotspots = realDist < 1500 ? 8 : realDist < 4000 ? 12 : 16
    const balTop = allHotspots
      .sort((a, b) => b.score - a.score)
      .slice(0, maxHotspots)
      .map(h => ({ lng: h.lng, lat: h.lat, mode: h.mode }))

    // ========= STEP 4. 안심 후보 Tmap 호출 (병렬, mode 별 origin 보존) =========
    const safeRawResults = balTop.length === 0 ? [] : await Promise.all(
      balTop.map(async wp => {
        const r = await tmapOne(start, end, [{ lng: wp.lng, lat: wp.lat }])
        return r ? { ...r, _mode: wp.mode } : null
      })
    )
    const safeRaws = safeRawResults.filter((r): r is NonNullable<typeof r> => Boolean(r))

    // 결과 경로가 도착지를 한 번 통과 후 되돌아오는 패턴 검사
    // 마지막 25% 는 도착 진입 구간 — 제외. threshold 30m (실제 통과만 차단)
    const isRoundTrip = (route: any) => {
      const cs = route.geometry.coordinates as [number, number][]
      if (cs.length < 10) return false
      const checkUntil = Math.floor(cs.length * 0.75)
      for (let i = 2; i < checkUntil; i++) {
        const p = { lng: cs[i][0], lat: cs[i][1] }
        if (haversineM(p, end) < 30) return true
      }
      return false
    }

    // ========= 자기근접 루프(돌출 우회) 제거 =========
    // 경로상의 두 점 Pi, Pj (j-i>=3) 이 직선거리 < SAME_THRESH 인데
    // 그 사이 누적 경로가 LOOP_MIN_ARC 이상이면 → Pi+1..Pj-1 잘라냄.
    // (V/T 자 모양 detour 만 제거. 일반 골목길에는 영향 X)
    const SAME_THRESH = 25
    const LOOP_MIN_ARC = 120
    const MAX_SCAN_ARC = 800
    function deLoop(coords: [number, number][]): [number, number][] {
      if (coords.length < 6) return coords
      const out: [number, number][] = []
      let i = 0
      while (i < coords.length) {
        out.push(coords[i])
        let bestJ = -1
        let arc = 0
        for (let k = i + 1; k < coords.length; k++) {
          arc += haversineM(
            { lng: coords[k-1][0], lat: coords[k-1][1] },
            { lng: coords[k][0],   lat: coords[k][1] }
          )
          if (arc > MAX_SCAN_ARC) break
          if (k - i < 3) continue
          if (arc < LOOP_MIN_ARC) continue
          const d = haversineM(
            { lng: coords[i][0], lat: coords[i][1] },
            { lng: coords[k][0], lat: coords[k][1] }
          )
          if (d < SAME_THRESH) bestJ = k  // 더 큰 점프가 보이면 갱신
        }
        if (bestJ > i + 1) i = bestJ
        else i++
      }
      return out
    }
    function arcLen(coords: [number, number][]): number {
      let len = 0
      for (let i = 1; i < coords.length; i++) {
        len += haversineM(
          { lng: coords[i-1][0], lat: coords[i-1][1] },
          { lng: coords[i][0],   lat: coords[i][1] }
        )
      }
      return Math.round(len)
    }
    function cleanRoute<T extends { geometry: any; distance_m: number; duration_s: number }>(r: T): T {
      const cs = r.geometry.coordinates as [number, number][]
      const cleaned = deLoop(cs)
      if (cleaned.length === cs.length) return r
      const newDist = arcLen(cleaned)
      return {
        ...r,
        geometry: { type: 'LineString', coordinates: cleaned },
        distance_m: newDist,
        duration_s: Math.round(newDist / WALK_M_PER_SEC),
      }
    }

    const allCandidates: Candidate[] = [{ ...cleanRoute(fastR), origin: 'fast' }]
    for (const r of safeRaws) {
      if (!isRoundTrip(r)) {
        const c = cleanRoute(r)
        allCandidates.push({
          geometry: c.geometry,
          distance_m: c.distance_m,
          duration_s: c.duration_s,
          origin: r._mode,
        })
      }
    }

    // 우회 1.5배 까지 허용 (자연스러운 우회만)
    const fastest = allCandidates.reduce((a, b) => b.distance_m < a.distance_m ? b : a)
    const filtered = allCandidates.filter(c => c.distance_m <= fastest.distance_m * 1.5)

    // 모든 후보 점수 계산 (병렬)
    const scored = await Promise.all(
      filtered.map(async (c) => ({ ...c, scoreData: await scoreRoute(c.geometry) }))
    )

    // === 후보 중복 제거 + 점수순 정렬 ===
    // 비슷한 경로 제거 (20m 이내 → 더 다양한 후보 살림)
    const unique: typeof scored = []
    for (const c of scored) {
      const isDup = unique.some(u => !routesAreDifferent(c, u, 20))
      if (!isDup) unique.push(c)
    }

    // 점수 내림차순 정렬 후 상위 N개 (최대 5)
    const top3 = unique
      .sort((a, b) => (b.scoreData?.score ?? 0) - (a.scoreData?.score ?? 0))
      .slice(0, 5)

    type Card = {
      key: string
      label: string
      route: { geometry: any; distance_m: number; duration_s: number }
      score: any
      recommended?: boolean
    }

    // === 라벨링 (5종 우선순위 자동 할당) ===
    // ⚡ 빠른 길     — origin === 'fast'
    // 🛡 안심 길     — 비-fast 중 점수 가장 높은
    // 💡 밝은 길     — 보안등(lights) 카운트 가장 많은
    // 📹 CCTV 길    — CCTV 카운트 가장 많은
    // 🌿 우회 길     — 나머지
    const labelMap = new Map<number, string>()

    const fastIdx = top3.findIndex(c => c.origin === 'fast')
    if (fastIdx >= 0) labelMap.set(fastIdx, '⚡ 빠른 길')

    // 안심: 비-fast 중 점수 가장 높은 거 (top3 는 이미 점수순)
    const safeIdx = top3.findIndex((c, i) => i !== fastIdx)
    if (safeIdx >= 0 && !labelMap.has(safeIdx)) labelMap.set(safeIdx, '🛡 안심 길')

    // 밝은: 라벨 없는 후보 중 lights 카운트 max
    const remainingForLights = top3
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !labelMap.has(i))
    if (remainingForLights.length > 0) {
      const brightest = remainingForLights.reduce((a, b) =>
        (b.c.scoreData?.counts?.lights ?? 0) > (a.c.scoreData?.counts?.lights ?? 0) ? b : a
      )
      labelMap.set(brightest.i, '💡 밝은 길')
    }

    // CCTV 길: 라벨 없는 후보 중 cctv 카운트 max
    const remainingForCctv = top3
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !labelMap.has(i))
    if (remainingForCctv.length > 0) {
      const cctvMax = remainingForCctv.reduce((a, b) =>
        (b.c.scoreData?.counts?.cctv ?? 0) > (a.c.scoreData?.counts?.cctv ?? 0) ? b : a
      )
      labelMap.set(cctvMax.i, '📹 CCTV 길')
    }

    // 나머지 → 우회 길
    top3.forEach((_, i) => {
      if (!labelMap.has(i)) labelMap.set(i, '🌿 우회 길')
    })

    const candidates: Card[] = top3.map((c, i) => ({
      key: `route_${i + 1}`,
      label: labelMap.get(i) || `경로 ${i + 1}`,
      route: { geometry: c.geometry, distance_m: c.distance_m, duration_s: c.duration_s },
      score: c.scoreData,
    }))

    // 추천: 점수 1위 (top3[0])
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
