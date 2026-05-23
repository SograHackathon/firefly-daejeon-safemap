'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export type Place = {
  id: string
  name: string
  address: string
  category: string
  lng: number
  lat: number
}

export type RouteKey = string

export type RouteResult = {
  candidates: Array<{
    key: RouteKey
    label: string
    route: {
      geometry: { type: 'LineString'; coordinates: [number, number][] }
      distance_m: number
      duration_s: number
    }
    score: {
      score: number
      is_night: boolean
      counts: { cctv: number; lights: number; bells: number; cvs: number; danger_zones: number; casualties: number }
      length_m: number
    } | null
    recommended?: boolean
  }>
  is_night: boolean
  hour: number | null
}

// 내 위치 사용을 표현하는 특수 place
const ME_PLACE_ID = '__me__'
const makeMePlace = (lng: number, lat: number, name = '현 위치', address = ''): Place => ({
  id: ME_PLACE_ID, name, address, category: '내 위치', lng, lat,
})

type Props = {
  userLng: number
  userLat: number
  selectedPlace: Place | null
  onSelectPlace: (p: Place | null) => void
  start: Place | null
  end: Place | null
  onSetStart: (p: Place | null) => void
  onSetEnd: (p: Place | null) => void
  routeResult: RouteResult | null
  onRouteResult: (r: RouteResult | null) => void
  selectedCandidate: string | null
  onSelectCandidate: (k: string) => void
  onStartGuide?: (candidateKey: string) => void
  onStopGuide?: () => void
  guideActive?: boolean
}

const CARD_COLORS = [
  { stroke: '#16a34a', border: 'border-green-500',  text: 'text-green-600',  bg: 'rgba(22,163,74,0.08)' },
  { stroke: '#2d7eff', border: 'border-blue-500',   text: 'text-blue-600',   bg: 'rgba(45,126,255,0.06)' },
  { stroke: '#f59e0b', border: 'border-amber-500',  text: 'text-amber-600',  bg: 'rgba(245,158,11,0.06)' },
  { stroke: '#a855f7', border: 'border-purple-500', text: 'text-purple-600', bg: 'rgba(168,85,247,0.06)' },
  { stroke: '#6b7280', border: 'border-gray-400',   text: 'text-gray-600',   bg: 'rgba(107,114,128,0.06)' },
]

const CATEGORY_EMOJI: Record<string, string> = {
  '음식점': '🍽', '카페': '☕', '편의점': '🏪', '학교': '🏫', '대학': '🎓',
  '병원': '🏥', '약국': '💊', '주차장': '🅿', '문화시설': '🎭', '관광명소': '📷',
  '숙박': '🛏', '지하철역': '🚇', '공공기관': '🏛', '은행': '🏦', '주유,충전소': '⛽',
}
function categoryEmoji(cat?: string) {
  if (!cat) return '📍'
  for (const [k, em] of Object.entries(CATEGORY_EMOJI)) if (cat.includes(k)) return em
  return '📍'
}

// route 모드 하단 시트 — 사용자가 끈 만큼 그대로 고정 (snap 없음)
const SHEET_MIN_VH = 8       // 핸들만 빼꼼
const SHEET_MAX_VH = 92      // 거의 풀스크린
const SHEET_DEFAULT_VH = 50  // 초기값

export default function SearchPanel(props: Props) {
  const {
    userLng, userLat,
    selectedPlace, onSelectPlace,
    start, end, onSetStart, onSetEnd,
    routeResult, onRouteResult,
    selectedCandidate, onSelectCandidate,
    onStartGuide, onStopGuide, guideActive,
  } = props

  // route 시트 — 드래그한 위치 그대로 고정 (snap 없음, min/max 클램프만)
  const [sheetHeightVh, setSheetHeightVh] = useState<number>(SHEET_DEFAULT_VH)
  const dragRef = useRef<{ startY: number; startVh: number; vh: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const onSheetPointerDown = useCallback((e: React.PointerEvent) => {
    const vh = window.innerHeight
    dragRef.current = { startY: e.clientY, startVh: sheetHeightVh, vh }
    setIsDragging(true)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [sheetHeightVh])
  const onSheetPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const { startY, startVh, vh } = dragRef.current
    // 위로 끌면 (clientY 감소) 시트 높이 증가, 아래로 끌면 감소
    const deltaPx = e.clientY - startY
    const deltaVh = (deltaPx / vh) * 100
    const next = Math.min(SHEET_MAX_VH, Math.max(SHEET_MIN_VH, startVh - deltaVh))
    setSheetHeightVh(next)
  }, [])
  const onSheetPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    setIsDragging(false)
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
  }, [])

  // 검색 입력 상태 (아래에서 정의되지만 mode 계산에 사용하므로 위로 forward-ref 대신 inline 체크)
  // ↓ editingField 는 아래 state. 여기선 selectedPlace 우선순위만 끌어올림.

  // 화면 모드
  // 'search'    = 검색바 (디폴트)
  // 'placeCard' = 장소 클릭(검색결과/지도 POI/우리 마커) → 핀+카드+출발/도착 버튼  ★ 우선
  // 'directions'= 길찾기 모드 (출/도착 양쪽 입력 패널)
  // 'route'     = 경로 후보 표시
  const mode: 'search' | 'placeCard' | 'directions' | 'route' =
    routeResult ? 'route'
    : selectedPlace ? 'placeCard'                     // ★ 장소 클릭은 항상 카드 우선
    : (start && end) ? 'directions'
    : (start || end) ? 'directions'
    : 'search'

  // ============ 현 위치 주소 (reverse geocode) ============
  const [myAddress, setMyAddress] = useState<{ short: string; address: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/reverse-geocode?lng=${userLng}&lat=${userLat}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled || !d) return
        if (d.short || d.address) setMyAddress({ short: d.short ?? '내 위치', address: d.address ?? '' })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [userLng, userLat])

  // 현 위치 라벨 (메모이즈된 myAddress 활용)
  const myPlaceLabel = myAddress?.short ?? '내 위치'

  // ============ 검색 상태 ============
  // editingField: null = 일반 검색, 'start' = 길찾기 모드에서 출발지 검색, 'end' = 도착지 검색
  const [editingField, setEditingField] = useState<null | 'start' | 'end'>(null)
  const [q, setQ] = useState('')
  const [places, setPlaces] = useState<Place[]>([])
  const [showList, setShowList] = useState(false)
  const [searching, setSearching] = useState(false)

  const [routing, setRouting] = useState(false)
  const [routeError, setRouteError] = useState<string | null>(null)

  // ============ 검색 debounce ============
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current)
    if (!q.trim()) { setPlaces([]); setShowList(false); return }
    tRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&lng=${userLng}&lat=${userLat}`)
        if (!res.ok) { setPlaces([]); return }
        const { places } = await res.json()
        setPlaces(places || [])
        setShowList(true)
      } catch {}
      finally { setSearching(false) }
    }, 250)
  }, [q, userLng, userLat])

  // ============ 라우팅 ============
  const runRouting = useCallback(async (s: Place, e: Place) => {
    setRouting(true)
    setRouteError(null)
    try {
      const res = await fetch('/api/route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: { lng: s.lng, lat: s.lat },
          end: { lng: e.lng, lat: e.lat },
        }),
      })
      if (!res.ok) { setRouteError(`경로 계산 실패 (${res.status})`); return }
      const data: RouteResult = await res.json()
      onRouteResult(data)
      const rec = data.candidates.find(c => c.recommended) || data.candidates[0]
      if (rec) onSelectCandidate(rec.key)
    } catch (e: any) { setRouteError(e.message) }
    finally { setRouting(false) }
  }, [onRouteResult, onSelectCandidate])

  // 양쪽 정해지면 자동 라우팅 트리거
  useEffect(() => {
    if (start && end && !routeResult && !routing) {
      runRouting(start, end)
    }
  }, [start, end, routeResult, routing, runRouting])

  // ============ 검색 결과 클릭 처리 ============
  const pickPlace = useCallback((p: Place) => {
    setQ('')
    setPlaces([])
    setShowList(false)

    if (editingField === 'start') {
      onSetStart(p)
      setEditingField(null)
    } else if (editingField === 'end') {
      onSetEnd(p)
      setEditingField(null)
    } else {
      // 일반 검색 → 장소 카드 모드
      onSelectPlace(p)
    }
  }, [editingField, onSetStart, onSetEnd, onSelectPlace])

  // ============ 장소 카드 액션 ============
  const setPlaceAsEnd = useCallback(() => {
    if (!selectedPlace) return
    onSetEnd(selectedPlace)
    onSelectPlace(null)
    // 출발지 비어있으면 현 위치 (주소 포함) 자동 채움
    if (!start) onSetStart(makeMePlace(userLng, userLat, myPlaceLabel, myAddress?.address ?? ''))
  }, [selectedPlace, start, userLng, userLat, myPlaceLabel, myAddress, onSelectPlace, onSetEnd, onSetStart])

  const setPlaceAsStart = useCallback(() => {
    if (!selectedPlace) return
    onSetStart(selectedPlace)
    onSelectPlace(null)
  }, [selectedPlace, onSelectPlace, onSetStart])

  // ============ 길찾기 모드 액션 ============
  const swap = useCallback(() => {
    const a = start, b = end
    onSetStart(b)
    onSetEnd(a)
    onRouteResult(null)
  }, [start, end, onSetStart, onSetEnd, onRouteResult])

  const useMyLocationAsStart = useCallback(() => {
    onSetStart(makeMePlace(userLng, userLat, myPlaceLabel, myAddress?.address ?? ''))
  }, [userLng, userLat, myPlaceLabel, myAddress, onSetStart])

  const clearAll = useCallback(() => {
    onRouteResult(null)
    onSetStart(null)
    onSetEnd(null)
    onSelectPlace(null)
    setEditingField(null)
    setQ('')
    setRouteError(null)
  }, [onRouteResult, onSetStart, onSetEnd, onSelectPlace])

  // ============ 렌더 ============

  // 검색 결과 리스트 (재사용)
  const renderResultList = () => {
    if (!showList || places.length === 0) return null
    return (
      <div className="absolute top-[160px] left-3 right-3 z-30 bg-white rounded-2xl shadow-xl max-h-[50vh] overflow-y-auto">
        {places.map(p => (
          <button
            key={p.id}
            onClick={() => pickPlace(p)}
            className="w-full text-left px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 active:bg-gray-100 flex items-start gap-3"
          >
            <span className="text-lg mt-0.5">{categoryEmoji(p.category)}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 truncate">{p.name}</div>
              <div className="text-[11px] text-gray-500 truncate mt-0.5">
                {p.category && <span className="mr-1.5 text-gray-400">{p.category}</span>}
                {p.address}
              </div>
            </div>
          </button>
        ))}
      </div>
    )
  }

  return (
    <>
      {/* ===== MODE: search ===== */}
      {mode === 'search' && (
        <>
          <div className="absolute top-3 left-3 right-3 z-30 bg-white rounded-2xl px-4 py-3 shadow-lg flex items-center gap-3">
            <span className="text-gray-400 text-base">🔍</span>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="장소 · 주소 · 도착지 검색"
              className="flex-1 bg-transparent outline-none text-sm placeholder-gray-400 text-gray-800 min-w-0"
            />
            {searching && <span className="text-xs text-gray-400">…</span>}
            {q && (
              <button onClick={() => setQ('')} className="text-gray-400 text-lg px-1">×</button>
            )}
          </div>
          {/* 검색 결과 — 검색바 바로 아래 */}
          {showList && places.length > 0 && (
            <div className="absolute top-[68px] left-3 right-3 z-30 bg-white rounded-2xl shadow-xl max-h-[60vh] overflow-y-auto">
              {places.map(p => (
                <button
                  key={p.id}
                  onClick={() => pickPlace(p)}
                  className="w-full text-left px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 active:bg-gray-100 flex items-start gap-3"
                >
                  <span className="text-lg mt-0.5">{categoryEmoji(p.category)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 truncate">{p.name}</div>
                    <div className="text-[11px] text-gray-500 truncate mt-0.5">
                      {p.category && <span className="mr-1.5 text-gray-400">{p.category}</span>}
                      {p.address}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* ===== MODE: placeCard ===== */}
      {mode === 'placeCard' && selectedPlace && (
        <div className="absolute bottom-0 left-0 right-0 z-30 bg-white rounded-t-3xl shadow-2xl" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>
          <div className="px-4 pt-3">
            <div className="w-9 h-1 bg-gray-300 rounded-full mx-auto mb-3" />
            <div className="flex items-start gap-3 mb-3">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-100 to-pink-100 flex items-center justify-center text-2xl flex-shrink-0">
                {categoryEmoji(selectedPlace.category)}
              </div>
              <div className="flex-1 min-w-0 pt-1">
                <div className="text-lg font-extrabold text-gray-900 truncate">{selectedPlace.name}</div>
                {selectedPlace.category && (
                  <div className="text-[11px] text-gray-500 mt-0.5">{selectedPlace.category}</div>
                )}
              </div>
              <button onClick={() => onSelectPlace(null)} className="text-gray-400 text-xl p-1 -mt-1">×</button>
            </div>
            <div className="bg-gray-50 rounded-xl px-3 py-2.5 mb-3 flex items-start gap-2">
              <span className="text-xs mt-0.5">📍</span>
              <span className="text-xs text-gray-700 leading-relaxed">{selectedPlace.address || '주소 정보 없음'}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 pb-3">
              <button onClick={setPlaceAsStart} className="py-3 rounded-xl bg-white border border-gray-200 text-sm font-bold text-gray-700 active:bg-gray-50 flex items-center justify-center gap-1.5">
                <span>🚶</span> 출발
              </button>
              <button onClick={setPlaceAsEnd} className="py-3 rounded-xl bg-gray-900 text-white text-sm font-bold active:bg-gray-700 flex items-center justify-center gap-1.5">
                <span>🎯</span> 도착
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== MODE: directions (길찾기 입력 패널) ===== */}
      {mode === 'directions' && (
        <>
          {/* 상단 패널: 출/도착 입력 — 두 줄 다 항상 input */}
          <div className="absolute top-3 left-3 right-3 z-30 bg-white rounded-2xl shadow-lg">
            <div className="flex items-start">
              <button onClick={clearAll} title="닫기" className="text-gray-400 text-xl p-3 flex-shrink-0">◀</button>
              {/* 입력 필드 영역 */}
              <div className="flex-1 min-w-0 py-1">
                {/* 출발지 */}
                <div className={`flex items-center gap-2 px-2 py-2.5 rounded-lg ${editingField === 'start' ? 'bg-blue-50' : ''}`}>
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0"></span>
                  <span className="text-[11px] text-gray-400 font-bold flex-shrink-0">출발지</span>
                  <input
                    type="text"
                    value={editingField === 'start' ? q : (start?.name ?? '')}
                    onFocus={() => { setEditingField('start'); setQ(''); setPlaces([]); setShowList(false); }}
                    onChange={e => { setEditingField('start'); setQ(e.target.value); }}
                    placeholder={start ? '' : (myPlaceLabel ? myPlaceLabel : '입력')}
                    className={`flex-1 bg-transparent outline-none text-sm min-w-0 ${start?.id === ME_PLACE_ID ? 'text-blue-600 font-bold' : 'text-gray-900 font-semibold placeholder-gray-400'}`}
                  />
                  {start && (
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { onSetStart(null); onRouteResult(null); setEditingField(null); setQ('') }}
                      className="text-gray-300 text-lg px-1 flex-shrink-0"
                    >×</button>
                  )}
                </div>
                {/* 구분선 */}
                <div className="border-t border-gray-100 mx-2" />
                {/* 도착지 */}
                <div className={`flex items-center gap-2 px-2 py-2.5 rounded-lg ${editingField === 'end' ? 'bg-red-50' : ''}`}>
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0"></span>
                  <span className="text-[11px] text-gray-400 font-bold flex-shrink-0">도착지</span>
                  <input
                    type="text"
                    value={editingField === 'end' ? q : (end?.name ?? '')}
                    onFocus={() => { setEditingField('end'); setQ(''); setPlaces([]); setShowList(false); }}
                    onChange={e => { setEditingField('end'); setQ(e.target.value); }}
                    placeholder="입력"
                    className="flex-1 bg-transparent outline-none text-sm min-w-0 text-gray-900 font-semibold placeholder-gray-400"
                  />
                  {end && (
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { onSetEnd(null); onRouteResult(null); setEditingField(null); setQ('') }}
                      className="text-gray-300 text-lg px-1 flex-shrink-0"
                    >×</button>
                  )}
                </div>
              </div>
              {/* 우측: swap 버튼 */}
              <button
                onClick={swap}
                title="출발/도착 바꾸기"
                className="w-10 h-10 my-2 mr-2 rounded-full bg-gray-100 text-gray-600 text-base flex items-center justify-center active:bg-gray-200 flex-shrink-0"
              >⇅</button>
            </div>
            {/* 현 위치를 출발지로 빠른 액션 (출발지 없을 때만) */}
            {!start && (
              <button onClick={useMyLocationAsStart} className="w-full px-4 py-2.5 text-xs text-blue-600 font-bold border-t border-gray-100 active:bg-blue-50 flex items-center justify-center gap-1.5">
                <span>◎</span> 현 위치 ({myPlaceLabel}) 를 출발지로
              </button>
            )}
          </div>

          {/* 검색 결과 (editingField 인 동안) */}
          {editingField && showList && places.length > 0 && (
            <div className="absolute top-[170px] left-3 right-3 z-30 bg-white rounded-2xl shadow-xl max-h-[55vh] overflow-y-auto">
              {places.map(p => (
                <button
                  key={p.id}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => pickPlace(p)}
                  className="w-full text-left px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 active:bg-gray-100 flex items-start gap-3"
                >
                  <span className="text-lg mt-0.5">{categoryEmoji(p.category)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 truncate">{p.name}</div>
                    <div className="text-[11px] text-gray-500 truncate mt-0.5">
                      {p.category && <span className="mr-1.5 text-gray-400">{p.category}</span>}
                      {p.address}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* 로딩 / 안내 */}
          {!routing && (!start || !end) && (
            <div className="absolute bottom-8 left-3 right-3 z-20 text-center text-xs text-gray-500 bg-white/95 rounded-xl py-3 shadow">
              {!start ? '출발지를 입력해주세요' : '도착지를 입력해주세요'}
            </div>
          )}
          {routing && (
            <div className="absolute bottom-8 left-3 right-3 z-20 text-center text-sm text-gray-600 bg-white/95 rounded-xl py-4 shadow">
              <div className="animate-pulse mb-1 text-xl">🛰</div>
              경로 계산 중…
            </div>
          )}
        </>
      )}

      {/* ===== MODE: route (경로 후보) ===== */}
      {mode === 'route' && (
        <>
          {/* 상단 출/도착 두 줄 — 클릭으로 바로 편집 (수정 버튼 X) */}
          <div className="absolute top-3 left-3 right-3 z-30 bg-white rounded-2xl shadow-lg">
            <div className="flex items-start">
              <button onClick={clearAll} className="text-gray-400 text-xl p-3 flex-shrink-0">◀</button>
              <div className="flex-1 min-w-0 py-1">
                <button
                  onClick={() => { onRouteResult(null); setEditingField('start'); setQ(start?.name ?? ''); setPlaces([]); }}
                  className="group w-full flex items-center gap-2 px-2 py-2.5 text-left hover:bg-gray-50 active:bg-gray-100 rounded-lg transition-colors"
                  title="출발지 수정"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0"></span>
                  <span className="text-[11px] text-gray-400 font-bold flex-shrink-0">출발지</span>
                  <span className={`flex-1 text-sm truncate ${start?.id === ME_PLACE_ID ? 'text-blue-600 font-bold' : 'text-gray-900 font-semibold'}`}>
                    {start?.name ?? myPlaceLabel}
                  </span>
                  <span className="text-gray-300 text-xs group-hover:text-gray-500 flex-shrink-0">✎</span>
                </button>
                <div className="border-t border-gray-100 mx-2" />
                <button
                  onClick={() => { onRouteResult(null); setEditingField('end'); setQ(end?.name ?? ''); setPlaces([]); }}
                  className="group w-full flex items-center gap-2 px-2 py-2.5 text-left hover:bg-gray-50 active:bg-gray-100 rounded-lg transition-colors"
                  title="도착지 수정"
                >
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0"></span>
                  <span className="text-[11px] text-gray-400 font-bold flex-shrink-0">도착지</span>
                  <span className="flex-1 text-sm truncate text-gray-900 font-semibold">{end?.name ?? '-'}</span>
                  <span className="text-gray-300 text-xs group-hover:text-gray-500 flex-shrink-0">✎</span>
                </button>
              </div>
              <button
                onClick={swap}
                title="출발/도착 바꾸기"
                className="w-10 h-10 my-2 mr-2 rounded-full bg-gray-100 text-gray-600 text-base flex items-center justify-center active:bg-gray-200 flex-shrink-0"
              >⇅</button>
            </div>
          </div>

          {/* 경로 카드 — 자유 위치 드래그 시트 (놓은 곳 그대로 고정) */}
          <div
            className="absolute bottom-0 left-0 right-0 z-30 bg-white rounded-t-3xl shadow-2xl flex flex-col"
            style={{
              height: `${sheetHeightVh}vh`,
              transition: isDragging ? 'none' : 'height 0.18s ease-out',
            }}
          >
            {/* 드래그 핸들 — 끌면 그 자리에 그대로 고정 */}
            <div
              onPointerDown={onSheetPointerDown}
              onPointerMove={onSheetPointerMove}
              onPointerUp={onSheetPointerUp}
              onPointerCancel={onSheetPointerUp}
              className="w-full pt-3 pb-2 flex justify-center cursor-grab active:cursor-grabbing touch-none select-none"
              role="button"
              aria-label="시트 크기 조정"
            >
              <div className={`h-1.5 rounded-full transition-all ${isDragging ? 'w-16 bg-gray-500' : 'w-12 bg-gray-300'}`} />
            </div>

            <div className="px-4 pb-5 overflow-y-auto flex-1" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>
            {routeError && (
              <div className="text-center py-4 text-sm text-red-500 bg-red-50 rounded-xl">{routeError}</div>
            )}

            {routeResult && (
              <>
                <div className="text-[11px] text-gray-500 mb-2">
                  {routeResult.is_night && '🌙 야간 모드 적용 · '}
                  도보 경로 <b className="text-gray-700">{routeResult.candidates.length}</b>개 추천
                </div>

                <div className="grid grid-cols-1 gap-2">
                  {routeResult.candidates.map((c, i) => {
                    const isSelected = selectedCandidate === c.key
                    const color = CARD_COLORS[i] ?? CARD_COLORS[2]
                    return (
                      <button
                        key={c.key}
                        onClick={() => onSelectCandidate(c.key)}
                        className={`text-left rounded-2xl p-3 border-2 transition-all ${isSelected ? color.border : 'border-gray-200 bg-white'}`}
                        style={isSelected ? { background: color.bg } : {}}
                      >
                        <div className="flex justify-between items-baseline mb-1">
                          <div className="text-xs font-bold flex items-center gap-1.5">
                            <span className={color.text}>● {c.label}</span>
                            {c.recommended && (
                              <span className="text-[10px] bg-gray-900 text-white px-1.5 py-0.5 rounded-full">🛡 추천</span>
                            )}
                          </div>
                          {c.score && (
                            <div className={`text-lg font-extrabold ${c.score.score >= 70 ? 'text-green-600' : c.score.score >= 50 ? 'text-amber-600' : 'text-red-500'}`}>
                              {c.score.score}<span className="text-xs text-gray-400 font-semibold">/100</span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-baseline gap-3 mb-1.5">
                          <div className="text-xl font-extrabold text-gray-900">
                            {Math.round(c.route.duration_s / 60)}<span className="text-sm text-gray-500 font-semibold">분</span>
                          </div>
                          <div className="text-xs text-gray-500">
                            {(c.route.distance_m / 1000).toFixed(2)}km
                          </div>
                        </div>
                        {c.score && (
                          <div className="flex gap-3 text-[11px] text-gray-600 flex-wrap">
                            <span>📹 {c.score.counts.cctv}</span>
                            <span>💡 {c.score.counts.lights}</span>
                            <span>🛎 {c.score.counts.bells}</span>
                            <span>🏪 {c.score.counts.cvs}</span>
                            {c.score.counts.danger_zones > 0 && (
                              <span className="text-red-500 font-bold">⚠ 위험 {c.score.counts.danger_zones}</span>
                            )}
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>

                {selectedCandidate && !guideActive && (
                  <button
                    onClick={() => onStartGuide?.(selectedCandidate)}
                    className="w-full mt-3 py-3.5 rounded-2xl font-bold text-sm bg-gray-900 text-white active:bg-gray-700 active:scale-[0.98] transition-transform"
                  >
                    안내 시작
                  </button>
                )}
                {guideActive && (
                  <div className="mt-3 space-y-2">
                    <div className="px-3 py-2.5 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <div className="flex-1 text-xs">
                        <div className="font-bold text-emerald-700">안내 중</div>
                        <div className="text-emerald-600/80 text-[11px]">좌측 하단 “보호자에 공유” 로 동선 공유 가능</div>
                      </div>
                    </div>
                    <button
                      onClick={() => onStopGuide?.()}
                      className="w-full py-3 rounded-2xl font-bold text-sm bg-red-500 text-white active:bg-red-600 active:scale-[0.98] transition-transform"
                    >
                      🛑 안내 종료
                    </button>
                  </div>
                )}
              </>
            )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
