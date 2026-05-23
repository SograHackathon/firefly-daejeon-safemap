/**
 * 전국보안등정보표준데이터 → 대전만 필터링 적재
 * 데이터셋 ID: 15017320
 * Endpoint: api.data.go.kr/openapi/tn_pubr_public_scrty_lmp_api
 * 전국 1,828,375건 중 institutionNm 또는 주소에 "대전" 포함되는 것만
 */
import { fetchPublicApi, insertPoints, log, supabase } from './_lib'

const ENDPOINT = 'https://api.data.go.kr/openapi/tn_pubr_public_scrty_lmp_api'
const PAGE_SIZE = 1000

async function fetchPage(pageNo: number, retry = 3): Promise<{ items: any[]; total: number }> {
  let lastErr: any
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetchPublicApi(ENDPOINT, { pageNo, numOfRows: PAGE_SIZE, type: 'json' })
      const text = await res.text()
      const json = JSON.parse(text)
      const items = json?.response?.body?.items ?? []
      const total = parseInt(json?.response?.body?.totalCount ?? '0', 10)
      const arr = Array.isArray(items) ? items : items.item ? (Array.isArray(items.item) ? items.item : [items.item]) : []
      return { items: arr, total }
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw lastErr
}

function isDaejeon(it: any): boolean {
  const inst = (it.institutionNm ?? it.insttNm ?? '') as string
  const addr = (it.rdnmadr ?? it.lnmadr ?? '') as string
  return inst.includes('대전') || addr.includes('대전')
}

function extractDistrict(addr: string): string | null {
  for (const d of ['유성구', '서구', '동구', '중구', '대덕구']) if (addr.includes(d)) return d
  return null
}

async function main() {
  log('🚀 전국 보안등 → 대전 필터 적재 시작')
  await supabase.from('lights').delete().not('id', 'is', null)

  const first = await fetchPage(1)
  log(`전국 ${first.total.toLocaleString()}건, 페이지 ${Math.ceil(first.total / PAGE_SIZE)}개`)

  const all: any[] = []
  const totalPages = Math.ceil(first.total / PAGE_SIZE)
  const t0 = Date.now()

  for (let p = 1; p <= totalPages; p++) {
    const page = p === 1 ? first : await fetchPage(p)
    let daejeon = 0
    for (const it of page.items) {
      if (!isDaejeon(it)) continue
      const lat = parseFloat(it.latitude ?? '0')
      const lng = parseFloat(it.longitude ?? '0')
      if (!lat || !lng || lat < 33 || lat > 39 || lng < 124 || lng > 132) continue
      const addr = (it.rdnmadr ?? it.lnmadr ?? '') as string
      all.push({
        source: 'public_lights',
        source_id: String(it.lmpLcNm ?? ''),
        address: addr,
        district: extractDistrict(addr) ?? extractDistrict(it.insttNm ?? ''),
        lng, lat,
        raw: it,
      })
      daejeon++
    }
    if (p % 20 === 0 || p === totalPages) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
      const eta = totalPages > p ? Math.round((Date.now() - t0) / p * (totalPages - p) / 1000) : 0
      log(`  page ${p}/${totalPages} · 대전 누적 ${all.length}건 · 경과 ${elapsed}s · ETA ${eta}s`)
    }
  }

  log(`대전 보안등 필터링 완료: ${all.length}건. 적재 시작...`)
  await insertPoints('lights', all)
  log('✅ 완료')
}

main().catch(e => { console.error('❌', e); process.exit(1) })
