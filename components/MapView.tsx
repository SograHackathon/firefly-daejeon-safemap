'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase-browser'
import SearchPanel, { type RouteResult, type Place } from './SearchPanel'

type Layer = 'cctv' | 'lights' | 'bells' | 'cvs' | 'danger'

const DEFAULT_CENTER = { lat: 36.3672, lng: 127.3454 } // 충남대 정문
const DEFAULT_LEVEL = 4

const LAYER_META: Record<Layer, { label: string; color: string; icon: string }> = {
  cctv:   { label: 'CCTV',   color: '#2d7eff', icon: '📹' },
  lights: { label: '가로등', color: '#f59e0b', icon: '💡' },
  bells:  { label: '비상벨', color: '#16a34a', icon: '🛎' },
  cvs:    { label: '편의점', color: '#ff8a00', icon: '🏪' },
  danger: { label: '사고다발', color: '#ef4444', icon: '⚠' },
}

const ALL_LAYERS: Layer[] = ['cctv', 'lights', 'bells', 'cvs', 'danger']

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const overlaysRef = useRef<Record<Layer, any[]>>({
    cctv: [], lights: [], bells: [], cvs: [], danger: []
  })

  const [active, setActive] = useState<Set<Layer>>(new Set(['cctv', 'bells', 'cvs']))
  const [ready, setReady] = useState(false)
  const [counts, setCounts] = useState<Record<Layer, number>>({
    cctv: 0, lights: 0, bells: 0, cvs: 0, danger: 0
  })

  // ===== 사용자 위치 + 안전점수 =====
  const [userPos, setUserPos] = useState<{ lat: number; lng: number }>(DEFAULT_CENTER)
  const [pointSafety, setPointSafety] = useState<{
    score: number
    is_night: boolean
    counts: { cctv: number; lights: number; bells: number; cvs: number }
    radius_m: number
  } | null>(null)
  const SAFETY_RADIUS_M = 50

  // ===== 검색/경로 state =====
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null)  // 검색→클릭, 핀만
  const [startPlace, setStartPlace] = useState<Place | null>(null)         // 출발지
  const [endPlace, setEndPlace] = useState<Place | null>(null)             // 도착지
  const [routeResult, setRouteResult] = useState<RouteResult | null>(null)
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null)
  const routePolylinesRef = useRef<any[]>([])
  const placePinRef = useRef<any>(null)
  const startPinRef = useRef<any>(null)
  const endPinRef = useRef<any>(null)

  // ============ 지도 초기화 ============
  useEffect(() => {
    if (!containerRef.current) return
    const w = window as any
    if (!w.kakao || !w.kakao.maps) {
      console.warn('Kakao SDK not loaded')
      return
    }
    w.kakao.maps.load(() => {
      const map = new w.kakao.maps.Map(containerRef.current, {
        center: new w.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
        level: DEFAULT_LEVEL,
      })
      mapRef.current = map

      // 현 위치 펄스
      const meContent = `<div style="position:relative;width:22px;height:22px;">
        <div style="position:absolute;inset:0;border-radius:50%;background:rgba(45,126,255,0.3);animation:me-ring 2s infinite;"></div>
        <div style="position:absolute;inset:4px;background:#2d7eff;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>
      </div>`
      new w.kakao.maps.CustomOverlay({
        position: new w.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
        content: meContent,
        yAnchor: 0.5,
        xAnchor: 0.5,
        map: map,
      })

      // 지도 이동/줌 끝나면 활성 레이어 다시 로드 (debounce)
      let timer: ReturnType<typeof setTimeout> | null = null
      const debouncedReload = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          activeRef.current.forEach(layer => loadLayerRef.current(layer))
        }, 400)
      }
      w.kakao.maps.event.addListener(map, 'idle', debouncedReload)

      setReady(true)
    })
  }, [])

  // active를 ref로도 보관 (이벤트 핸들러에서 stale 방지)
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])

  // ============ 마커 헬퍼 ============
  const makePin = useCallback((lat: number, lng: number, layer: Layer) => {
    const w = window as any
    const meta = LAYER_META[layer]
    const content = `<div style="
      width:24px;height:30px;position:relative;
      filter:drop-shadow(0 2px 3px rgba(0,0,0,0.3));
      cursor:pointer;
    ">
      <div style="
        position:absolute;top:0;left:0;width:24px;height:24px;
        border-radius:50% 50% 50% 0;transform:rotate(-45deg);
        background:${meta.color};border:2px solid #fff;
      "></div>
      <div style="
        position:absolute;top:2px;left:0;width:24px;height:24px;
        display:flex;align-items:center;justify-content:center;
        font-size:11px;z-index:2;
      ">${meta.icon}</div>
    </div>`
    return new w.kakao.maps.CustomOverlay({
      position: new w.kakao.maps.LatLng(lat, lng),
      content,
      yAnchor: 1, xAnchor: 0.5,
    })
  }, [])

  // ============ 레이어 로드 ============
  const loadLayer = useCallback(async (layer: Layer) => {
    const map = mapRef.current
    if (!map) return
    const w = window as any
    const supabase = createClient()
    const bounds = map.getBounds()
    const sw = bounds.getSouthWest()
    const ne = bounds.getNorthEast()

    // 기존 마커/폴리곤 제거
    overlaysRef.current[layer].forEach(o => o.setMap(null))
    overlaysRef.current[layer] = []

    // 사고다발 = 폴리곤 (분기)
    if (layer === 'danger') {
      const { data, error } = await supabase.rpc('danger_in_bbox', {
        min_lng: sw.getLng(), min_lat: sw.getLat(),
        max_lng: ne.getLng(), max_lat: ne.getLat(), max_n: 200,
      })
      if (error) { console.warn('[danger]', error.message); return }
      const arr: any[] = []
      for (const row of data || []) {
        const coords = (row.coords as number[][][])?.[0]
        if (!coords || coords.length < 3) continue
        const path = coords.map(([lng, lat]: number[]) => new w.kakao.maps.LatLng(lat, lng))
        const poly = new w.kakao.maps.Polygon({
          path,
          strokeWeight: 1.5, strokeColor: '#ef4444', strokeOpacity: 0.7, strokeStyle: 'dash',
          fillColor: '#ef4444', fillOpacity: 0.22,
        })
        poly.setMap(map)
        arr.push(poly)
      }
      overlaysRef.current.danger = arr
      setCounts(c => ({ ...c, danger: data?.length || 0 }))
      return
    }

    // 그 외 = 점 마커 (cctv, lights, bells, cvs)
    const { data, error } = await supabase.rpc('points_in_bbox', {
      layer,
      min_lng: sw.getLng(), min_lat: sw.getLat(),
      max_lng: ne.getLng(), max_lat: ne.getLat(), max_n: 500,
    })
    if (error) { console.warn(`[${layer}]`, error.message); return }
    const arr: any[] = []
    for (const row of data || []) {
      const pin = makePin(row.lat, row.lng, layer)
      pin.setMap(map)
      arr.push(pin)
    }
    overlaysRef.current[layer] = arr
    setCounts(c => ({ ...c, [layer]: data?.length || 0 }))
  }, [makePin])

  const loadLayerRef = useRef(loadLayer)
  useEffect(() => { loadLayerRef.current = loadLayer }, [loadLayer])

  // ============ 칩 토글 ============
  const toggleLayer = useCallback((layer: Layer) => {
    setActive(prev => {
      const next = new Set(prev)
      if (next.has(layer)) {
        overlaysRef.current[layer].forEach(o => o.setMap(null))
        overlaysRef.current[layer] = []
        next.delete(layer)
        setCounts(c => ({ ...c, [layer]: 0 }))
      } else {
        next.add(layer)
        loadLayer(layer)
      }
      return next
    })
  }, [loadLayer])

  // 첫 로드
  useEffect(() => {
    if (!ready) return
    active.forEach(layer => loadLayer(layer))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // ============ 사용자 위치 50m 반경 안전점수 ============
  useEffect(() => {
    if (!ready) return
    const supabase = createClient()
    supabase.rpc('point_safety', {
      user_lng: userPos.lng,
      user_lat: userPos.lat,
      radius_m: SAFETY_RADIUS_M,
    }).then(({ data, error }) => {
      if (error) { console.warn('point_safety:', error.message); return }
      setPointSafety(data as any)
    })
  }, [ready, userPos])

  // ============ 검색 결과 핀 (장소 카드용) ============
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const w = window as any

    if (placePinRef.current) { placePinRef.current.setMap(null); placePinRef.current = null }

    if (!selectedPlace) return

    const content = `<div style="width:34px;height:42px;position:relative;filter:drop-shadow(0 4px 6px rgba(0,0,0,0.35));">
      <div style="position:absolute;top:0;left:0;width:34px;height:34px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#ff3b5c;border:3px solid #fff;"></div>
      <div style="position:absolute;top:5px;left:0;width:34px;height:34px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;z-index:2;">📍</div>
    </div>`
    placePinRef.current = new w.kakao.maps.CustomOverlay({
      position: new w.kakao.maps.LatLng(selectedPlace.lat, selectedPlace.lng),
      content, yAnchor: 1, xAnchor: 0.5, map,
    })

    // 카드가 화면 절반 가리니까 핀이 위쪽 1/3 영역에 오도록 살짝 아래 패닝
    const latLng = new w.kakao.maps.LatLng(selectedPlace.lat - 0.0015, selectedPlace.lng)
    map.panTo(latLng)
  }, [selectedPlace])

  // ============ 경로 폴리라인 그리기 ============
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const w = window as any

    // 기존 경로 + 출발/도착 마커 제거
    routePolylinesRef.current.forEach(p => p.setMap(null))
    routePolylinesRef.current = []
    if (startPinRef.current) { startPinRef.current.setMap(null); startPinRef.current = null }
    if (endPinRef.current) { endPinRef.current.setMap(null); endPinRef.current = null }

    if (!routeResult || !endPlace) return
    const destination = endPlace

    // 후보 인덱스별 색상 (1위 추천=초록, 2위=파랑, 3위=회색)
    const ROUTE_COLORS = ['#16a34a', '#2d7eff', '#6b7280']
    const bounds = new w.kakao.maps.LatLngBounds()

    // 비선택 경로 먼저 (얇게, 흐리게)
    routeResult.candidates.forEach((c, i) => {
      const isSelected = c.key === selectedRouteKey
      if (isSelected) return
      const color = ROUTE_COLORS[i] ?? '#6b7280'
      const path = c.route.geometry.coordinates.map(([lng, lat]) =>
        new w.kakao.maps.LatLng(lat, lng))
      const line = new w.kakao.maps.Polyline({
        path, strokeWeight: 4, strokeColor: color,
        strokeOpacity: 0.35, strokeStyle: 'solid'
      })
      line.setMap(map)
      routePolylinesRef.current.push(line)
    })

    // 선택 경로 (두껍게)
    const selectedIdx = routeResult.candidates.findIndex(c => c.key === selectedRouteKey)
    const selected = selectedIdx >= 0 ? routeResult.candidates[selectedIdx] : null
    if (selected) {
      const color = ROUTE_COLORS[selectedIdx] ?? '#16a34a'
      const path = selected.route.geometry.coordinates.map(([lng, lat]) =>
        new w.kakao.maps.LatLng(lat, lng))
      path.forEach(p => bounds.extend(p))
      const outer = new w.kakao.maps.Polyline({
        path, strokeWeight: 9, strokeColor: '#ffffff', strokeOpacity: 0.95
      })
      outer.setMap(map)
      routePolylinesRef.current.push(outer)
      const inner = new w.kakao.maps.Polyline({
        path, strokeWeight: 6, strokeColor: color, strokeOpacity: 1
      })
      inner.setMap(map)
      routePolylinesRef.current.push(inner)
    }

    // 출발 마커
    if (startPlace) {
      const sc = `<div style="width:28px;height:34px;position:relative;filter:drop-shadow(0 3px 4px rgba(0,0,0,0.3));">
        <div style="position:absolute;top:0;left:0;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#fff;border:3px solid #2d7eff;"></div>
        <div style="position:absolute;top:3px;left:0;width:28px;height:28px;display:flex;align-items:center;justify-content:center;color:#2d7eff;font-size:11px;font-weight:800;z-index:2;">출</div>
      </div>`
      startPinRef.current = new w.kakao.maps.CustomOverlay({
        position: new w.kakao.maps.LatLng(startPlace.lat, startPlace.lng),
        content: sc, yAnchor: 1, xAnchor: 0.5, map,
      })
      bounds.extend(new w.kakao.maps.LatLng(startPlace.lat, startPlace.lng))
    }

    // 도착 마커
    const ec = `<div style="width:30px;height:36px;position:relative;filter:drop-shadow(0 3px 4px rgba(0,0,0,0.3));">
      <div style="position:absolute;top:0;left:0;width:30px;height:30px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#ff3b5c;border:2.5px solid #fff;"></div>
      <div style="position:absolute;top:4px;left:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:800;z-index:2;">도</div>
    </div>`
    endPinRef.current = new w.kakao.maps.CustomOverlay({
      position: new w.kakao.maps.LatLng(destination.lat, destination.lng),
      content: ec, yAnchor: 1, xAnchor: 0.5, map,
    })
    bounds.extend(new w.kakao.maps.LatLng(destination.lat, destination.lng))

    // 범위 자동 조정
    if (!bounds.isEmpty()) {
      map.setBounds(bounds, 50, 50, 280, 50)  // 하단 시트 공간 확보
    }
  }, [routeResult, selectedRouteKey, endPlace, startPlace])

  // ============ 컨트롤 ============
  const zoomIn = () => mapRef.current && mapRef.current.setLevel(mapRef.current.getLevel() - 1)
  const zoomOut = () => mapRef.current && mapRef.current.setLevel(mapRef.current.getLevel() + 1)
  const goMyLocation = () => {
    if (!navigator.geolocation || !mapRef.current) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const w = window as any
        const { latitude: lat, longitude: lng } = pos.coords
        mapRef.current.setCenter(new w.kakao.maps.LatLng(lat, lng))
        setUserPos({ lat, lng })
      },
      (err) => console.warn('geolocation:', err.message),
      { enableHighAccuracy: true, timeout: 5000 }
    )
  }

  // ============ 안전 점수 (PostGIS point_safety RPC 결과) ============
  const score = pointSafety?.score ?? 0
  const safetyCounts = pointSafety?.counts ?? { cctv: 0, lights: 0, bells: 0, cvs: 0 }

  return (
    <div className="w-full h-[100dvh] bg-zinc-900 flex items-center justify-center overflow-hidden">
      {/* PC에서 모바일 프레임 / 모바일에서는 풀스크린 */}
      <div className="relative w-full h-full md:w-[390px] md:h-[800px] md:rounded-[44px] md:border-[10px] md:border-zinc-800 md:shadow-2xl overflow-hidden bg-white">

        {/* CSS 애니메이션 */}
        <style jsx global>{`
          @keyframes me-ring {
            0% { transform: scale(0.6); opacity: 0.8; }
            100% { transform: scale(2.5); opacity: 0; }
          }
          @keyframes pulse-sos {
            0%, 100% { box-shadow: 0 6px 20px rgba(255,59,92,0.45), 0 0 0 0 rgba(255,59,92,0.4); }
            50% { box-shadow: 0 6px 20px rgba(255,59,92,0.45), 0 0 0 16px rgba(255,59,92,0); }
          }
          .scrollbar-hide::-webkit-scrollbar { display: none; }
          .scrollbar-hide { scrollbar-width: none; }
        `}</style>

        {/* 카카오맵 */}
        <div ref={containerRef} className="absolute inset-0 z-0" />

        {/* 검색 + 장소 카드 + 경로 비교 패널 */}
        <SearchPanel
          userLng={DEFAULT_CENTER.lng}
          userLat={DEFAULT_CENTER.lat}
          selectedPlace={selectedPlace}
          onSelectPlace={setSelectedPlace}
          start={startPlace}
          end={endPlace}
          onSetStart={setStartPlace}
          onSetEnd={setEndPlace}
          routeResult={routeResult}
          onRouteResult={setRouteResult}
          selectedCandidate={selectedRouteKey}
          onSelectCandidate={setSelectedRouteKey}
        />

        {/* 카테고리 칩 — 화면 모드에 따라 위치 동적 조정
            search/route 모드 (한 줄 패널) → top-20 (80px)
            placeCard 모드 → top-20
            directions 모드 (두 줄 패널) → top-40 (160px) */}
        <div className={`absolute left-3 right-3 z-10 flex gap-1.5 overflow-x-auto scrollbar-hide ${
          (startPlace || endPlace) && !routeResult ? 'top-44' : 'top-20'
        }`}>
          {ALL_LAYERS.map(layer => {
            const m = LAYER_META[layer]
            const isActive = active.has(layer)
            return (
              <button
                key={layer}
                onClick={() => toggleLayer(layer)}
                className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap flex items-center gap-1.5 shadow-sm border transition-all ${
                  isActive
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white/95 text-gray-400 border-gray-200'
                }`}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: m.color }} />
                <span>{m.label}</span>
                {isActive && counts[layer] > 0 && (
                  <span className="text-[10px] opacity-70 font-bold">{counts[layer]}</span>
                )}
              </button>
            )
          })}
        </div>

        {/* 우측 컨트롤 */}
        <div className="absolute right-3 top-32 z-10 flex flex-col gap-2">
          <div className="bg-white rounded-xl shadow-lg overflow-hidden flex flex-col">
            <button onClick={zoomIn} className="w-11 h-11 flex items-center justify-center text-lg font-bold hover:bg-gray-50 active:bg-gray-100">＋</button>
            <div className="border-t border-gray-100" />
            <button onClick={zoomOut} className="w-11 h-11 flex items-center justify-center text-lg font-bold hover:bg-gray-50 active:bg-gray-100">－</button>
          </div>
          <button onClick={goMyLocation} className="w-11 h-11 bg-white rounded-xl shadow-lg flex items-center justify-center text-blue-500 text-xl active:bg-gray-100">
            ◎
          </button>
        </div>

        {/* SOS FAB */}
        <button
          className="absolute bottom-44 left-3 w-14 h-14 rounded-full bg-[#ff3b5c] text-white font-extrabold text-sm shadow-lg z-20 active:scale-95 transition-transform"
          style={{ animation: 'pulse-sos 2s infinite' }}
        >
          SOS
        </button>


        {/* 하단 시트 - 장소카드/경로 카드 떠있으면 숨김 */}
        {!selectedPlace && !endPlace && !routeResult && (
        <div className="absolute bottom-0 left-0 right-0 z-10 bg-white rounded-t-3xl px-4 pt-2 pb-5 shadow-2xl" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>
          <div className="w-9 h-1 bg-gray-300 rounded-full mx-auto mb-3" />
          <div className="flex justify-between items-baseline mb-2">
            <div className="text-xs text-gray-500">
              {pointSafety?.is_night ? '🌙' : '☀'}
              <b className="text-gray-900 text-sm ml-1">현 위치 안전도</b>
              <span className="ml-1.5">· 반경 {SAFETY_RADIUS_M}m</span>
            </div>
            <div className={`text-2xl font-extrabold ${score >= 70 ? 'text-green-600' : score >= 50 ? 'text-yellow-600' : 'text-red-500'}`}>
              {score}
              <span className="text-sm text-gray-400 font-semibold">/100</span>
            </div>
          </div>
          <div className="h-1.5 bg-gray-100 rounded mb-3 overflow-hidden">
            <div className={`h-full rounded transition-all ${
              score >= 70 ? 'bg-gradient-to-r from-green-500 to-blue-500' :
              score >= 50 ? 'bg-gradient-to-r from-yellow-500 to-green-500' :
              'bg-gradient-to-r from-red-500 to-yellow-500'
            }`} style={{ width: `${score}%` }} />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {(['cctv', 'lights', 'bells', 'cvs'] as Layer[]).map(l => {
              const m = LAYER_META[l]
              const val = (safetyCounts as any)[l] ?? 0
              return (
                <div key={l} className="text-center py-2 rounded-lg bg-gray-50">
                  <div className={`text-base font-extrabold ${val > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                    {val}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5 flex items-center justify-center gap-0.5">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color }} />
                    {m.label}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        )}

      </div>
    </div>
  )
}
