'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function SignupPage() {
  const router = useRouter()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [phone, setPhone] = useState('')
  const [displayName, setDisplayName] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 휴대폰 자동 포맷
  const onPhoneChange = (raw: string) => {
    const d = raw.replace(/[^0-9]/g, '').slice(0, 11)
    setPhone(d)
  }
  const phoneFormatted = (() => {
    if (phone.length < 4) return phone
    if (phone.length < 8) return `${phone.slice(0, 3)}-${phone.slice(3)}`
    if (phone.length === 10) return `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`
    return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`
  })()

  // 검증
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  const pwStrength = (() => {
    if (password.length === 0) return null
    const hasLen = password.length >= 10
    const hasLower = /[a-z]/.test(password)
    const hasUpper = /[A-Z]/.test(password)
    const hasNum = /[0-9]/.test(password)
    const hasSpec = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)
    const passed = [hasLen, hasLower, hasUpper, hasNum, hasSpec].filter(Boolean).length
    return { hasLen, hasLower, hasUpper, hasNum, hasSpec, passed }
  })()
  const pwOk = !!(pwStrength && pwStrength.passed === 5)
  const pwMatch = password.length > 0 && password === passwordConfirm
  const phoneOk = /^01[0-9]\d{7,8}$/.test(phone)

  // 활성화 단계 — 이메일 형식 OK → 비번 활성, 비번 5조건 → 재입력 활성, 일치 → 휴대폰 활성
  const canEditPassword = emailValid
  const canEditPasswordConfirm = emailValid && pwOk
  const canEditPhone = emailValid && pwOk && pwMatch
  const canSubmit = emailValid && pwOk && pwMatch && phoneOk

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setError(null); setLoading(true)
    try {
      const r = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          password_confirm: passwordConfirm,
          phone,
          display_name: displayName || undefined,
        }),
      })
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}))
        setError(`너무 많은 시도입니다. ${j.retry_after_sec ?? 60}초 후 재시도하세요.`)
        return
      }
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(j.issues?.[0] || j.detail || j.error || '가입 실패')
        return
      }
      // 가입 완료 → 로그인 페이지로 (자동 로그인 X · 본인 인증 후 직접 로그인)
      router.push('/auth/login?signup=success')
    } catch {
      setError('네트워크 오류')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full min-h-[100dvh] bg-gradient-to-br from-pink-50 via-amber-50 to-yellow-50 flex items-start justify-center overflow-y-auto py-8 px-4">
      <div className="relative w-full max-w-sm">
        <div className="text-center mb-5">
          <div className="inline-block relative mb-3">
            <div className="absolute inset-0 bg-pink-300/40 rounded-2xl blur-2xl scale-110" />
            <img src="/firefly-logo.jpeg" alt="반딧불이"
              className="relative w-16 h-16 mx-auto rounded-2xl shadow-xl object-cover ring-4 ring-white" />
          </div>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">SOGRA · ARGOS</div>
          <h1 className="text-2xl font-extrabold text-gray-900 leading-tight">반딧불이 시작하기</h1>
          <p className="text-xs text-gray-600 mt-1">단계별 정보 입력으로 안전하게</p>
        </div>

        {/* 진행 도트 */}
        <div className="flex items-center justify-center gap-2 mb-5">
          <span className={`w-7 h-2 rounded-full transition-colors ${emailValid ? 'bg-pink-500' : 'bg-gray-300'}`} />
          <span className={`w-7 h-2 rounded-full transition-colors ${pwOk && pwMatch ? 'bg-amber-500' : 'bg-gray-300'}`} />
          <span className={`w-7 h-2 rounded-full transition-colors ${phoneOk ? 'bg-green-500' : 'bg-gray-300'}`} />
        </div>

        <form onSubmit={onSubmit} className="bg-white rounded-3xl p-6 shadow-2xl border border-white space-y-5">
          {/* 1. 이메일 */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-6 h-6 rounded-full text-white text-[11px] font-extrabold flex items-center justify-center transition-colors ${emailValid ? 'bg-pink-500' : 'bg-gray-300'}`}>
                {emailValid ? '✓' : '1'}
              </span>
              <span className="text-sm font-bold text-gray-900">이메일</span>
              <span className="text-[10px] text-gray-400 ml-1">로그인 ID</span>
            </div>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              required autoComplete="email"
              placeholder="user@example.com"
              className="w-full p-3 border-2 border-gray-200 focus:border-pink-400 outline-none rounded-xl text-sm bg-white text-gray-900 placeholder:text-gray-400 transition-colors"
            />
          </div>

          {/* 2. 비밀번호 */}
          <div className={canEditPassword ? '' : 'opacity-40 pointer-events-none select-none'}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-6 h-6 rounded-full text-white text-[11px] font-extrabold flex items-center justify-center transition-colors ${pwOk && pwMatch ? 'bg-amber-500' : 'bg-gray-300'}`}>
                {pwOk && pwMatch ? '✓' : '2'}
              </span>
              <span className="text-sm font-bold text-gray-900">비밀번호</span>
              <span className="text-[10px] text-gray-400 ml-1">bcrypt + 5조건</span>
              {!canEditPassword && (
                <span className="text-[10px] text-gray-400 ml-auto">🔒 이메일 입력 후</span>
              )}
            </div>
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required disabled={!canEditPassword} autoComplete="new-password"
              placeholder="••••••••••" minLength={10} maxLength={72}
              className="w-full p-3 border-2 border-gray-200 focus:border-amber-400 outline-none rounded-xl text-sm font-mono bg-white text-gray-900 placeholder:text-gray-400 transition-colors disabled:bg-gray-50"
            />
            {pwStrength && (
              <>
                <div className="flex gap-1 mt-2">
                  {[0, 1, 2, 3, 4].map(i => (
                    <div key={i} className={`flex-1 h-1.5 rounded ${
                      i < pwStrength.passed
                        ? pwStrength.passed <= 2 ? 'bg-red-400'
                        : pwStrength.passed <= 3 ? 'bg-amber-400'
                        : pwStrength.passed === 4 ? 'bg-yellow-400' : 'bg-green-500'
                        : 'bg-gray-200'
                    }`} />
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  <span className={pwStrength.hasLen ? 'text-green-600 font-semibold' : 'text-gray-400'}>{pwStrength.hasLen ? '✓' : '○'} 10자 이상</span>
                  <span className={pwStrength.hasLower ? 'text-green-600 font-semibold' : 'text-gray-400'}>{pwStrength.hasLower ? '✓' : '○'} 영문 소문자</span>
                  <span className={pwStrength.hasUpper ? 'text-green-600 font-semibold' : 'text-gray-400'}>{pwStrength.hasUpper ? '✓' : '○'} 영문 대문자</span>
                  <span className={pwStrength.hasNum ? 'text-green-600 font-semibold' : 'text-gray-400'}>{pwStrength.hasNum ? '✓' : '○'} 숫자</span>
                  <span className={pwStrength.hasSpec ? 'text-green-600 font-semibold' : 'text-gray-400'}>{pwStrength.hasSpec ? '✓' : '○'} 특수문자 !@#$</span>
                </div>
                <div className="text-[10px] text-gray-400 mt-1">이메일/휴대폰 포함 X, 같은 문자 3연속 X</div>
              </>
            )}

            {/* 비밀번호 재입력 */}
            <div className={`mt-3 ${canEditPasswordConfirm ? '' : 'opacity-50 pointer-events-none'}`}>
              <input
                type="password" value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                disabled={!canEditPasswordConfirm} autoComplete="new-password"
                placeholder="비밀번호 재입력"
                className={`w-full p-3 border-2 outline-none rounded-xl text-sm font-mono bg-white text-gray-900 placeholder:text-gray-400 transition-colors disabled:bg-gray-50 ${
                  passwordConfirm.length === 0 ? 'border-gray-200 focus:border-amber-400'
                  : pwMatch ? 'border-green-300 bg-green-50/30 focus:border-green-500'
                  : 'border-red-300 bg-red-50/30 focus:border-red-500'
                }`}
              />
              {passwordConfirm.length > 0 && (
                <div className={`mt-1 text-[11px] flex items-center gap-1 ${pwMatch ? 'text-green-600 font-semibold' : 'text-red-500'}`}>
                  {pwMatch ? '✓ 일치' : '✗ 비밀번호 불일치'}
                </div>
              )}
            </div>
          </div>

          {/* 3. 휴대폰 */}
          <div className={canEditPhone ? '' : 'opacity-40 pointer-events-none select-none'}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-6 h-6 rounded-full text-white text-[11px] font-extrabold flex items-center justify-center transition-colors ${phoneOk ? 'bg-green-500' : 'bg-gray-300'}`}>
                {phoneOk ? '✓' : '3'}
              </span>
              <span className="text-sm font-bold text-gray-900">휴대폰</span>
              <span className="text-[10px] text-pink-500 font-semibold ml-1">🚨 SOS 연동</span>
              {!canEditPhone && (
                <span className="text-[10px] text-gray-400 ml-auto">🔒 비밀번호 일치 후</span>
              )}
            </div>
            <input
              type="tel" inputMode="numeric"
              value={phoneFormatted}
              onChange={(e) => onPhoneChange(e.target.value)}
              required disabled={!canEditPhone}
              placeholder="010-1234-5678"
              className="w-full p-3 border-2 border-gray-200 focus:border-green-400 outline-none rounded-xl text-sm font-mono tracking-wider bg-white text-gray-900 placeholder:text-gray-400 transition-colors disabled:bg-gray-50"
            />
            <div className="text-[10px] text-gray-500 mt-1.5">SOS 발신 시 본인 식별용 · 암호화 저장</div>
          </div>

          {/* 표시이름 (선택) */}
          <div className={canEditPhone ? '' : 'opacity-40 pointer-events-none'}>
            <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1 mb-1 block">
              표시 이름 <span className="text-gray-300 font-normal normal-case">(선택)</span>
            </label>
            <input
              type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value.slice(0, 40))}
              placeholder="홍길동" maxLength={40} disabled={!canEditPhone}
              className="w-full p-3 border-2 border-gray-100 focus:border-gray-300 outline-none rounded-xl text-sm bg-white text-gray-900 placeholder:text-gray-400 transition-colors disabled:bg-gray-50"
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
              <span>⚠</span><span>{error}</span>
            </div>
          )}

          <button
            type="submit" disabled={loading || !canSubmit}
            className={`w-full p-3.5 rounded-xl font-bold text-sm active:scale-95 transition-all shadow-lg ${
              canSubmit
                ? 'bg-gradient-to-r from-pink-500 via-red-500 to-amber-500 text-white shadow-pink-500/30'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            {loading ? '가입 중…' : canSubmit ? '🚀 반딧불이 시작' : '모든 단계 완료 후 가입'}
          </button>
        </form>

        <div className="text-center mt-4">
          <Link href="/auth/login" className="text-xs text-gray-600">
            이미 계정이 있나요? <span className="text-pink-500 font-bold ml-1">로그인</span>
          </Link>
        </div>

        <div className="text-center mt-3">
          <p className="text-[10px] text-gray-400">🔐 bcrypt · HttpOnly · Rate Limit · 흔한비번 차단</p>
        </div>
      </div>
    </div>
  )
}
