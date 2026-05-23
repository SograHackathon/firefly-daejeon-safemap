/**
 * 대전광역시 방범 CCTV 적재
 * Endpoint: https://apis.data.go.kr/6300000/openapi2022/safeCCTV/getsafeCCTV
 */
import { autoToWgs84, fetchPublicApi, insertPoints, log, supabase } from './_lib'

const ENDPOINT = 'https://apis.data.go.kr/6300000/openapi2022/safeCCTV/getsafeCCTV'

async function fetchPage(pageNo: number, numOfRows = 1000) {
  const res = await fetchPublicApi(ENDPOINT, { pageNo, numOfRows })
  const text = await res.text()

  // JSON 시도 → 실패 시 XML 알림
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('JSON parse 실패 (XML 응답 가능성). 첫 100자: ' + text.slice(0, 100))
  }

  // response.body.items 또는 body.items
  const items = json?.response?.body?.items ?? json?.body?.items ?? []
  const total = parseInt(json?.response?.body?.totalCount ?? json?.body?.totalCount ?? '0', 10)
  const arr = Array.isArray(items) ? items : items.item ? (Array.isArray(items.item) ? items.item : [items.item]) : []
  return { items: arr, total }
}

async function main() {
  log('🚀 대전 방범 CCTV 적재 시작')

  // 기존 데이터 삭제 (재실행 시)
  log('기존 cctv 데이터 삭제...')
  await supabase.from('cctv').delete().eq('source', 'daejeon_crime')

  // 첫 페이지로 totalCount 확인
  const first = await fetchPage(1, 1000)
  log(`총 ${first.total}건 조회됨, 첫 페이지 ${first.items.length}건`)

  if (first.items.length > 0) {
    log('샘플 row:', JSON.stringify(first.items[0]).slice(0, 300))
  }

  const allRows: any[] = []
  const pages = Math.ceil(first.total / 1000)
  for (let p = 1; p <= pages; p++) {
    const page = p === 1 ? first : await fetchPage(p, 1000)
    log(`  페이지 ${p}/${pages} (${page.items.length}건)`)

    for (const it of page.items) {
      // 좌표 키 변형 흡수: crdntX/crdntY 또는 lat/lot 또는 lng/lat 등
      const x = parseFloat(it.crdntX ?? it.lon ?? it.lng ?? it.x ?? it.lot ?? '0')
      const y = parseFloat(it.crdntY ?? it.lat ?? it.y ?? '0')
      if (!x || !y) continue

      const wgs = autoToWgs84(x, y)
      if (!wgs) {
        console.warn('좌표 변환 실패:', x, y, '| row:', it.rdnmadr || it.lnmAdres)
        continue
      }

      allRows.push({
        source: 'daejeon_crime',
        source_id: String(it.manageNo ?? it.MNG_NO ?? ''),
        purpose: '방범',
        address: it.lnmAdres ?? it.adres ?? null,
        road_address: it.rdnmadr ?? it.roadAddress ?? null,
        district: extractDistrict(it.rdnmadr ?? it.lnmAdres ?? ''),
        lng: wgs.lng,
        lat: wgs.lat,
        raw: it,
      })
    }
  }

  log(`변환 완료: ${allRows.length}건 (실패 ${first.total - allRows.length}건)`)

  // 대전 영역 필터링
  const daejeon = allRows.filter(
    (r) => r.lat >= 36.2 && r.lat <= 36.5 && r.lng >= 127.25 && r.lng <= 127.55
  )
  log(`대전 영역: ${daejeon.length}건`)

  await insertPoints('cctv', daejeon)
  log('✅ 완료')
}

function extractDistrict(addr: string): string | null {
  const districts = ['유성구', '서구', '동구', '중구', '대덕구']
  for (const d of districts) if (addr.includes(d)) return d
  return null
}

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
