/**
 * Tmap 보행자 라우팅
 * https://apis.openapi.sk.com/tmap/routes/pedestrian
 */
import dns from 'dns'
dns.setDefaultResultOrder('ipv4first')

const TMAP_KEY = process.env.TMAP_APP_KEY || ''
const ENDPOINT = 'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&format=json'

export type LngLat = { lng: number; lat: number }
export type Route = {
  geometry: { type: 'LineString'; coordinates: [number, number][] }
  distance_m: number
  duration_s: number
}

const WALK_M_PER_SEC = 1.25 // 4.5 km/h

/**
 * Tmap 보행자 라우팅 호출
 * @param start 출발지
 * @param end 도착지
 * @param waypoints 경유지 최대 5개
 */
export async function tmapPedestrianRoute(
  start: LngLat,
  end: LngLat,
  waypoints: LngLat[] = []
): Promise<Route | null> {
  if (!TMAP_KEY) {
    console.warn('TMAP_APP_KEY missing')
    return null
  }

  const body: any = {
    startX: start.lng.toString(),
    startY: start.lat.toString(),
    endX: end.lng.toString(),
    endY: end.lat.toString(),
    startName: encodeURIComponent('출발'),
    endName: encodeURIComponent('도착'),
    reqCoordType: 'WGS84GEO',
    resCoordType: 'WGS84GEO',
    searchOption: '0', // 0=추천(최단), 4=최단거리+계단 우선, 30=최단+큰길 우선
  }

  // 경유지 (최대 5개)
  if (waypoints.length > 0) {
    body.passList = waypoints
      .slice(0, 5)
      .map(w => `${w.lng},${w.lat}`)
      .join('_')
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      appKey: TMAP_KEY,
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) {
    const txt = await res.text()
    console.warn(`Tmap ${res.status}: ${txt.slice(0, 200)}`)
    return null
  }

  const json = await res.json()
  const features = json.features || []
  if (features.length === 0) return null

  // 모든 LineString 의 coordinates 를 합쳐서 단일 경로 생성
  const coords: [number, number][] = []
  let totalDist = 0
  for (const f of features) {
    if (f.geometry.type === 'LineString') {
      const c = f.geometry.coordinates as [number, number][]
      if (coords.length > 0) {
        // 마지막 좌표와 새 시작 좌표가 같으면 중복 제거
        const last = coords[coords.length - 1]
        const first = c[0]
        if (last[0] !== first[0] || last[1] !== first[1]) {
          coords.push(...c)
        } else {
          coords.push(...c.slice(1))
        }
      } else {
        coords.push(...c)
      }
      if (f.properties?.distance) totalDist += f.properties.distance
    }
  }

  if (coords.length === 0) return null

  // totalDistance / totalTime 은 첫 Feature 의 properties 에 들어있음
  const summary = features[0]?.properties || {}
  const distance_m = Math.round(summary.totalDistance || totalDist)
  // Tmap 자체 totalTime 은 보행 기준 분당 가정 — 우리 통일 위해 시속 4.5km 로 계산
  const duration_s = Math.round(distance_m / WALK_M_PER_SEC)

  return {
    geometry: { type: 'LineString', coordinates: coords },
    distance_m,
    duration_s,
  }
}
