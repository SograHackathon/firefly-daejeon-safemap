'use client'

import { useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

function LoginInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get('next') || '/'

  const justSignedUp = searchParams.get('signup') === 'success'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}))
        setError(`너무 많은 시도입니다. ${j.retry_after_sec ?? 60}초 후 다시 시도하세요.`)
        return
      }
      if (!r.ok) {
        setError('이메일 또는 비밀번호가 올바르지 않습니다.')
        return
      }
      router.push(next)
      router.refresh()
    } catch {
      setError('네트워크 오류')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full min-h-[100dvh] bg-gradient-to-br from-zinc-950 via-zinc-900 to-black flex items-center justify-center overflow-hidden relative px-4 py-6">
      {/* 배경 글로우 (반딧불이 컨셉) */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 -right-32 w-96 h-96 bg-pink-500/20 rounded-full blur-[120px]" />
        <div className="absolute top-1/3 -left-32 w-96 h-96 bg-amber-400/15 rounded-full blur-[120px]" />
        <div className="absolute -bottom-32 right-1/4 w-80 h-80 bg-green-400/15 rounded-full blur-[120px]" />
        {/* 작은 반딧불이 점들 */}
        <div className="absolute top-[20%] left-[15%] w-1.5 h-1.5 bg-amber-300 rounded-full shadow-[0_0_20px_4px_rgba(252,211,77,0.8)] animate-pulse" />
        <div className="absolute top-[65%] left-[80%] w-1 h-1 bg-pink-300 rounded-full shadow-[0_0_15px_3px_rgba(244,114,182,0.8)] animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-[40%] right-[10%] w-1 h-1 bg-green-300 rounded-full shadow-[0_0_15px_3px_rgba(134,239,172,0.8)] animate-pulse" style={{ animationDelay: '2s' }} />
        <div className="absolute bottom-[20%] left-[30%] w-1.5 h-1.5 bg-yellow-300 rounded-full shadow-[0_0_20px_4px_rgba(253,224,71,0.8)] animate-pulse" style={{ animationDelay: '1.5s' }} />
      </div>

      <div className="relative w-full max-w-sm">
        {/* 카드 */}
        <div className="relative bg-white/95 backdrop-blur-2xl rounded-[28px] p-8 shadow-[0_30px_80px_-15px_rgba(255,93,122,0.4)] border border-white/20">
          <div className="text-center mb-7">
            <div className="relative inline-block mb-4">
              <div className="absolute inset-0 bg-pink-400/30 rounded-3xl blur-2xl scale-110" />
              <img
                src="/firefly-logo.jpeg"
                alt="반딧불이"
                className="relative w-24 h-24 mx-auto rounded-3xl shadow-2xl object-cover ring-4 ring-white/50"
              />
            </div>
            <h1 className="text-3xl font-extrabold bg-gradient-to-r from-pink-500 via-red-500 to-amber-500 bg-clip-text text-transparent">
              반딧불이
            </h1>
            <p className="text-[11px] text-gray-500 mt-1 tracking-wide">
              어두운 골목에 켜지는 작은 불빛
            </p>
          </div>

          {justSignedUp && (
            <div className="mb-3 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg p-3 flex items-start gap-2">
              <span>✓</span><span>회원가입이 완료되었습니다. 로그인해주세요.</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1 mb-1 block">
                Email
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">✉</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  placeholder="user@example.com"
                  className="w-full pl-9 pr-3 py-3 border-2 border-gray-200 focus:border-pink-400 outline-none rounded-xl text-sm bg-white text-gray-900 placeholder:text-gray-400 transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold text-gray-500 uppercase tracking-widest ml-1 mb-1 block">
                Password
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔒</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className="w-full pl-9 pr-3 py-3 border-2 border-gray-200 focus:border-pink-400 outline-none rounded-xl text-sm font-mono bg-white text-gray-900 placeholder:text-gray-400 transition-colors"
                />
              </div>
            </div>

            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                <span>⚠</span><span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full p-3.5 bg-gradient-to-r from-pink-500 to-red-500 text-white rounded-xl font-bold text-sm active:scale-95 disabled:opacity-50 shadow-lg shadow-pink-500/30 transition-transform"
            >
              {loading ? '로그인 중…' : '로그인'}
            </button>
          </form>

          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-[10px] text-gray-400 uppercase tracking-widest">or</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>

          <Link
            href="/auth/signup"
            className="block w-full p-3.5 text-center border-2 border-gray-200 text-gray-700 rounded-xl font-bold text-sm active:bg-gray-50 transition-colors"
          >
            새 계정 만들기
          </Link>
        </div>

      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">로딩…</div>}>
      <LoginInner />
    </Suspense>
  )
}
