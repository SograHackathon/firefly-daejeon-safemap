'use client'

import { useEffect, useRef, useState } from 'react'
import { use } from 'react'

type SosView = {
  status: 'active' | 'ended' | 'expired' | 'aborted'
  started_at: string
  ended_at?: string | null
  expires_at: string
  destination_name?: string | null
  last_location?: { lng: number; lat: number } | null
  last_location_at?: string | null
  planned_route?: { type: 'LineString'; coordinates: [number, number][] } | null
  planned_route_label?: string | null
  destination_lng?: number | null
  destination_lat?: number | null
  needs_otp?: boolean       // true 면 OTP 인증 전 — 위치 노출 X
  otp_attempts?: number     // 현재 실패 횟수
}

const DEFAULT_CENTER = { lat: 36.3672, lng: 127.3454 } // 충남대 정문
const POLL_MS = 5000

function formatTime(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function timeAgo(iso?: string | null) {
  if (!iso) return '—'
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}초 전`
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  return `${Math.floor(s / 3600)}시간 전`
}

export default function GuardianSharePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = use(params)

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const pinRef = useRef<any>(null)
  const pathRef = useRef<any>(null)
  const trailRef = useRef<{ lng: number; lat: number }[]>([])
  // 계획 경로 (안내 시작 시 사용자가 선택한 추천 경로) 폴리라인 + 도착지 핀
  const plannedRouteRef = useRef<any>(null)
  const destPinRef = useRef<any>(null)
  const fittedRef = useRef(false)

  const [view, setView] = useState<SosView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  // OTP 검증 상태
  const [otpInput, setOtpInput] = useState('')
  const [otpSubmitting, setOtpSubmitting] = useState(false)
  const [otpError, setOtpError] = useState<string | null>(null)
  const [otpRevoked, setOtpRevoked] = useState(false)
  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    setOtpError(null)
    setOtpSubmitting(true)
    try {
      const r = await fetch(`/api/sos/share/${token}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp: otpInput }),
      })
      if (r.status === 429) {
        setOtpError('너무 많은 시도. 잠시 후 다시 시도해주세요.')
        return
      }
      if (r.status === 403) {
        setOtpRevoked(true)
        setOtpError('OTP 5회 실패로 토큰이 무효화되었습니다.')
        return
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setOtpError(`OTP 불일치 · 남은 시도 ${j.attempts_left ?? 0}회`)
        return
      }
      // 성공 — 즉시 view 재조회 (위치 표시)
      setOtpInput('')
      const refresh = await fetch(`/api/sos/share/${token}`, { cache: 'no-store' })
      if (refresh.ok) setView(await refresh.json())
    } catch {
      setOtpError('네트워크 오류')
    } finally {
      setOtpSubmitting(false)
    }
  }

  // 1초마다 timeAgo 갱신
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // 폴링
  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/sos/share/${token}`, { cache: 'no-store' })
        if (!r.ok) {
          if (r.status === 404) setError('유효하지 않은 링크입니다.')
          else setError(`조회 실패 (${r.status})`)
          return
        }
        const data: SosView = await r.json()
        if (cancelled) return
        setError(null)
        setView(data)
      } catch (e: any) {
        if (!cancelled) setError(e?.message || '네트워크 오류')
      }
    }
    fetchOnce()
    const iv = setInterval(fetchOnce, POLL_MS)
    return () => { cancelled = true; clearInterval(iv) }
  }, [token])

  // 지도 초기화
  useEffect(() => {
    if (!containerRef.current) return
    const w = window as any
    if (!w.kakao || !w.kakao.maps) return
    w.kakao.maps.load(() => {
      const map = new w.kakao.maps.Map(containerRef.current, {
        center: new w.kakao.maps.LatLng(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng),
        level: 4,
      })
      mapRef.current = map
    })
  }, [])

  // 계획 경로 폴리라인 + 도착지 마커 (안내 시작 시 1회만)
  useEffect(() => {
    const map = mapRef.current
    const w = window as any
    if (!map || !view) return

    // planned_route
    if (view.planned_route?.coordinates?.length && !plannedRouteRef.current) {
      const path = view.planned_route.coordinates.map(([lng, lat]: any) =>
        new w.kakao.maps.LatLng(lat, lng)
      )
      // 흰 외곽선
      new w.kakao.maps.Polyline({
        path, strokeWeight: 9, strokeColor: '#ffffff',
        strokeOpacity: 0.95, strokeStyle: 'solid', map, zIndex: 5,
      })
      // 본선 (보라색 — 계획 경로)
      plannedRouteRef.current = new w.kakao.maps.Polyline({
        path, strokeWeight: 6, strokeColor: '#7c3aed',
        strokeOpacity: 0.9, strokeStyle: 'solid', zIndex: 6,
      })
      plannedRouteRef.current.setMap(map)
    }

    // 도착지 핀
    if (view.destination_lng != null && view.destination_lat != null && !destPinRef.current) {
      const pos = new w.kakao.maps.LatLng(view.destination_lat, view.destination_lng)
      const html = `<div style="position:relative;width:32px;height:40px;filter:drop-shadow(0 3px 4px rgba(0,0,0,0.4));">
        <div style="position:absolute;top:0;left:6px;right:6px;bottom:14px;border-radius:50%;background:#e11d48;border:3px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700;">도</div>
        <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:7px solid transparent;border-right:7px solid transparent;border-top:14px solid #e11d48;"></div>
      </div>`
      destPinRef.current = new w.kakao.maps.CustomOverlay({
        position: pos, content: html, yAnchor: 1, xAnchor: 0.5, map, zIndex: 19,
      })
    }

    // 처음 1회: 사용자 위치를 중앙에 두고 줌 확대
    if (!fittedRef.current && view.last_location) {
      map.setLevel(3) // 골목 단위 줌
      map.setCenter(new w.kakao.maps.LatLng(view.last_location.lat, view.last_location.lng))
      fittedRef.current = true
    }
  }, [view])

  // 위치 변경 시 핀 + 이동 경로 그리기
  useEffect(() => {
    const map = mapRef.current
    const w = window as any
    if (!map || !view?.last_location) return

    const { lng, lat } = view.last_location
    const latLng = new w.kakao.maps.LatLng(lat, lng)

    // 이동 경로 누적
    const last = trailRef.current[trailRef.current.length - 1]
    const moved = !last || Math.hypot((last.lng - lng), (last.lat - lat)) > 0.00005 // 약 5m+
    if (moved) trailRef.current.push({ lng, lat })

    // 핀 (적당한 크기 + 옅은 펄스 + 단단한 중앙 도트)
    const pinHtml = `<div style="position:relative;width:26px;height:26px;">
      <div style="position:absolute;inset:0;border-radius:50%;background:rgba(45,126,255,0.2);animation:me-ring 2.4s ease-out infinite;"></div>
      <div style="position:absolute;top:6px;left:6px;width:14px;height:14px;background:#2d7eff;border:2.5px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>
    </div>`
    if (!pinRef.current) {
      pinRef.current = new w.kakao.maps.CustomOverlay({
        position: latLng,
        content: pinHtml,
        yAnchor: 0.5,
        xAnchor: 0.5,
        map,
        zIndex: 20,
      })
    } else {
      pinRef.current.setPosition(latLng)
    }

    // 이동 경로 폴리라인 (활성 상태에서만)
    if (view.status === 'active' && trailRef.current.length >= 2) {
      const path = trailRef.current.map(p => new w.kakao.maps.LatLng(p.lat, p.lng))
      if (pathRef.current) pathRef.current.setMap(null)
      pathRef.current = new w.kakao.maps.Polyline({
        path, strokeWeight: 5, strokeColor: '#2d7eff', strokeOpacity: 0.9, strokeStyle: 'solid'
      })
      pathRef.current.setMap(map)
    }

    // 화면 추적: planned_route 가 있어 이미 bounds fit 됐으면 살짝 panTo 만,
    // 없으면 첫 도착 시 setCenter
    if (!fittedRef.current && trailRef.current.length === 1) {
      map.setCenter(latLng)
    } else if (trailRef.current.length > 1) {
      map.panTo(latLng)
    }
  }, [view])

  const statusInfo = (() => {
    if (!view) return { label: '연결 중', color: 'bg-gray-500', text: '데이터를 받아오는 중입니다.' }
    switch (view.status) {
      case 'active': return { label: '실시간 공유 중', color: 'bg-green-500', text: `매 ${POLL_MS / 1000}초 위치 갱신` }
      case 'ended':  return { label: '도착·종료', color: 'bg-blue-500',  text: '안전하게 종료되었습니다.' }
      case 'expired':return { label: '만료',       color: 'bg-gray-500', text: '세션이 만료되었습니다.' }
      case 'aborted':return { label: '비정상 종료', color: 'bg-red-500', text: '세션이 중단되었습니다.' }
      default:       return { label: view.status,   color: 'bg-gray-500', text: '' }
    }
  })()

  return (
    <div className="w-full h-[100dvh] bg-zinc-900 flex items-center justify-center overflow-hidden">
      <style jsx global>{`
        @keyframes me-ring {
          0% { transform: scale(0.6); opacity: 0.85; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
      <div className="relative w-full h-full md:w-[420px] md:h-[820px] md:rounded-[44px] md:border-[10px] md:border-zinc-800 md:shadow-2xl overflow-hidden bg-white">

        {/* 지도 */}
        <div ref={containerRef} className="absolute inset-0 z-0" />

        {/* 헤더 */}
        <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/55 to-transparent px-4 pt-4 pb-8">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusInfo.color} ${view?.status === 'active' ? 'animate-pulse' : ''}`} />
            <span className="text-white font-semibold text-sm">{statusInfo.label}</span>
            {view?.status === 'active' && (
              <span className="ml-auto text-white/80 text-[11px] font-mono">
                마지막 갱신 {timeAgo(view.last_location_at)}
              </span>
            )}
          </div>
          <h1 className="text-white text-lg font-extrabold mt-1.5 leading-tight">반딧불이 · 실시간 동선 공유</h1>
          <p className="text-white/80 text-xs">{statusInfo.text}</p>
        </div>

        {/* 하단 정보 카드 */}
        <div className="absolute bottom-0 left-0 right-0 z-10 bg-white rounded-t-3xl px-5 pt-3 pb-6 shadow-2xl" style={{ paddingBottom: 'max(20px, env(safe-area-inset-bottom))' }}>
          <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto mb-3" />

          {error ? (
            <div className="text-center py-6">
              <div className="text-red-500 font-bold text-base mb-1">⚠ {error}</div>
              <div className="text-gray-500 text-xs">링크가 만료되었거나 잘못된 주소입니다.</div>
            </div>
          ) : !view ? (
            <div className="text-center py-6 text-gray-500 text-sm">불러오는 중…</div>
          ) : view.needs_otp ? (
            // ============ OTP 입력 (Guardian Auth Lv2) ============
            <div>
              <div className="text-center mb-4">
                <div className="text-3xl mb-2">🔒</div>
                <div className="font-extrabold text-gray-900 text-base">보호자 인증 필요</div>
                <div className="text-gray-500 text-[11px] mt-1 leading-relaxed">
                  토큰 단독으로는 위치 조회 불가.<br/>
                  사용자가 별도로 전달한 <b className="text-gray-700">6자리 OTP</b> 를 입력하세요.
                </div>
              </div>

              {otpRevoked ? (
                <div className="bg-red-50 border border-red-200 text-red-600 text-xs rounded-xl p-3 text-center">
                  ⛔ 5회 실패 — 토큰이 자동 무효화되었습니다.<br/>
                  <span className="text-[10px] text-red-400 mt-1 block">사용자에게 재요청 필요</span>
                </div>
              ) : (
                <form onSubmit={submitOtp} className="space-y-3">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="• • • • • •"
                    className="w-full px-4 py-3.5 text-center text-2xl font-mono font-bold tracking-[0.4em] border-2 border-gray-200 focus:border-pink-400 outline-none rounded-xl bg-white text-gray-900 placeholder:text-gray-300"
                  />
                  {otpError && (
                    <div className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-lg p-2.5">
                      ⚠ {otpError}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={otpInput.length !== 6 || otpSubmitting}
                    className="w-full py-3.5 bg-gradient-to-r from-pink-500 to-red-500 text-white rounded-xl font-bold text-sm disabled:opacity-50 shadow-lg shadow-pink-500/30 active:scale-95 transition-transform"
                  >
                    {otpSubmitting ? '확인 중…' : '인증하기'}
                  </button>
                  <div className="text-[10px] text-gray-400 text-center pt-1">
                    5회 실패 시 토큰 자동 무효화 · 모든 시도 감사 로그
                  </div>
                </form>
              )}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[11px] text-gray-500 mb-0.5">시작</div>
                  <div className="font-bold text-gray-900 text-sm font-mono">{formatTime(view.started_at)}</div>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <div className="text-[11px] text-gray-500 mb-0.5">{view.status === 'active' ? '만료' : '종료'}</div>
                  <div className="font-bold text-gray-900 text-sm font-mono">{formatTime(view.ended_at ?? view.expires_at)}</div>
                </div>
              </div>

              {view.last_location ? (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs">
                  <div className="text-blue-700 font-semibold mb-0.5">📍 마지막 위치</div>
                  <div className="text-gray-700 font-mono text-[11px]">
                    {view.last_location.lat.toFixed(5)}, {view.last_location.lng.toFixed(5)}
                  </div>
                  <div className="text-gray-500 text-[11px] mt-0.5">{timeAgo(view.last_location_at)} · {formatTime(view.last_location_at)}</div>
                </div>
              ) : (
                <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-500 text-center">위치 정보가 아직 없습니다.</div>
              )}

              {view.destination_name && (
                <div className="text-xs text-gray-500 mt-2 text-center">
                  목적지 · <b className="text-gray-700">{view.destination_name}</b>
                </div>
              )}

              {view.planned_route_label && (
                <div className="mt-2 bg-purple-50 border border-purple-200 rounded-xl p-2.5 text-center">
                  <div className="text-[10px] text-purple-500 font-bold tracking-wider uppercase mb-0.5">안내 중인 경로</div>
                  <div className="text-sm font-bold text-purple-700">{view.planned_route_label}</div>
                </div>
              )}

              <div className="text-[10px] text-gray-400 text-center mt-3">
                이 페이지는 발급된 일회용 링크로만 접근할 수 있으며, 만료 후 자동 차단됩니다.
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  )
}
