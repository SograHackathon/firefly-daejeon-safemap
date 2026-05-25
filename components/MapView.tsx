'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase-browser'
import SearchPanel, { type RouteResult, type Place } from './SearchPanel'

type CurrentUser = { id: string; email: string; display_name: string; phone?: string | null; phone_verified?: boolean } | null

type Layer = 'cctv' | 'lights' | 'bells' | 'cvs' | 'danger'

const DEFAULT_CENTER = { lat: 36.3672, lng: 127.3454 } // 충남대 정문
const DEFAULT_LEVEL = 4

// SVG 라인 아이콘 (lucide 스타일) — 마커/칩 양쪽에서 사용. 색은 currentColor 로 상속.
const ICON_SVG = {
  // CCTV — 카메라 본체 + 렌즈
  cctv: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9.5L18 5l3 7-16 4.5z"/><path d="M5 16l-1 4"/><circle cx="11" cy="11" r="1.5"/></svg>`,
  // 가로등 — 등기둥 + 빛
  lights: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4"/><path d="M8 5l4-2 4 2"/><rect x="11" y="7" width="2" height="10"/><path d="M9 21h6"/></svg>`,
  // 비상벨 — 종 모양
  bells: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`,
  // 편의점 — 가게(스토어) 아이콘
  cvs: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9"/><path d="M3 9v11h18V9"/><path d="M3 9h18"/><path d="M9 13h6"/></svg>`,
  // 사고다발 — 경고 삼각형
  danger: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4L2 20h20L12 4z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.6" fill="currentColor"/></svg>`,
}

const LAYER_META: Record<Layer, { label: string; color: string; icon: string }> = {
  cctv:   { label: 'CCTV',     color: '#2d7eff', icon: '📹' },
  lights: { label: '가로등',   color: '#f59e0b', icon: '💡' },
  bells:  { label: '비상벨',   color: '#16a34a', icon: ICON_SVG.bells },
  cvs:    { label: '편의점',   color: '#ff8a00', icon: ICON_SVG.cvs },
  danger: { label: '사고다발', color: '#ef4444', icon: ICON_SVG.danger },
}

const ALL_LAYERS: Layer[] = ['cctv', 'lights', 'bells', 'cvs', 'danger']

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const overlaysRef = useRef<Record<Layer, any[]>>({
    cctv: [], lights: [], bells: [], cvs: [], danger: []
  })

  const [active, setActive] = useState<Set<Layer>>(new Set())
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
  const meOverlayRef = useRef<any>(null)
  const mePulseRef = useRef<any>(null)  // 50m 실거리 파란 펄스

  // ===== 인증 사용자 =====
  const router = useRouter()
  const [me, setMe] = useState<CurrentUser>(null)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => {
      if (!cancelled) setMe(d?.user ?? null)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const logout = useCallback(async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch {}
    setMe(null)
    setUserMenuOpen(false)
    router.push('/auth/login')
  }, [router])

  // ===== SOS 동선 공유 state =====
  const [sosSession, setSosSession] = useState<{ session_id: string; share_url: string; expires_at: string; otp?: string } | null>(null)
  const [sosToast, setSosToast] = useState<string | null>(null)

  // ===== 시민 제보 (k-익명화) state =====
  const [reportOpen, setReportOpen] = useState(false)
  const [reportType, setReportType] = useState<'blindspot' | 'light_broken' | 'danger_path' | 'other'>('blindspot')
  const [reportDesc, setReportDesc] = useState('')
  const [reportSubmitting, setReportSubmitting] = useState(false)
  const [reportResult, setReportResult] = useState<{ visible: boolean; cell_count: number; k: number } | null>(null)
  const submitReport = useCallback(async () => {
    setReportSubmitting(true)
    setReportResult(null)
    try {
      const r = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: reportType,
          description: reportDesc.slice(0, 280),
          lat: userPos.lat,
          lng: userPos.lng,
        }),
      })
      if (r.status === 429) {
        setSosToast('너무 많은 제보 — 1분 후 재시도')
        return
      }
      if (!r.ok) {
        setSosToast('제보 전송 실패')
        return
      }
      const j = await r.json()
      setReportResult({ visible: !!j.visible, cell_count: j.cell_count, k: j.k })
      setReportDesc('')
      setSosToast(j.visible
        ? `✅ 제보 완료 · 셀 누적 ${j.cell_count}건 (k=${j.k} 익명화)`
        : `🛡 제보 접수 · 셀 누적 ${j.cell_count}/${j.k} (k 미충족 시 비공개)`)
    } catch {
      setSosToast('네트워크 오류')
    } finally {
      setReportSubmitting(false)
    }
  }, [reportType, reportDesc, userPos])

  // ===== SOS 긴급신고 모달 =====
  const [sosScreen, setSosScreen] = useState<'closed' | 'options' | 'dialing'>('closed')
  const [sosDialNumber, setSosDialNumber] = useState<string>('')
  const [userPhone, setUserPhone] = useState<string>('')
  const [phonePromptOpen, setPhonePromptOpen] = useState(false)
  const [phoneInput, setPhoneInput] = useState('')

  // 로그인 사용자 phone 우선 적용 (LocalStorage 폴백)
  useEffect(() => {
    if (me?.phone) {
      setUserPhone(me.phone)
      return
    }
    if (typeof window === 'undefined') return
    const saved = localStorage.getItem('firefly:phone')
    if (saved) setUserPhone(saved)
  }, [me])

  const formatPhone = useCallback((p: string) => {
    const d = p.replace(/[^0-9]/g, '')
    if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
    return d
  }, [])

  const openSos = useCallback(() => {
    if (!userPhone) {
      setPhoneInput('')
      setPhonePromptOpen(true)
    } else {
      setSosScreen('options')
    }
  }, [userPhone])

  const savePhoneAndOpenSos = useCallback(() => {
    const digits = phoneInput.replace(/[^0-9]/g, '')
    if (digits.length < 10 || digits.length > 11) return
    if (typeof window !== 'undefined') localStorage.setItem('firefly:phone', digits)
    setUserPhone(digits)
    setPhonePromptOpen(false)
    setSosScreen('options')
  }, [phoneInput])

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
  // routeResult 가 처음 들어올 때만 카메라 fit. 후보 선택만 바뀌면 사용자가 움직인 위치 유지
  const fittedRouteRef = useRef<typeof routeResult | null>(null)

  // ============ 지도 초기화 ============
  useEffect(() => {
    if (!containerRef.current) return
    const w = window as any
    let cancelled = false

    // SDK 동적 로드 (이미 있으면 즉시 resolve, 없으면 script tag 추가)
    const loadSdk = (): Promise<void> => new Promise((resolve, reject) => {
      if (w.kakao?.maps?.load) return resolve()
      const KEY = process.env.NEXT_PUBLIC_KAKAO_MAP_KEY
      if (!KEY) return reject(new Error('NEXT_PUBLIC_KAKAO_MAP_KEY missing'))
      const existing = document.getElementById('kakao-sdk-script')
      if (existing) {
        // script 는 있는데 still loading → onload 까지 대기
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener('error', () => reject(new Error('SDK error')), { once: true })
        return
      }
      const s = document.createElement('script')
      s.id = 'kakao-sdk-script'
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KEY}&libraries=services,clusterer&autoload=false`
      s.async = true
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('SDK load failed'))
      document.head.appendChild(s)
    })

    const doInit = () => {
      if (cancelled) return
      w.kakao.maps.load(() => {
      const map = new w.kakao.maps.Map(containerRef.current, {
        center: new w.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
        level: DEFAULT_LEVEL,
      })
      mapRef.current = map

      // 현 위치 펄스 (ref 보관, 위치 업데이트용)
      const meContent = `<div style="position:relative;width:22px;height:22px;">
        <div style="position:absolute;inset:0;border-radius:50%;background:rgba(45,126,255,0.3);animation:me-ring 2s infinite;"></div>
        <div style="position:absolute;inset:4px;background:#2d7eff;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3);"></div>
      </div>`
      meOverlayRef.current = new w.kakao.maps.CustomOverlay({
        position: new w.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
        content: meContent,
        yAnchor: 0.5,
        xAnchor: 0.5,
        map: map,
        zIndex: 10,
      })

      // 50m 펄스 (실거리 — 줌별 px 동적 계산)
      const renderPulse = () => {
        const proj = map.getProjection()
        const pos = meOverlayRef.current?.getPosition?.()
          ?? new w.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng)
        const lat = pos.getLat()
        const lng = pos.getLng()
        // 50m 동쪽 좌표
        const lng2 = lng + SAFETY_RADIUS_M / (111_000 * Math.cos(lat * Math.PI / 180))
        let rPx = 60
        try {
          if (proj?.containerPointFromCoords) {
            const p1 = proj.containerPointFromCoords(pos)
            const p2 = proj.containerPointFromCoords(new w.kakao.maps.LatLng(lat, lng2))
            const dx = Math.abs((p2?.x ?? 0) - (p1?.x ?? 0))
            if (isFinite(dx) && dx > 0) rPx = Math.max(20, dx)
          }
        } catch {}
        const dPx = rPx * 2
        const off = -rPx
        const pulseContent = `<div style="position:relative;width:0;height:0;pointer-events:none;">
          <div style="position:absolute;left:${off}px;top:${off}px;width:${dPx}px;height:${dPx}px;
                      border-radius:50%;background:#2d7eff;
                      opacity:0;transform:scale(0.4);
                      will-change:transform,opacity;
                      animation:me-pulse 3.6s ease-out infinite;"></div>
          <div style="position:absolute;left:${off}px;top:${off}px;width:${dPx}px;height:${dPx}px;
                      border-radius:50%;background:#2d7eff;
                      opacity:0;transform:scale(0.4);
                      will-change:transform,opacity;
                      animation:me-pulse 3.6s ease-out 1.8s infinite;"></div>
        </div>`
        if (mePulseRef.current) mePulseRef.current.setMap(null)
        mePulseRef.current = new w.kakao.maps.CustomOverlay({
          position: pos,
          content: pulseContent,
          yAnchor: 0.5, xAnchor: 0.5, zIndex: 1, map,
        })
      }
      renderPulse()
      w.kakao.maps.event.addListener(map, 'zoom_changed', renderPulse)

      // 지도 이동/줌 끝나면 활성 레이어 다시 로드 (debounce)
      let timer: ReturnType<typeof setTimeout> | null = null
      const debouncedReload = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          activeRef.current.forEach(layer => loadLayerRef.current(layer))
        }, 400)
      }
      w.kakao.maps.event.addListener(map, 'idle', debouncedReload)

      // 지도 빈 영역(또는 POI 텍스트) 클릭 → 카카오 POI 자동 매칭 후 카드 표시
      w.kakao.maps.event.addListener(map, 'click', async (mouseEvent: any) => {
        // 검색바/input 포커스 해제 → 히스토리 패널 닫힘
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur()
        }
        const latLng = mouseEvent.latLng
        const lng = latLng.getLng()
        const lat = latLng.getLat()
        try {
          const r = await fetch(`/api/place-at?lng=${lng}&lat=${lat}`)
          if (r.ok) {
            const { place } = await r.json()
            if (place) {
              setSelectedPlace(place)
              return
            }
          }
        } catch {}
      })

      setReady(true)
      })
    }

    loadSdk()
      .then(() => doInit())
      .catch(err => console.warn('Kakao SDK:', err.message))

    return () => { cancelled = true }
  }, [])

  // active를 ref로도 보관 (이벤트 핸들러에서 stale 방지)
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])

  // ============ 마커 헬퍼 (클릭하면 placeCard 모드로 전환) ============
  const makePin = useCallback((lat: number, lng: number, layer: Layer) => {
    const w = window as any
    const meta = LAYER_META[layer]
    const div = document.createElement('div')
    div.style.cssText = 'width:26px;height:32px;position:relative;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.28));cursor:pointer;'
    div.innerHTML = `
      <div style="position:absolute;top:0;left:0;width:26px;height:26px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${meta.color};border:2px solid #fff;"></div>
      <div style="position:absolute;top:3px;left:0;width:26px;height:26px;display:flex;align-items:center;justify-content:center;color:#fff;z-index:2;">${meta.icon}</div>
    `
    div.addEventListener('click', async (e) => {
      e.stopPropagation()
      // 클릭 시 해당 좌표로 reverse-geocode → Place 카드로 표시
      let address = ''
      try {
        const r = await fetch(`/api/reverse-geocode?lng=${lng}&lat=${lat}`)
        if (r.ok) {
          const d = await r.json()
          address = d.address || d.short || ''
        }
      } catch {}
      setSelectedPlace({
        id: `${layer}_${lat.toFixed(5)}_${lng.toFixed(5)}`,
        name: meta.label,
        address,
        category: meta.label,
        lng, lat,
      })
    })

    return new w.kakao.maps.CustomOverlay({
      position: new w.kakao.maps.LatLng(lat, lng),
      content: div,
      yAnchor: 1, xAnchor: 0.5,
    })
  }, [])

  // ============ 레이어 로드 ============
  const loadLayer = useCallback(async (layer: Layer) => {
    const map = mapRef.current
    if (!map) return
    // ★ 가드: 사용자가 OFF 한 layer 는 절대 그리지 않음
    if (!activeRef.current.has(layer)) return
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
        // OFF: 마커 모두 제거 + 카운트 0
        const overlays = overlaysRef.current[layer] || []
        overlays.forEach(o => { try { o.setMap(null) } catch {} })
        overlaysRef.current[layer] = []
        next.delete(layer)
        setCounts(c => ({ ...c, [layer]: 0 }))
      } else {
        // ON
        next.add(layer)
      }
      // ★ ref 즉시 동기화 (idle 이벤트 stale 방지)
      activeRef.current = next
      return next
    })
  }, [])

  // active 변경 시 새로 활성화된 layer 만 load
  useEffect(() => {
    if (!ready) return
    active.forEach(layer => {
      if ((overlaysRef.current[layer] || []).length === 0) {
        loadLayer(layer)
      }
    })
  }, [active, ready, loadLayer])

  // ============ 사용자 위치 변경 시 펄스+50m 원 이동 + 안전점수 ============
  useEffect(() => {
    if (!ready) return
    const w = window as any
    const latLng = new w.kakao.maps.LatLng(userPos.lat, userPos.lng)
    if (meOverlayRef.current) meOverlayRef.current.setPosition(latLng)
    if (mePulseRef.current)   mePulseRef.current.setPosition(latLng)

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

    // 후보 인덱스별 색상 (1위=초록, 2위=파랑, 3위=주황, 4위=보라, 5위=회색)
    const ROUTE_COLORS = ['#16a34a', '#2d7eff', '#f59e0b', '#a855f7', '#6b7280']
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

    // 범위 자동 조정 — routeResult 가 새로 들어올 때만 1회. 후보 선택만 바뀐 경우 카메라 유지
    if (fittedRouteRef.current !== routeResult && !bounds.isEmpty()) {
      map.setBounds(bounds, 50, 50, 280, 50)
      fittedRouteRef.current = routeResult
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
        mapRef.current.setLevel(3) // 줌 확대 고정 (3 = 골목 단위)
        mapRef.current.setCenter(new w.kakao.maps.LatLng(lat, lng))
        setUserPos({ lat, lng })
      },
      (err) => console.warn('geolocation:', err.message),
      { enableHighAccuracy: true, timeout: 5000 }
    )
  }

  // ============ SOS 동선 공유 ============
  const userPosRef = useRef(userPos)
  useEffect(() => { userPosRef.current = userPos }, [userPos])

  // 공유 활성 시 실시간 위치 추적 + 5초 heartbeat
  useEffect(() => {
    if (!sosSession) return

    // watchPosition: 위치 변경 시 userPos 업데이트 (50m 원도 따라옴)
    let watchId: number | null = null
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        },
        (err) => console.warn('watchPosition:', err.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      )
    }

    // heartbeat
    const send = async () => {
      const p = userPosRef.current
      try {
        const r = await fetch('/api/sos/heartbeat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sosSession.session_id, lng: p.lng, lat: p.lat }),
        })
        if (r.status === 410) {
          setSosSession(null)
          setSosToast('세션이 만료되었습니다.')
        }
      } catch {}
    }
    send()
    const iv = setInterval(send, 5000)

    return () => {
      clearInterval(iv)
      if (watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(watchId)
    }
  }, [sosSession])

  // 토스트 자동 사라짐
  useEffect(() => {
    if (!sosToast) return
    const t = setTimeout(() => setSosToast(null), 4000)
    return () => clearTimeout(t)
  }, [sosToast])

  const startSosShare = useCallback(async (opts?: {
    planned_route?: { type: 'LineString'; coordinates: [number, number][] } | null
    planned_route_label?: string | null
    destination_lng?: number | null
    destination_lat?: number | null
    silent?: boolean  // true 면 share sheet/clipboard 안 띄움 (안내 시작 자동 호출용)
  }) => {
    try {
      const r = await fetch('/api/sos/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lng: userPos.lng, lat: userPos.lat,
          name: endPlace?.name || null,
          planned_route: opts?.planned_route ?? null,
          planned_route_label: opts?.planned_route_label ?? null,
          destination_lng: opts?.destination_lng ?? endPlace?.lng ?? null,
          destination_lat: opts?.destination_lat ?? endPlace?.lat ?? null,
        }),
      })
      if (!r.ok) { setSosToast('공유 시작 실패'); return null }
      const data = await r.json()
      setSosSession({ session_id: data.session_id, share_url: data.share_url, expires_at: data.expires_at, otp: data.otp })

      if (!opts?.silent) {
        const text = `🛡 반딧불이 · 실시간 동선 공유\n링크: ${data.share_url}\nOTP: ${data.otp}\n(보호자 인증용 · 별도 채널로 전달 권장)\n(2시간 후 자동 만료)`
        const w = window as any
        // url 필드를 넘기면 카카오톡 등 일부 앱이 url만 사용하고 text(OTP 포함)를 버림.
        // text 한 덩어리로만 넘겨서 모든 앱에서 OTP가 함께 전달되도록 한다.
        if (w.navigator?.share) {
          try { await w.navigator.share({ title: '반딧불이 동선 공유', text }) }
          catch {}
        } else if (w.navigator?.clipboard) {
          try { await w.navigator.clipboard.writeText(text) } catch {}
        }
        setSosToast(`🔐 OTP ${data.otp} · 보호자에게 별도 채널로 전달`)
      }
      return data as { session_id: string; share_url: string; expires_at: string; otp: string }
    } catch (e: any) {
      setSosToast(e?.message || '공유 실패')
      return null
    }
  // userPos 는 ref 로 읽으므로 deps 미포함
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endPlace])

  // ===== 안내 모드 (공유와 독립 — 공유는 안내 중에 따로 선택) =====
  const [guideActive, setGuideActive] = useState(false)
  const guideCandidateRef = useRef<{
    geometry: { type: 'LineString'; coordinates: [number, number][] }
    label: string
    destination_lng: number | null
    destination_lat: number | null
  } | null>(null)

  // routeResult 가 사라지면 (뒤로가기, 출/도착 변경 등) 안내도 자동 종료
  useEffect(() => {
    if (!routeResult && guideActive) {
      setGuideActive(false)
      guideCandidateRef.current = null
    }
  }, [routeResult, guideActive])

  const startGuide = useCallback((candidateKey: string) => {
    if (!routeResult) return
    const cand = routeResult.candidates.find(c => c.key === candidateKey)
    if (!cand) return
    guideCandidateRef.current = {
      geometry: cand.route.geometry,
      label: cand.label,
      destination_lng: endPlace?.lng ?? null,
      destination_lat: endPlace?.lat ?? null,
    }
    setGuideActive(true)
    setSosToast(`🟢 안내 시작 · ${cand.label}`)
  }, [routeResult, endPlace])

  const stopGuide = useCallback(async () => {
    setGuideActive(false)
    guideCandidateRef.current = null
    // 공유 중이면 함께 종료
    if (sosSession) {
      try {
        await fetch('/api/sos/end', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sosSession.session_id }),
        })
      } catch {}
      setSosSession(null)
    }
    setSosToast('안내가 종료되었습니다')
  }, [sosSession])

  // 안내 중에만 호출 — 안내 경로/목적지를 함께 공유
  const startGuideShare = useCallback(async () => {
    const c = guideCandidateRef.current
    if (!c) return
    const data = await startSosShare({
      planned_route: c.geometry,
      planned_route_label: c.label,
      destination_lng: c.destination_lng,
      destination_lat: c.destination_lat,
    })
    if (data) setSosToast('🔗 보호자에게 안내 경로 공유됨')
  }, [startSosShare])

  const endSosShare = useCallback(async () => {
    if (!sosSession) return
    try {
      await fetch('/api/sos/end', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sosSession.session_id }),
      })
    } catch {}
    setSosSession(null)
    setSosToast('동선 공유를 종료했습니다.')
  }, [sosSession])

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
          onStartGuide={startGuide}
          onStopGuide={stopGuide}
          guideActive={guideActive}
        />

        {/* 카테고리 칩 — 모드별 헤더 패널 바로 아래로 유동 위치 */}
        {(() => {
          // 모드별 칩 top 위치 (헤더 패널 직하 + 4~8px 여유)
          const chipTop =
            routeResult ? 'top-28'                  // route 두 줄 헤더 (≈100px) 아래
            : (startPlace || endPlace) ? 'top-28'   // directions 두 줄 (≈100px) 아래
            : 'top-16'                              // search/placeCard 한 줄 (≈55px) 아래
          return (
        <div className={`absolute left-3 right-3 z-10 flex gap-1.5 overflow-x-auto scrollbar-hide ${chipTop}`}>
          {ALL_LAYERS.map(layer => {
            const m = LAYER_META[layer]
            const isActive = active.has(layer)
            return (
              <button
                key={layer}
                onClick={() => toggleLayer(layer)}
                className={`flex-shrink-0 pl-2.5 pr-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap flex items-center gap-1.5 shadow-sm border transition-all ${
                  isActive
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white/95 text-gray-500 border-gray-200'
                }`}
              >
                <span
                  className="flex items-center justify-center"
                  style={{ color: isActive ? '#fff' : m.color }}
                  dangerouslySetInnerHTML={{ __html: m.icon }}
                />
                <span>{m.label}</span>
                {isActive && counts[layer] > 0 && (
                  <span className="text-[10px] opacity-70 font-bold">{counts[layer]}</span>
                )}
              </button>
            )
          })}
        </div>
          )
        })()}

        {/* 우측 컨트롤 — 줌 + 현위치 + 계정 (모두 우측 세로 스택) */}
        <div className="absolute right-3 top-32 z-30 flex flex-col gap-2">
          <div className="bg-white rounded-xl shadow-lg overflow-hidden flex flex-col">
            <button onClick={zoomIn} aria-label="확대" className="w-11 h-11 flex items-center justify-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
            <div className="border-t border-gray-100" />
            <button onClick={zoomOut} aria-label="축소" className="w-11 h-11 flex items-center justify-center text-gray-700 hover:bg-gray-50 active:bg-gray-100">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
          </div>
          <button onClick={goMyLocation} aria-label="내 위치" className="w-11 h-11 bg-white rounded-xl shadow-lg flex items-center justify-center text-blue-500 active:bg-gray-100">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" fill="currentColor"/>
              <circle cx="12" cy="12" r="8"/>
              <line x1="12" y1="1" x2="12" y2="4"/>
              <line x1="12" y1="20" x2="12" y2="23"/>
              <line x1="1" y1="12" x2="4" y2="12"/>
              <line x1="20" y1="12" x2="23" y2="12"/>
            </svg>
          </button>

          {/* 계정 — 현위치 버튼 바로 아래 */}
          <div className="relative">
            {me ? (
              <button
                onClick={() => setUserMenuOpen(o => !o)}
                className="w-11 h-11 rounded-full bg-gradient-to-br from-red-500 to-pink-500 text-white font-extrabold text-sm shadow-lg active:scale-95 flex items-center justify-center border-2 border-white"
                title={me.email}
              >
                {(me.display_name || me.email).slice(0, 1).toUpperCase()}
              </button>
            ) : (
              <a
                href="/auth/login"
                className="w-11 h-11 rounded-full bg-white shadow-lg text-sm font-bold text-gray-800 flex items-center justify-center border border-gray-200"
              >
                👤
              </a>
            )}
            {me && userMenuOpen && (
              <div className="absolute right-0 top-12 min-w-[200px] bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <div className="text-xs text-gray-500">로그인 계정</div>
                  <div className="text-sm font-bold text-gray-900">{me.display_name}</div>
                  <div className="text-[11px] text-gray-500 truncate">{me.email}</div>
                </div>
                <button
                  onClick={logout}
                  className="w-full px-4 py-3 text-left text-sm text-red-500 font-semibold hover:bg-red-50 active:bg-red-100"
                >
                  로그아웃
                </button>
              </div>
            )}
          </div>
        </div>

        {/* SOS FAB — 긴급 신고 옵션 모달 */}
        <button
          onClick={openSos}
          aria-label="긴급 신고"
          className="absolute bottom-44 left-3 w-14 h-14 rounded-full bg-[#ff3b5c] text-white font-extrabold text-sm shadow-lg z-20 active:scale-95 transition-transform flex items-center justify-center"
          style={{ animation: 'pulse-sos 2s infinite' }}
        >
          SOS
        </button>

        {/* 시민 제보 FAB — k-익명화 적용 */}
        <button
          onClick={() => { setReportOpen(true); setReportResult(null) }}
          aria-label="시민 제보"
          title="이 위치 안전 제보 (k=3 익명화)"
          className="absolute bottom-44 right-3 w-12 h-12 rounded-full bg-white text-gray-700 font-bold shadow-lg z-20 active:scale-95 border border-gray-200 flex items-center justify-center"
        >
          🛡
        </button>

        {/* 최초 휴대번호 등록 모달 */}
        {phonePromptOpen && (
          <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-2xl">
              <div className="text-base font-bold mb-1">🚨 긴급신고 연동 휴대번호</div>
              <div className="text-xs text-gray-500 mb-4 leading-relaxed">
                SOS 발신 시 본인 식별용으로 표시됩니다.<br/>
                <span className="text-[10px]">기기에 안전하게 저장 · 외부 전송 X</span>
              </div>
              <input
                value={phoneInput}
                onChange={(e) => setPhoneInput(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="010-0000-0000"
                type="tel"
                inputMode="numeric"
                maxLength={11}
                autoFocus
                className="w-full p-3 border-2 border-gray-200 focus:border-red-400 outline-none rounded-lg font-mono tracking-wider text-center text-lg mb-3"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => setPhonePromptOpen(false)}
                  className="flex-1 p-3 text-gray-500 font-medium text-sm rounded-lg active:bg-gray-100"
                >
                  취소
                </button>
                <button
                  onClick={savePhoneAndOpenSos}
                  disabled={phoneInput.length < 10}
                  className="flex-1 p-3 bg-red-500 text-white rounded-lg font-bold text-sm active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  등록 후 신고
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 시민 제보 모달 — k=3 익명화 + DOMPurify */}
        {reportOpen && (
          <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setReportOpen(false)}>
            <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start gap-2 mb-3">
                <div className="text-2xl">🛡</div>
                <div className="flex-1">
                  <div className="text-base font-bold">안전 제보</div>
                  <div className="text-[11px] text-gray-500 leading-relaxed">
                    위치는 <b>50m 그리드로 양자화</b> 후 저장. 동일 셀에 <b>3건 누적</b> 시에만 지도에 노출됩니다 (k-익명화).
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-3">
                {([
                  ['blindspot', '🕶 사각지대'],
                  ['light_broken', '💡 가로등 고장'],
                  ['danger_path', '⚠ 통행 위험'],
                  ['other', '📝 기타'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setReportType(key)}
                    className={`p-2.5 text-xs font-semibold rounded-xl border-2 transition-all ${
                      reportType === key
                        ? 'border-pink-500 bg-pink-50 text-pink-700'
                        : 'border-gray-200 bg-white text-gray-600'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <textarea
                value={reportDesc}
                onChange={(e) => setReportDesc(e.target.value.slice(0, 280))}
                placeholder="설명 (선택, 280자 이내) — HTML 태그는 자동 제거됩니다"
                maxLength={280}
                rows={3}
                className="w-full px-3 py-2.5 border-2 border-gray-200 focus:border-pink-400 outline-none rounded-xl text-sm text-gray-900 resize-none"
              />
              <div className="text-[10px] text-gray-400 text-right mt-0.5 mb-3">{reportDesc.length}/280</div>

              {reportResult && (
                <div className={`text-[11px] rounded-lg p-2.5 mb-3 ${
                  reportResult.visible
                    ? 'bg-green-50 border border-green-200 text-green-700'
                    : 'bg-blue-50 border border-blue-200 text-blue-700'
                }`}>
                  {reportResult.visible
                    ? `✅ 셀 누적 ${reportResult.cell_count}건 (k=${reportResult.k}) — 지도에 표시됩니다.`
                    : `🔒 셀 누적 ${reportResult.cell_count}/${reportResult.k} — k 충족 전엔 비공개`}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => setReportOpen(false)}
                  className="flex-1 p-2.5 text-gray-500 font-medium text-sm rounded-xl active:bg-gray-100"
                >
                  닫기
                </button>
                <button
                  onClick={submitReport}
                  disabled={reportSubmitting}
                  className="flex-1 p-2.5 bg-gradient-to-r from-pink-500 to-red-500 text-white rounded-xl font-bold text-sm active:scale-95 disabled:opacity-40"
                >
                  {reportSubmitting ? '전송 중…' : '제보 보내기'}
                </button>
              </div>
              <div className="text-[10px] text-gray-400 text-center mt-2">
                원본 좌표는 저장되지 않음 · IP는 감사 로그용으로만 기록
              </div>
            </div>
          </div>
        )}

        {/* SOS 옵션 시트 (112 / 119 / 1366) */}
        {sosScreen === 'options' && (
          <div className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end" onClick={() => setSosScreen('closed')}>
            <div className="w-full bg-white rounded-t-3xl p-5 pb-8 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-3" />
              <div className="text-center mb-4">
                <div className="text-lg font-extrabold text-gray-900">🚨 긴급 신고</div>
                <div className="text-xs text-gray-500 mt-0.5">상황에 맞는 번호를 선택하세요</div>
              </div>
              <div className="space-y-2">
                <button
                  onClick={() => { setSosDialNumber('112'); setSosScreen('dialing') }}
                  className="w-full p-4 bg-gradient-to-r from-red-500 to-red-600 text-white rounded-2xl flex items-center gap-3 active:scale-[0.98] transition-transform shadow-md"
                >
                  <span className="text-3xl">🚔</span>
                  <div className="text-left flex-1">
                    <div className="text-xl font-extrabold leading-none">112</div>
                    <div className="text-xs opacity-90 mt-1">경찰 · 범죄 · 신변보호</div>
                  </div>
                  <span className="text-white/70 text-lg">›</span>
                </button>
                <button
                  onClick={() => { setSosDialNumber('119'); setSosScreen('dialing') }}
                  className="w-full p-4 bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-2xl flex items-center gap-3 active:scale-[0.98] transition-transform shadow-md"
                >
                  <span className="text-3xl">🚑</span>
                  <div className="text-left flex-1">
                    <div className="text-xl font-extrabold leading-none">119</div>
                    <div className="text-xs opacity-90 mt-1">소방 · 응급의료 · 구조</div>
                  </div>
                  <span className="text-white/70 text-lg">›</span>
                </button>
                <button
                  onClick={() => { setSosDialNumber('1366'); setSosScreen('dialing') }}
                  className="w-full p-4 bg-gradient-to-r from-pink-500 to-pink-600 text-white rounded-2xl flex items-center gap-3 active:scale-[0.98] transition-transform shadow-md"
                >
                  <span className="text-3xl">🚺</span>
                  <div className="text-left flex-1">
                    <div className="text-xl font-extrabold leading-none">1366</div>
                    <div className="text-xs opacity-90 mt-1">여성긴급전화 · 폭력 · 상담</div>
                  </div>
                  <span className="text-white/70 text-lg">›</span>
                </button>
              </div>
              <button
                onClick={() => setSosScreen('closed')}
                className="w-full mt-4 p-3 text-gray-500 font-medium text-sm rounded-xl active:bg-gray-100"
              >
                취소
              </button>
            </div>
          </div>
        )}

        {/* SOS 발신 화면 (시뮬레이션 — 실제 전화 X) */}
        {sosScreen === 'dialing' && (
          <div className="absolute inset-0 z-40 bg-gradient-to-b from-gray-900 via-gray-900 to-black flex flex-col items-center justify-between p-6 text-white">
            {/* 상단: 발신자(본인) 번호 */}
            <div className="w-full pt-4">
              {userPhone && (
                <div className="flex items-center justify-center gap-2 text-xs text-white/60">
                  <span className="opacity-70">발신자</span>
                  <span className="font-mono font-semibold text-white/90">{formatPhone(userPhone)}</span>
                  {me?.phone_verified && <span className="text-[10px] text-green-300 ml-1">✓ 인증됨</span>}
                  {!me?.phone && (
                    <button
                      onClick={() => {
                        setPhoneInput(userPhone)
                        setSosScreen('closed')
                        setPhonePromptOpen(true)
                      }}
                      className="text-[10px] text-blue-300 underline ml-1"
                    >
                      변경
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 중앙: 응급번호 */}
            <div className="flex flex-col items-center">
              <div className="text-xs text-white/60 mb-5 tracking-[0.25em] uppercase">발신 대기</div>
              <div className="text-7xl font-mono font-extrabold tracking-wider mb-3">{sosDialNumber}</div>
              <div className="text-sm text-white/80 mb-10">
                {sosDialNumber === '112' && '경찰 · 긴급신고'}
                {sosDialNumber === '119' && '소방 · 응급의료'}
                {sosDialNumber === '1366' && '여성긴급전화'}
              </div>
              <div className="relative mb-8">
                <div className="absolute inset-0 rounded-full bg-red-500/40 animate-ping" />
                <div className="relative w-24 h-24 rounded-full bg-red-500 border-4 border-white/30 flex items-center justify-center">
                  <span className="text-4xl">📞</span>
                </div>
              </div>
              {userPhone && (
                <div className="text-[11px] text-white/50 font-mono tracking-wider">
                  {formatPhone(userPhone)} → {sosDialNumber}
                </div>
              )}
            </div>

            {/* 하단: 종료 버튼 */}
            <div className="flex flex-col items-center pb-2">
              <button
                onClick={() => setSosScreen('closed')}
                className="w-16 h-16 rounded-full bg-red-600 text-white shadow-xl flex items-center justify-center text-2xl active:scale-95 mb-6"
                aria-label="발신 종료"
              >
                ✕
              </button>
              <div className="text-[10px] text-white/40 tracking-wider">시연용 화면 — 실제 발신되지 않습니다</div>
            </div>
          </div>
        )}

        {/* 공유 FAB — 안내 모드 중에만 노출 */}
        {guideActive && !sosSession && (
          <button
            onClick={startGuideShare}
            aria-label="안내 경로 동선 공유"
            className="absolute bottom-64 left-3 z-20 group active:scale-[0.97] transition-transform"
            title="보호자에게 안내 경로 공유"
          >
            <div className="flex items-center gap-2.5 pl-1.5 pr-4 h-12 rounded-full bg-gradient-to-br from-indigo-500 via-blue-500 to-cyan-500 text-white shadow-xl shadow-blue-500/40 ring-1 ring-white/20">
              <div className="w-9 h-9 rounded-full bg-white/15 backdrop-blur flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-4.5 h-4.5" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                  <line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/>
                </svg>
              </div>
              <div className="text-left leading-none">
                <div className="text-[9px] uppercase tracking-[0.12em] opacity-85 font-semibold">Guardian</div>
                <div className="text-[13px] font-bold mt-0.5">보호자에 공유</div>
              </div>
            </div>
          </button>
        )}
        {guideActive && sosSession && (
          <button
            onClick={endSosShare}
            aria-label="동선 공유 종료"
            className="absolute bottom-64 left-3 z-20 group active:scale-[0.97] transition-transform"
            title="공유 종료"
          >
            <div className="flex items-center gap-2.5 pl-1.5 pr-4 h-12 rounded-full bg-gradient-to-br from-emerald-500 to-green-600 text-white shadow-xl shadow-emerald-500/40 ring-1 ring-white/20">
              <div className="relative w-9 h-9 rounded-full bg-white/15 backdrop-blur flex items-center justify-center">
                <span className="absolute inset-0 rounded-full bg-white/30 animate-ping" />
                <span className="relative w-2 h-2 rounded-full bg-white" />
              </div>
              <div className="text-left leading-none">
                <div className="text-[9px] uppercase tracking-[0.12em] opacity-85 font-semibold">Live</div>
                <div className="text-[13px] font-bold mt-0.5">공유 중 · 종료</div>
              </div>
            </div>
          </button>
        )}

        {/* 공유 활성 배너 */}
        {sosSession && (
          <div className="absolute top-32 left-3 right-16 z-20 bg-blue-500/95 backdrop-blur text-white rounded-xl shadow-lg px-3 py-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-wider opacity-80 leading-none">실시간 동선 공유 중</div>
            </div>
            <button
              onClick={async () => {
                const text = sosSession.otp
                  ? `🛡 반딧불이 · 실시간 동선 공유\n링크: ${sosSession.share_url}\nOTP: ${sosSession.otp}\n(보호자 인증용 · 별도 채널로 전달 권장)\n(2시간 후 자동 만료)`
                  : `🛡 반딧불이 · 실시간 동선 공유\n링크: ${sosSession.share_url}\n(2시간 후 자동 만료)`
                const w = window as any
                if (w.navigator?.share) {
                  try { await w.navigator.share({ title: '반딧불이 동선 공유', text }) } catch {}
                } else if (w.navigator?.clipboard) {
                  try { await w.navigator.clipboard.writeText(text); setSosToast('링크 복사됨') } catch {}
                }
              }}
              className="flex items-center gap-1 bg-white/20 hover:bg-white/30 active:bg-white/40 rounded-lg px-2.5 py-1.5 text-xs font-semibold shrink-0 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>
                <polyline points="16 6 12 2 8 6"/>
                <line x1="12" y1="2" x2="12" y2="15"/>
              </svg>
              공유
            </button>
          </div>
        )}

        {/* 토스트 */}
        {sosToast && (
          <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-30 bg-gray-900/95 text-white text-xs font-medium px-4 py-2.5 rounded-full shadow-xl whitespace-nowrap max-w-[90%]">
            {sosToast}
          </div>
        )}


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
