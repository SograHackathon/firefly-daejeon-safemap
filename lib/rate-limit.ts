/**
 * 메모리 기반 3계층 Rate Limit
 * (해커톤 시연용 — 운영 시 Upstash Redis 로 교체)
 *
 * Sliding window 알고리즘.
 * 키 패턴:
 *   ip:<addr>            (계층 1)
 *   login:<email>         (계층 2 — BruteForce 방어)
 *   action:<action>:<id>  (계층 3 — 민감 작업)
 */

type Bucket = { count: number; resetAt: number }
const STORE = new Map<string, Bucket>()

// 주기적 cleanup (만료된 엔트리 삭제)
let cleanupTimer: ReturnType<typeof setInterval> | null = null
function ensureCleanup() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of STORE.entries()) {
      if (v.resetAt < now) STORE.delete(k)
    }
  }, 60_000)
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    (cleanupTimer as any).unref?.()
  }
}

export type LimitResult = {
  ok: boolean
  limit: number
  remaining: number
  resetAt: number
  retryAfterSec: number
}

export function checkLimit(key: string, max: number, windowMs: number): LimitResult {
  ensureCleanup()
  const now = Date.now()
  const existing = STORE.get(key)
  if (!existing || existing.resetAt < now) {
    STORE.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, limit: max, remaining: max - 1, resetAt: now + windowMs, retryAfterSec: 0 }
  }
  existing.count += 1
  const remaining = Math.max(0, max - existing.count)
  const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000)
  return {
    ok: existing.count <= max,
    limit: max,
    remaining,
    resetAt: existing.resetAt,
    retryAfterSec,
  }
}

// 계층별 헬퍼 — 정책은 README/기획안 그대로
export const RATE = {
  // 계층 1: IP 단위 일반 — 10분당 100회
  ip: (ip: string) => checkLimit(`ip:${ip}`, 100, 10 * 60_000),
  // 계층 2: 계정 로그인 — 5회 / 10분
  login: (email: string) => checkLimit(`login:${email}`, 5, 10 * 60_000),
  // 계층 3: 민감 작업 — 1분당 3회
  action: (action: string, id: string) =>
    checkLimit(`action:${action}:${id}`, 3, 60_000),
}

// Response 만드는 헬퍼
export function tooManyResponse(r: LimitResult) {
  return new Response(
    JSON.stringify({ error: 'too_many_requests', retry_after_sec: r.retryAfterSec }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(r.retryAfterSec),
        'X-RateLimit-Limit': String(r.limit),
        'X-RateLimit-Remaining': String(r.remaining),
      },
    }
  )
}

export function getClientIp(req: Request): string {
  const xf = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (xf) return xf
  const cf = req.headers.get('cf-connecting-ip')
  if (cf) return cf
  return 'unknown'
}
