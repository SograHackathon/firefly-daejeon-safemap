/**
 * 보안등 CSV 파일에서 적재
 * Usage: tsx scripts/load_lights_csv.ts <csv_path>
 *        (인자 없으면 ./data/lights.csv 사용)
 */
import { readFileSync, existsSync } from 'fs'
import { parse } from 'csv-parse/sync'
import { insertPoints, log, supabase } from './_lib'

// 여러 파일 지원: tsx scripts/load_lights_csv.ts file1.csv file2.csv ...
const csvPaths = process.argv.slice(2)
if (csvPaths.length === 0) csvPaths.push('./data/lights.csv')

for (const p of csvPaths) {
  if (!existsSync(p)) {
    console.error(`❌ CSV 파일 없음: ${p}`)
    process.exit(1)
  }
}

function extractDistrict(addr: string): string | null {
  for (const d of ['유성구', '서구', '동구', '중구', '대덕구']) if (addr.includes(d)) return d
  return null
}

function isDaejeon(inst: string, addr: string): boolean {
  return (inst || '').includes('대전') || (addr || '').includes('대전')
}

async function parseFile(csvPath: string) {
  let raw = readFileSync(csvPath)
  let text: string
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.toString('utf16le').replace(/^﻿/, '')
  } else if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    text = raw.toString('utf8').replace(/^﻿/, '')
  } else {
    text = raw.toString('utf8')
    if (/[�]/.test(text)) {
      const iconv = await import('iconv-lite').catch(() => null)
      if (iconv) text = iconv.decode(raw, 'euc-kr')
    }
  }
  return parse(text, {
    columns: true, skip_empty_lines: true, trim: true,
    relax_quotes: true, relax_column_count: true,
    bom: true,
  }) as any[]
}

async function main() {
  log(`🚀 보안등 CSV 적재: ${csvPaths.length}개 파일`)

  await supabase.from('lights').delete().not('id', 'is', null)

  const rows: any[] = []
  let totalSkipped = 0

  for (const csvPath of csvPaths) {
    const records = await parseFile(csvPath)
    log(`📂 ${csvPath.split('/').pop()} · ${records.length.toLocaleString()}건`)
    if (records[0] && csvPath === csvPaths[0]) {
      log(`   컬럼: ${Object.keys(records[0]).join(', ')}`)
    }

    let added = 0, skipped = 0
    for (const r of records) {
      const inst = r['관리기관명'] ?? r['institutionNm'] ?? r['insttNm'] ?? ''
      const addr = r['소재지도로명주소'] ?? r['소재지지번주소'] ?? r['도로명주소'] ?? r['지번주소'] ?? r['rdnmadr'] ?? r['lnmadr'] ?? ''
      // 자치구별 파일이라 대전 필터링 사실상 패스 OK 지만 안전하게 한 번 더
      if (!isDaejeon(inst, addr)) { skipped++; continue }

      const lat = parseFloat(r['위도'] ?? r['latitude'] ?? '0')
      const lng = parseFloat(r['경도'] ?? r['longitude'] ?? '0')
      if (!lat || !lng) { skipped++; continue }
      if (lat < 33 || lat > 39 || lng < 124 || lng > 132) { skipped++; continue }

      rows.push({
        source: 'public_lights',
        source_id: String(r['보안등위치명'] ?? r['lmpLcNm'] ?? ''),
        address: addr,
        district: extractDistrict(addr) ?? extractDistrict(inst),
        lng, lat,
        raw: r,
      })
      added++
    }
    log(`   → 적재 대상 ${added}건, 제외 ${skipped}건`)
    totalSkipped += skipped
  }

  log(`📊 5개구 합계: ${rows.length.toLocaleString()}건 (제외 ${totalSkipped})`)
  await insertPoints('lights', rows)
  log('✅ 완료')
}

main().catch(e => { console.error('❌', e); process.exit(1) })
