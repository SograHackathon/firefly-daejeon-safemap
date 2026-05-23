/**
 * 편의점 데이터 — 카카오 로컬 카테고리 검색 API
 * 카테고리 코드 CS2 = 편의점
 * 대전 5개 자치구 격자로 검색해서 중복 제거 후 적재
 */
import 'dotenv/config'
import { config as loadEnv } from 'dotenv'
import dns from 'dns'
dns.setDefaultResultOrder('ipv4first')
loadEnv({ path: '.env.local' })

import { supabase, log } from './_lib'

const KAKAO = process.env.KAKAO_REST_KEY!
if (!KAKAO) throw new Error('Missing KAKAO_REST_KEY')

const ENDPOINT = 'https://dapi.kakao.com/v2/local/search/category.json'

// 24h 운영 브랜드
const BRANDS_24H = ['GS25', 'CU', '세븐일레븐', '7-Eleven', '7-ELEVEN', '이마트24', '미니스톱']

function is24h(name: string): boolean {
  return BRANDS_24H.some(b => name?.toUpperCase().includes(b.toUpperCase()))
}

function extractBrand(name: string): string {
  for (const b of BRANDS_24H) {
    if (name?.toUpperCase().includes(b.toUpperCase())) return b
  }
  return '기타'
}

function extractDistrict(addr: string): string | null {
  const ds = ['유성구', '서구', '동구', '중구', '대덕구']
  for (const d of ds) if (addr.includes(d)) return d
  return null
}

// 대전 일대를 격자로 쪼개서 카테고리 검색 (한 번에 최대 45건이라 격자 필요)
async function searchGrid(lng: number, lat: number, radiusM: number) {
  const all: any[] = []
  let page = 1
  while (page <= 3) {  // 카카오 최대 3페이지 = 45건
    const url = new URL(ENDPOINT)
    url.searchParams.set('category_group_code', 'CS2')
    url.searchParams.set('x', String(lng))
    url.searchParams.set('y', String(lat))
    url.searchParams.set('radius', String(radiusM))
    url.searchParams.set('sort', 'distance')
    url.searchParams.set('size', '15')
    url.searchParams.set('page', String(page))

    const res = await fetch(url.toString(), {
      headers: { Authorization: `KakaoAK ${KAKAO}` },
    })
    if (!res.ok) {
      console.warn(`grid (${lng},${lat}) page ${page}: ${res.status}`)
      break
    }
    const data = await res.json()
    const docs = data.documents || []
    all.push(...docs)
    if (docs.length < 15 || data.meta?.is_end) break
    page++
  }
  return all
}

async function main() {
  log('🚀 카카오 편의점 적재 시작')
  await supabase.from('cvs').delete().eq('brand', 'kakao_grid')  // 우리 적재한 거만 삭제
  await supabase.from('cvs').delete().not('id', 'is', null)       // 또는 전체 삭제

  // 대전 일대를 1km 격자로 (반경 700m, 약간 겹치게)
  const minLng = 127.30, maxLng = 127.55
  const minLat = 36.25, maxLat = 36.50
  const step = 0.011  // ~1km
  const radius = 700

  const grids: Array<[number, number]> = []
  for (let lat = minLat; lat <= maxLat; lat += step) {
    for (let lng = minLng; lng <= maxLng; lng += step) {
      grids.push([lng, lat])
    }
  }
  log(`총 ${grids.length} 격자 검색`)

  const dedup = new Map<string, any>()
  let processed = 0
  for (const [lng, lat] of grids) {
    const docs = await searchGrid(lng, lat, radius)
    for (const d of docs) {
      if (!dedup.has(d.id)) dedup.set(d.id, d)
    }
    processed++
    if (processed % 20 === 0) log(`  ${processed}/${grids.length} · 누적 ${dedup.size}개`)
    // rate 보호 (카카오 시간당 1만건)
    await new Promise(r => setTimeout(r, 80))
  }

  log(`고유 편의점: ${dedup.size}개`)

  // DB 적재
  const rows: any[] = []
  for (const d of dedup.values()) {
    const lng = parseFloat(d.x)
    const lat = parseFloat(d.y)
    if (!lng || !lat) continue
    const addr = d.road_address_name || d.address_name || ''
    rows.push({
      brand: extractBrand(d.place_name),
      name: d.place_name,
      address: addr,
      district: extractDistrict(addr),
      is_24h: is24h(d.place_name),
      lng, lat,
      raw: d,
    })
  }

  log(`적재 시작: ${rows.length}건`)

  // PostGIS POINT WKT 로 변환해서 insert
  const payload = rows.map(({ lng, lat, ...rest }) => ({
    ...rest,
    geom: `SRID=4326;POINT(${lng} ${lat})`,
  }))

  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK)
    const { error, count } = await supabase.from('cvs').insert(slice, { count: 'exact' })
    if (error) { console.error(error.message); break }
    inserted += count || slice.length
    process.stdout.write(`  ${inserted}/${payload.length}\r`)
  }
  log(`\n✅ ${inserted}건 적재 완료 (24h: ${rows.filter(r => r.is_24h).length}개)`)
}

main().catch(e => { console.error('❌', e); process.exit(1) })
