/**
 * 데이터 적재 공통 유틸
 */
import { config } from 'dotenv'
import dns from 'dns'
import { createClient } from '@supabase/supabase-js'
import proj4 from 'proj4'

// data.go.kr 도메인은 IPv6 응답이 불안정해서 IPv4 강제
dns.setDefaultResultOrder('ipv4first')

// Next.js 의 .env.local 명시 로드
config({ path: '.env.local' })
config({ path: '.env' })

// ==================== Supabase Admin ====================
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY!

if (!SUPABASE_URL || !SUPABASE_SECRET) {
  throw new Error('Missing SUPABASE env')
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ==================== 인증키 ====================
export const PUBLIC_DATA_KEY = process.env.PUBLIC_DATA_API_KEY!
export const PUBLIC_DATA_KEY_ENCODED = process.env.PUBLIC_DATA_API_KEY_ENCODED!

if (!PUBLIC_DATA_KEY) {
  throw new Error('Missing PUBLIC_DATA_API_KEY')
}

// ==================== 좌표계 정의 ====================
// EPSG:5181 — TM 중부원점 (GRS80) · 유성구 CCTV
proj4.defs(
  'EPSG:5181',
  '+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs'
)
// EPSG:5174 — TM 중부원점 (Bessel) · 안전비상벨
proj4.defs(
  'EPSG:5174',
  '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43'
)
// EPSG:5179 — UTMK · 편의점
proj4.defs(
  'EPSG:5179',
  '+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs'
)

/**
 * 입력 좌표를 자동 판별하여 WGS84 [lng, lat] 로 변환.
 * 응답 좌표가 어느 좌표계인지 모를 때 안전한 방법.
 */
export function autoToWgs84(x: number, y: number): { lng: number; lat: number } | null {
  // 1) 이미 WGS84 (lng=126~128, lat=33~39)
  if (x >= 124 && x <= 132 && y >= 33 && y <= 39) {
    return { lng: x, lat: y }
  }
  // 1-2) lat/lng 순서 뒤바뀐 WGS84
  if (y >= 124 && y <= 132 && x >= 33 && x <= 39) {
    return { lng: y, lat: x }
  }
  // 2) WGS84 × 1,000,000 (마이크로도)
  if (x > 120_000_000 && x < 135_000_000) {
    return { lng: x / 1_000_000, lat: y / 1_000_000 }
  }
  // 3) TM 좌표 (대략 200000~400000)
  if (x >= 100_000 && x <= 500_000 && y >= 100_000 && y <= 700_000) {
    try {
      const [lng, lat] = proj4('EPSG:5181', 'EPSG:4326', [x, y])
      if (lng >= 124 && lng <= 132 && lat >= 33 && lat <= 39) return { lng, lat }
    } catch {}
    // x/y 뒤바뀐 케이스
    try {
      const [lng, lat] = proj4('EPSG:5181', 'EPSG:4326', [y, x])
      if (lng >= 124 && lng <= 132 && lat >= 33 && lat <= 39) return { lng, lat }
    } catch {}
  }
  // 4) UTMK (대략 900000~1,100,000)
  if (x >= 800_000 && x <= 1_200_000 && y >= 1_500_000 && y <= 2_500_000) {
    try {
      const [lng, lat] = proj4('EPSG:5179', 'EPSG:4326', [x, y])
      if (lng >= 124 && lng <= 132 && lat >= 33 && lat <= 39) return { lng, lat }
    } catch {}
  }
  return null
}

/**
 * EPSG 명시적 변환
 */
export function projTo4326(epsg: 'EPSG:5181' | 'EPSG:5174' | 'EPSG:5179', x: number, y: number) {
  const [lng, lat] = proj4(epsg, 'EPSG:4326', [x, y])
  return { lng, lat }
}

// ==================== Fetch 헬퍼 ====================
/**
 * 디코딩 키 우선, 실패 시 인코딩 키로 폴백
 */
export async function fetchPublicApi(
  endpoint: string,
  params: Record<string, string | number>
) {
  const url = new URL(endpoint)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)))
  url.searchParams.set('serviceKey', PUBLIC_DATA_KEY)

  let res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })

  // 400/401 시 인코딩 키로 재시도 (URL 직접 조립)
  if ((res.status === 400 || res.status === 401) && PUBLIC_DATA_KEY_ENCODED) {
    const params2 = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => params2.set(k, String(v)))
    const raw = endpoint + '?' + params2.toString() + '&serviceKey=' + PUBLIC_DATA_KEY_ENCODED
    res = await fetch(raw, { headers: { Accept: 'application/json' } })
  }

  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res
}

// ==================== Insert 헬퍼 (PostGIS POINT) ====================
/**
 * 한 번에 많은 row 를 chunked insert. geom 은 SQL function 으로 만들기 위해
 * supabase-js 의 raw insert 대신 RPC 호출이 정석이지만,
 * 우리는 lat/lng → 임시 컬럼으로 받고 trigger 로 geom 생성하거나
 * 여기서는 단순화하여 PostGIS WKT 텍스트로 insert.
 */
export async function insertPoints(
  table: string,
  rows: Array<{ lng: number; lat: number; [k: string]: unknown }>
) {
  if (rows.length === 0) return { inserted: 0 }

  // PostGIS geography 컬럼에 WKT 'POINT(lng lat)' 텍스트 캐스팅
  const payload = rows.map(({ lng, lat, ...rest }) => ({
    ...rest,
    geom: `SRID=4326;POINT(${lng} ${lat})`,
  }))

  // 한번에 너무 많이 보내면 timeout — 500개씩 chunk
  let inserted = 0
  const CHUNK = 500
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK)
    const { error, count } = await supabase
      .from(table)
      .insert(slice, { count: 'exact' })
    if (error) {
      console.error(`[${table}] insert error:`, error.message)
      throw error
    }
    inserted += count || slice.length
    process.stdout.write(`  ${inserted}/${payload.length}\r`)
  }
  console.log(`\n  ✓ ${table}: ${inserted} rows inserted`)
  return { inserted }
}

// ==================== 진행률 ====================
export function log(...args: unknown[]) {
  console.log('[' + new Date().toLocaleTimeString('ko-KR') + ']', ...args)
}
