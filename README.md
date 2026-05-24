# 반딧불이 · 대전 안심맵

> 카카오맵이 빠른 길을 알려준다면, **반딧불이는 안전한 길**을 알려준다.

대전 공공 안전 인프라(CCTV · 보안등 · 안전비상벨 · 24시간 편의점 · 보행자 사고다발지점)를
실시간으로 융합해 보행자 야간 귀가의 안심 경로를 추천하는 **PWA 웹앱**.

🌐 **데모:** https://firefly-daejeon-safemap.vercel.app

---

## 핵심 기능

| 기능 | 설명 |
|---|---|
| **메인 지도** | 카카오맵 + 5종 인프라 칩 (CCTV / 가로등 / 비상벨 / 편의점 / 사고다발), 줌별 동적 로드 |
| **현 위치 안전점수** | 사용자 위치 반경 50m 시설 카운트 기반 0~100점 + 50m 실거리 펄스 |
| **장소 검색** | 카카오 Places API 프록시 + 최근 검색 (localStorage) |
| **지도 POI 클릭** | 카카오 카테고리 13종 + 키워드 7종 병렬 검색 → 15m 임계값 매칭 |
| **길찾기 (Tmap)** | 출/도착 자유 입력, 현 위치 reverse geocoding, 출/도착 도중 수정 가능 |
| **안심 경로 v2 알고리즘** | Tmap 보행자 + PostGIS 핫스팟 + deLoop 정리 → 최대 5개 후보 비교 |
| **드래그 가능 시트** | 경로 후보 카드 시트를 8vh ~ 92vh 자유 드래그 |
| **안내 시작 + 동선공유** | 안내 중 별도 [보호자에 공유] → SOS 토큰 + OTP 발급 |
| **보호자 실시간 페이지** | `/sos/share/[token]` — PIN 인증 후 실시간 위치 polling |
| **긴급 SOS** | 112 · 119 · 1366 tel: 딥링크 모달 |

---

## 안심 경로 알고리즘 v2 (KILLER)

기존 단순 라우팅: "최단 경로 1개"
반딧불이: **"5개 후보 — 빠른 / 안심 / 밝은 / CCTV / 우회"**

### 4단계 파이프라인

```
[STEP 1] Tmap 빠른 길 (실패 시 OSRM 폴백)
            ↓
[STEP 2] 직선 chunk 샘플링 (출발-도착 균등 분할 N점)
            거리별 동적: <800m=2, <2km=3, <4km=4, else 5
            ↓
[STEP 3] 각 chunk 점 → safety_hotspots RPC 병렬 호출
            balanced + night 두 모드 동시
            상위 N개 dedup + 거리비례 필터 (왕복 방지)
            ↓
[STEP 4] 핫스팟별 Tmap 경유 라우팅 (병렬)
            → 결과 cleanRoute (deLoop)로 자기근접 루프 제거
            → route_safety RPC 점수 계산
            → 상위 5개 반환 + 추천(BEST) 1개
```

### deLoop 알고리즘 (돌출 우회 제거)

경로상의 두 점 Pi, Pj 가:
- 직선거리 < 25m
- 사이 누적 경로 ≥ 120m

→ Pi+1 ~ Pj-1 잘라냄. V/T 자 모양 detour만 제거, 일반 골목은 영향 X.

### 가중치 (route_safety RPC v2)

```
가산 (base=0):
  가로등  최대 +35 (야간 가중 ×1.5)
  편의점  최대 +28 (24h × 2)
  비상벨  최대 +22
  CCTV    최대 +15

페널티:
  사고다발  -60 + 사상자 -20  (야간 ×1.5)

→ 최종 = clamp(0, 100)
```

---

## 사용 데이터 (실제 적재)

| 데이터 | 건수 | 출처 |
|---|---|---|
| 대전 방범 CCTV | **2,984** | 공공데이터포털 15109459 |
| 대전 보안등 | **30,005** | 자치구별 CSV 5종 |
| 안전비상벨 | **205** | 행정안전부 1741000 |
| 편의점 (24h 1,368) | **1,429** | 카카오 로컬 카테고리 그리드 |
| 보행자 사고다발 | **27** | KOROAD 오픈 API |

**총 시설 34,650건 + 사고다발 27건.**

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| 프론트 | Next.js 16 (App Router) · React 19 · TypeScript · TailwindCSS 4 |
| 지도 | Kakao Maps JavaScript SDK |
| 라우팅 | Tmap 보행자 API · OSRM 폴백 |
| DB | **Supabase PostgreSQL 15 + PostGIS** |
| 인증 | Supabase Auth (bcrypt + JWT + HttpOnly 쿠키) |
| 검색 | Kakao Places + Reverse Geocoding |
| 좌표변환 | proj4js (EPSG 5174/5179/5181 ↔ 4326) |
| 배포 | Vercel (자동 빌드) |

---

# 🔐 보안 설계 (9대 위협 × 다층 방어)

기획서 보안 평가 40점 배점에 맞춰 **9대 위협 대응** + **이중 방어선** + **공격 시연 영상** 준비.

## 🛡 3계층 아키텍처 — BFF + RLS + DB

```
[Client (브라우저)]
  · anon publishable key (도메인 제한된 키만)
  · NEXT_PUBLIC_ 접두사 환경변수만
        ↓
[Next.js BFF (Vercel)]
  · Zod 입력 검증 (모든 API)
  · Rate Limit (3계층 sliding window)
  · isomorphic-dompurify (XSS sanitize)
  · service_role secret key 사용 (서버 환경변수만)
  · 감사 로그 (audit_log)
        ↓
[Supabase PostgreSQL + PostGIS]
  · RLS (Row Level Security) 20개 정책
  · Prepared Statement 강제 (PostgREST)
  · bcrypt 비밀번호 해시
```

**핵심 원칙:**
1. 클라이언트는 Supabase 직접 호출 X — 모든 요청 BFF 경유
2. BFF가 뚫려도 RLS가 막고, RLS 실수면 BFF가 막는다 (이중 방어)
3. service_role 키는 서버 환경변수만 (Git/브라우저 절대 X)

## 9대 위협 대응 매트릭스

| # | 위협 | 대응 방식 | 시연 |
|---|---|---|---|
| 1 | **SQL Injection** | Supabase PostgREST Prepared Statement + Zod 입력 검증 | `admin' OR 1=1--` 입력 → 400 |
| 2 | **BruteForce 로그인** | 3계층 Rate Limit (IP / 액션 / 계정 sliding window) | 6회 시도 → 429 차단 |
| 3 | **XSS** | isomorphic-dompurify sanitize + CSP `script-src` 화이트리스트 | `<script>` 입력 → 텍스트 무력화 |
| 4 | **CSRF** | SameSite=Strict + HttpOnly 쿠키 | 외부 origin POST → 차단 |
| 5 | **IDOR · 권한 우회** | RLS `auth.uid() = user_id` + BFF JWT 재검증 | 타인 user_id 조회 → `[]` |
| 6 | **위치정보 노출** | 50m 그리드 익명화 (시민 제보) · EXIF strip (예정) | k-익명화 정책 |
| 7 | **보호자 동선 무단 조회** | 32바이트 토큰 + SHA-256 hash + OTP 6자리 + 5회 실패 시 토큰 폐기 + 2h 자동 만료 | 무차별 토큰 → null |
| 8 | **API 키 유출** | Kakao REST / Tmap / KOROAD / service_role → 서버 환경변수 전용 | Network 탭 미노출 |
| 9 | **보안 헤더 미흡** | CSP · HSTS · X-Frame · Referrer · Permissions · COOP · X-Content-Type | securityheaders.com A 이상 |

## 인증 / 세션 보안

| 항목 | 구현 |
|---|---|
| 비밀번호 정책 | **12자 이상** + 영문 대/소문자 + 숫자 + 특수문자 + 흔한 비밀번호 차단 (15개) + 이메일 포함 X + 반복 문자 차단 |
| 비밀번호 저장 | bcrypt (Supabase Auth 표준) |
| 세션 쿠키 | **HttpOnly · Secure(prod) · SameSite=Strict** |
| Access Token | 1시간 (Supabase 기본) |
| Refresh Token | 1주 자동 회전 (proxy.ts에서 매 요청마다) |
| 이메일 enumeration 방어 | 가입 실패 응답 일반화 |
| 비밀번호 노출 차단 | `Prevent use of leaked passwords` (Supabase Pro — 옵션) |

## DB 보안 (Supabase RLS)

**14개 테이블 + 20개 RLS 정책:**

```sql
-- 본인 데이터만 SELECT/UPDATE
CREATE POLICY "sos_select_self" ON sos_sessions FOR SELECT
  USING (auth.uid() = user_id);

-- guardian_links: 본인 SOS의 링크만
CREATE POLICY "glinks_select_owner" ON guardian_links FOR SELECT
  USING (sos_id IN (SELECT id FROM sos_sessions WHERE auth.uid() = user_id));

-- audit_log: anon/authenticated 차단 (service_role 만)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
-- (정책 없음 = deny by default)
```

## 보안 헤더 (next.config.ts)

```
Content-Security-Policy: default-src 'self'; script-src 'self' ... (Kakao/Supabase 화이트리스트)
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), payment=(), usb=(), geolocation=(self)
```

## 보호자 동선공유 보안 (3중 방어)

```
1. 토큰: crypto.randomBytes(24) → base64url 32자 → 2^192 조합
2. DB 저장: sha256(token) 만 (raw token 저장 X)
3. OTP: 6자리 숫자 (별도 채널) + 5회 실패 시 token revoke + 2h 자동 만료
```

→ 카톡 URL 캡처돼도 OTP 없으면 무용. URL + OTP 동시 탈취 = 사실상 불가능.

## 감사 로그 (audit_log)

모든 민감 액션이 `audit_log` 테이블에 기록:

| action | 기록 시점 |
|---|---|
| `auth.signin` / `signup` / `signout` | 로그인 이벤트 |
| `auth.signin.fail` | 실패한 로그인 |
| `sos_start` / `sos_end` | SOS 세션 |
| `tracking.verify.success` / `.fail` / `.locked` | OTP 검증 |

각 row: `user_id`, `action`, `ip`, `user_agent`, `meta (jsonb)`, `created_at`.

→ 공격 시도 후 audit_log 보면 모든 흔적 남음. 시연 시 "이런 공격 시도는 다 기록돼요" 보여주기.

---

## API 엔드포인트

### Auth
- `POST /api/auth/signup` — 이메일/비밀번호 회원가입 (강력 정책)
- `POST /api/auth/login` — 로그인 (rate limit)
- `POST /api/auth/logout` — 로그아웃
- `GET /api/auth/me` — 현재 사용자 정보

### Map / Place
- `GET /api/search?q=...` — 카카오 Places 프록시
- `GET /api/place-at?lng=&lat=` — 클릭 좌표 15m 이내 POI 매칭
- `GET /api/reverse-geocode?lng=&lat=` — 좌표 → 주소

### Route
- `POST /api/route` — 안심 경로 (5개 후보)

### SOS / 동선공유
- `POST /api/sos/start` — 세션 시작 + 토큰/OTP 발급
- `POST /api/sos/heartbeat` — 위치 ping (5초마다)
- `POST /api/sos/end` — 세션 종료
- `GET /api/sos/share/[token]` — 보호자 조회
- `POST /api/sos/share/[token]/verify` — OTP 인증

### Reports
- `POST /api/reports` — 시민 제보 (DOMPurify sanitize + 50m 그리드)

---

## 디렉터리 구조

```
app/
├── app/
│   ├── api/
│   │   ├── auth/              # 회원가입 / 로그인 / 로그아웃 / me
│   │   ├── sos/               # SOS 동선공유 (start/heartbeat/end/share)
│   │   ├── place-at/          # 좌표 → POI 매칭
│   │   ├── reports/           # 시민 제보 (sanitize)
│   │   ├── route/             # 안심 경로 알고리즘 v2
│   │   ├── search/            # 카카오 Places 프록시
│   │   └── reverse-geocode/   # 좌표 → 주소
│   ├── auth/
│   │   ├── login/             # 로그인 페이지
│   │   └── signup/            # 회원가입 페이지 (실시간 정책 검증)
│   └── sos/share/[token]/     # 보호자 실시간 페이지
├── components/
│   ├── MapView.tsx            # 메인 지도 + 칩 + SOS / 안내 / 동선공유
│   ├── SearchPanel.tsx        # 검색/길찾기/경로 4모드 + 시트 드래그 + 검색이력
│   ├── SOSModal.tsx           # 긴급 통화 모달 (112/119/1366)
│   ├── TrackingShareModal.tsx # 동선공유 시작 모달 (deprecated, 친구 코드 SOS로 통일)
│   └── ...
├── lib/
│   ├── rate-limit.ts          # 3계층 sliding window
│   ├── supabase-browser.ts    # 브라우저 클라이언트 (anon)
│   ├── supabase-server.ts     # 서버 클라이언트 (service_role)
│   └── tmap.ts                # Tmap 보행자 라우팅
├── sql/
│   ├── 01_schema.sql          # 14 테이블 + PostGIS
│   ├── 02_rls.sql             # 20 RLS 정책
│   ├── 03_rpc.sql             # 5종 RPC (point_safety / route_safety_default / safety_hotspots / points_in_bbox / danger_in_bbox)
│   ├── 04_sos_route.sql       # sos_sessions 컬럼 추가
│   └── 05_sos_otp.sql         # 보호자 OTP
├── middleware.ts              # 세션 갱신 + 인증 가드 + Supabase auth refresh
├── next.config.ts             # 보안 헤더 9종 + CSP 화이트리스트
└── proxy.ts                   # (Next 16 deprecated middleware 호환)
```

---

## 알려진 한계

1. **카카오 도보 길찾기 API** 일반 키 불가 → Tmap 채택
2. **CCTV 시야각 데이터 없음** — 균등 반경 가정의 한계
3. **사각지대 (blindspots) 표시 안 함** — CCTV 시야각 데이터 부재로 정확도 낮음 → 의도적 제거
4. **iOS Safari 백그라운드 GPS 제한** — SOS 동선 공유 시 화면 켜둬야 함 (PWA 한계)
5. **카카오 OAuth 미적용** — `account_email` scope에 카카오 비즈 인증 필요 (해커톤 기간 X) → 이메일 인증으로 대체
6. **Supabase 무료 메일 시간당 3건** — 시연용 충분, 실서비스는 Resend SMTP 연동 권장

---

## 발표 시연 동선 (5분)

```
[0:00 ~ 0:30] 문제 정의 — 야간 보행자 위험 (대전 사고 통계)
[0:30 ~ 1:30] 데모: 검색 → 안심 경로 비교 → 안내 → 보호자 공유
[1:30 ~ 2:30] PostGIS 알고리즘 — 5개 후보 생성 흐름
[2:30 ~ 3:30] 데이터 적재 — 34,650건 + 카카오 그리드 검색 트릭
[3:30 ~ 4:00] 보안 설계 — BFF + RLS 이중 방어
[4:00 ~ 5:00] 🎬 공격 시연 영상 — 9대 위협 모두 차단
```

---

## TEAM ARGOS

스마트시티 + 야간 보행자 안전. 시민이 체감하는 보안 서비스.

**SOGRA Hackathon 2026**
