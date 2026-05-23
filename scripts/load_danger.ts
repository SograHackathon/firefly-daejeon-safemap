/**
 * KOROAD 보행자 교통사고 다발지역 (대전 5개구)
 * Endpoint: https://opendata.koroad.or.kr/data/rest/frequentzone/pedstrians
 *
 * authKey 는 KOROAD 별도 발급. 일단 공공데이터 키로 시도하고,
 * 안 되면 KOROAD_AUTH_KEY 환경변수 폴백.
 */
import 'dotenv/config'
import { supabase, log, PUBLIC_DATA_KEY } from './_lib'

const ENDPOINT = 'https://opendata.koroad.or.kr/data/rest/frequentzone/pedstrians'
const KOROAD_KEY = process.env.KOROAD_AUTH_KEY || PUBLIC_DATA_KEY

// 대전 5개 구 코드
const GU_CODES: Array<{ name: string; siDo: string; guGun: string }> = [
  { name: '유성구', siDo: '30', guGun: '200' },
  { name: '서구',   siDo: '30', guGun: '170' },
  { name: '동구',   siDo: '30', guGun: '110' },
  { name: '중구',   siDo: '30', guGun: '140' },
  { name: '대덕구', siDo: '30', guGun: '230' },
]

const SEARCH_YEARS = [2023, 2022, 2021]

async function fetchByGu(year: number, gu: typeof GU_CODES[0]) {
  const url = new URL(ENDPOINT)
  url.searchParams.set('authKey', KOROAD_KEY)
  url.searchParams.set('searchYearCd', String(year))
  url.searchParams.set('siDo', gu.siDo)
  url.searchParams.set('guGun', gu.guGun)
  url.searchParams.set('type', 'json')
  url.searchParams.set('numOfRows', '100')
  url.searchParams.set('pageNo', '1')

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    const txt = await res.text()
    console.warn(`[${gu.name} ${year}] HTTP ${res.status}: ${txt.slice(0, 150)}`)
    return []
  }
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch {
    console.warn(`[${gu.name} ${year}] JSON parse 실패: ${text.slice(0, 150)}`)
    return []
  }
  return json?.items?.item ?? json?.items ?? []
}

async function main() {
  log('🚀 KOROAD 보행자 사고다발지역 적재')
  await supabase.from('danger_zones').delete().neq('id', 0)

  const all: any[] = []

  for (const year of SEARCH_YEARS) {
    for (const gu of GU_CODES) {
      const items = await fetchByGu(year, gu)
      log(`  ${year} ${gu.name}: ${items.length}건`)

      for (const it of items) {
        const lat = parseFloat(it.la_crd ?? it.LATITUDE ?? '0')
        const lng = parseFloat(it.lo_crd ?? it.LONGITUDE ?? '0')
        if (!lat || !lng) continue

        // 폴리곤이 있으면 사용, 없으면 점에서 100m 버퍼 생성용 placeholder
        const polygonGeoJson = it.geom_json ? it.geom_json : null

        all.push({
          source_id: String(it.spot_no ?? it.bjd_cd ?? ''),
          district: gu.name,
          // 시간대 컬럼은 API 가 안 줘서 0으로 시작 → 사상자 기반으로 가중치 부여
          acc_total: parseInt(it.occrrnc_cnt ?? '0', 10),
          casualty: parseInt(it.caslt_cnt ?? '0', 10),
          death: parseInt(it.dth_dnv_cnt ?? '0', 10),
          injury: parseInt(it.se_dnv_cnt ?? '0', 10),
          year_from: year, year_to: year,
          _lng: lng, _lat: lat,
          _polygon: polygonGeoJson,
          raw: it,
        })
      }

      await new Promise(r => setTimeout(r, 300))
    }
  }

  log(`수집 완료: ${all.length}건. PostGIS 폴리곤 변환 중...`)

  // 폴리곤 또는 점→버퍼로 적재
  let inserted = 0
  const CHUNK = 100
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK)
    const payload = chunk.map(({ _lng, _lat, _polygon, ...rest }) => {
      let geom: string
      if (_polygon) {
        // GeoJSON 으로 들어왔으면 WKT 로 변환 시도
        try {
          const gj = typeof _polygon === 'string' ? JSON.parse(_polygon) : _polygon
          if (gj.type === 'Polygon') {
            const coords = gj.coordinates[0].map((c: number[]) => `${c[0]} ${c[1]}`).join(',')
            geom = `SRID=4326;POLYGON((${coords}))`
          } else {
            // fallback to point buffer
            geom = pointBuffer(_lng, _lat)
          }
        } catch {
          geom = pointBuffer(_lng, _lat)
        }
      } else {
        geom = pointBuffer(_lng, _lat)
      }
      return { ...rest, geom }
    })

    const { error, count } = await supabase
      .from('danger_zones')
      .insert(payload, { count: 'exact' })
    if (error) {
      console.error('insert error:', error.message)
      break
    }
    inserted += count || chunk.length
    process.stdout.write(`  ${inserted}/${all.length}\r`)
  }

  console.log(`\n✅ ${inserted}건 적재 완료`)
}

/**
 * 점 좌표에서 약 100m 사각 폴리곤 (PostGIS ST_Buffer 같은 거 필요 없이 근사)
 * 1도 ≈ 111km → 100m ≈ 0.0009도
 */
function pointBuffer(lng: number, lat: number): string {
  const d = 0.0009
  return `SRID=4326;POLYGON((${lng - d} ${lat - d},${lng + d} ${lat - d},${lng + d} ${lat + d},${lng - d} ${lat + d},${lng - d} ${lat - d}))`
}

main().catch((e) => { console.error('❌', e); process.exit(1) })
