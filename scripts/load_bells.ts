/**
 * 행정안전부 안전비상벨위치정보 (대전만)
 * Endpoint: https://apis.data.go.kr/1741000/emergency_call_box_info/info
 */
import { autoToWgs84, fetchPublicApi, insertPoints, log, supabase } from './_lib'

const ENDPOINT = 'https://apis.data.go.kr/1741000/emergency_call_box_info/info'

async function fetchPage(pageNo: number, numOfRows = 100) {
  const params: Record<string, string | number> = {
    pageNo,
    numOfRows,
    returnType: 'json',
    'cond[LCTN_ROAD_NM_ADDR::LIKE]': '대전',
  }
  const res = await fetchPublicApi(ENDPOINT, params)
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch {
    throw new Error('JSON parse 실패. ' + text.slice(0, 200))
  }
  const items = json?.response?.body?.items?.item ?? json?.body?.items?.item ?? []
  const total = parseInt(json?.response?.body?.totalCount ?? '0', 10)
  const arr = Array.isArray(items) ? items : items ? [items] : []
  return { items: arr, total }
}

async function main() {
  log('🚀 대전 안전비상벨 적재')
  await supabase.from('bells').delete().eq('source', 'mois_safety_bell')

  const first = await fetchPage(1, 100)
  log(`총 ${first.total}건 (대전 필터됨)`)
  if (first.items.length > 0) {
    log('샘플:', JSON.stringify(first.items[0]).slice(0, 400))
  }

  const all: any[] = []
  const pages = Math.ceil(first.total / 100)

  for (let p = 1; p <= pages; p++) {
    const page = p === 1 ? first : await fetchPage(p, 100)
    if (p % 5 === 0) log(`  ${p}/${pages}`)

    for (const it of page.items) {
      // 좌표 필드: WGS84_LAT / WGS84_LOT (이미 WGS84)
      const lat = parseFloat(it.WGS84_LAT ?? it.LAT_CRDNT ?? '0')
      const lng = parseFloat(it.WGS84_LOT ?? it.LOT_CRDNT ?? '0')
      if (!lat || !lng) continue
      if (lat < 33 || lat > 39 || lng < 124 || lng > 132) continue

      all.push(makeRow(it, lng, lat))
    }

    if (p % 5 === 0) await new Promise(r => setTimeout(r, 300))
  }

  log(`변환 완료: ${all.length}건`)
  await insertPoints('bells', all)
  log('✅ 완료')
}

function makeRow(it: any, lng: number, lat: number) {
  const addr = it.LCTN_ROAD_NM_ADDR ?? it.LCTN_LOTNO_ADDR ?? ''
  return {
    source: 'mois_safety_bell',
    source_id: String(it.SFTY_EMRGNCBLL_MNG_NO ?? it.MNG_NO ?? ''),
    name: it.INSTL_PRPS ?? null,
    address: addr,
    district: extractDistrict(addr),
    lng, lat,
    raw: it,
  }
}

function extractDistrict(addr: string): string | null {
  const ds = ['유성구', '서구', '동구', '중구', '대덕구']
  for (const d of ds) if (addr.includes(d)) return d
  return null
}

main().catch((e) => { console.error('❌', e); process.exit(1) })
