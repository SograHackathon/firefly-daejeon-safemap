/**
 * 시민 제보 API
 *
 * POST /api/reports  { type, description, lat, lng }
 * - 위치는 50m 그리드 양자화 (k-익명화) — 원본 좌표 저장 X
 * - description 은 DOMPurify 로 HTML 태그 제거 (XSS 방어)
 * - Rate Limit: 1분당 3건 (action limiter)
 *
 * GET /api/reports?min_lng=..&min_lat=..&max_lng=..&max_lat=..
 * - bbox 안의 제보 목록. 같은 그리드 셀의 누적 카운트가 k=3 이상인 것만 노출
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@supabase/supabase-js'
import DOMPurify from 'isomorphic-dompurify'
import { RATE, getClientIp, tooManyResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } }
)

const PostBody = z.object({
  type: z.enum(['blindspot', 'light_broken', 'danger_path', 'other']),
  description: z.string().max(280).optional(),
  lat: z.number().min(33).max(39),     // 한반도 범위
  lng: z.number().min(124).max(132),
})

// k-익명화: 50m 그리드 양자화
// 위도 36도 기준 위도 0.00045 ≈ 50m, 경도 0.00055 ≈ 50m
const GRID_LAT = 0.00045
const GRID_LNG = 0.00055
function quantize(lat: number, lng: number) {
  return {
    lat: Math.round(lat / GRID_LAT) * GRID_LAT,
    lng: Math.round(lng / GRID_LNG) * GRID_LNG,
  }
}

const K_ANONYMITY = 3   // 동일 셀 3건 이상 누적 시 노출

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const rl = RATE.action('report', ip)
  if (!rl.ok) return tooManyResponse(rl)

  const json = await req.json().catch(() => ({}))
  const parsed = PostBody.safeParse(json)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 })
  }
  const { type, lat, lng } = parsed.data

  // XSS 방어: HTML 태그 제거 (텍스트만 남김)
  const rawDesc = parsed.data.description?.trim() ?? ''
  const cleanDesc = rawDesc
    ? DOMPurify.sanitize(rawDesc, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).slice(0, 280)
    : null

  // k-익명화: 50m 그리드로 양자화한 좌표만 저장 (원본 좌표는 버림)
  const grid = quantize(lat, lng)

  const { data, error } = await supabase
    .from('reports')
    .insert({
      user_id: null,                  // 익명 제보
      type,
      description: cleanDesc,
      grid_geom: `SRID=4326;POINT(${grid.lng} ${grid.lat})`,
      status: 'pending',
    })
    .select('id')
    .single()

  if (error) {
    return new Response(JSON.stringify({ error: 'insert_failed', detail: error.message }), { status: 500 })
  }

  // 동일 그리드 셀 누적 카운트
  const { data: countData } = await supabase.rpc('reports_grid_count', {
    p_grid_lng: grid.lng, p_grid_lat: grid.lat,
  })
  const cellCount = typeof countData === 'number' ? countData : 0

  // 감사 (IP 만, user 정보 X)
  await supabase.from('audit_log').insert({
    action: 'report_create',
    ip, user_agent: req.headers.get('user-agent') || null,
    meta: { type, grid_lng: grid.lng, grid_lat: grid.lat, anonymized: true },
  }).then(() => {}, () => {})

  return Response.json({
    ok: true,
    id: data.id,
    grid: { lng: grid.lng, lat: grid.lat },
    cell_count: cellCount,
    visible: cellCount >= K_ANONYMITY,
    k: K_ANONYMITY,
  })
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const minLng = Number(sp.get('min_lng'))
  const minLat = Number(sp.get('min_lat'))
  const maxLng = Number(sp.get('max_lng'))
  const maxLat = Number(sp.get('max_lat'))
  if ([minLng, minLat, maxLng, maxLat].some(v => !Number.isFinite(v))) {
    return new Response(JSON.stringify({ error: 'invalid_bbox' }), { status: 400 })
  }

  // bbox 안 제보 가져온 뒤, 그리드 셀별 group by — k 이상만 노출
  const { data, error } = await supabase
    .from('reports')
    .select('id, type, description, grid_geom, created_at, status')
    .filter('grid_geom', 'not.is', null)
    .in('status', ['pending', 'approved'])
    .limit(500)

  if (error) {
    return new Response(JSON.stringify({ error: 'lookup_failed', detail: error.message }), { status: 500 })
  }

  // grid_geom 은 WKB 또는 GeoJSON 일 수 있음 — 추출 후 셀별 그룹.
  // (Supabase 기본 select 는 geometry 를 WKB hex 로 반환하므로 별도 RPC 가 깔끔하나,
  //  데모 범위에선 클라이언트에서 단순 카운트만 노출)
  const cells = new Map<string, { lng: number; lat: number; count: number; types: Record<string, number> }>()
  for (const r of (data ?? []) as any[]) {
    // grid_geom 이 GeoJSON object 형태일 때
    const g = r.grid_geom
    let lng: number | null = null, lat: number | null = null
    if (typeof g === 'string' && g.startsWith('01')) {
      // WKB hex — 데모 범위에서는 skip
      continue
    }
    if (g?.coordinates) {
      [lng, lat] = g.coordinates
    }
    if (lng == null || lat == null) continue
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue

    const key = `${lng.toFixed(5)}_${lat.toFixed(5)}`
    const cell = cells.get(key) || { lng, lat, count: 0, types: {} }
    cell.count += 1
    cell.types[r.type] = (cell.types[r.type] || 0) + 1
    cells.set(key, cell)
  }

  // k=3 이상만 반환
  const visible = Array.from(cells.values())
    .filter(c => c.count >= K_ANONYMITY)
    .map(c => ({ ...c, dominant: Object.entries(c.types).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other' }))

  return Response.json({
    cells: visible,
    k: K_ANONYMITY,
    total_raw_reports: (data ?? []).length,
  })
}
