# 반딧불이 — 대전 안심맵

> 카카오맵이 빠른 길을 알려준다면, 반딧불이는 **안전한 길**을 알려준다.

SOGRA Hackathon 2026 · ARGOS 출품작.
대전 공공 안전 인프라(CCTV · 보안등 · 안전비상벨 · 24시간 편의점 · 보행자 사고다발지점)를
실시간으로 융합해 보행자 야간 귀가의 안심 경로를 추천하는 PWA 웹앱.

---

## 핵심 기능

| 기능 | 설명 |
|---|---|
| **메인 지도** | 카카오맵 위에 5종 인프라 칩 토글, 줌별 동적 로드 |
| **현 위치 안전점수** | 사용자 위치 반경 50m 시설 카운트 기반 실시간 0~100점 |
| **장소 검색** | 카카오 Places API + 결과 클릭 → 핀 + 카드 + [출발/도착] |
| **길찾기 (Tmap)** | 출발/도착 양쪽 자유 입력, 현 위치 자동 reverse geocoding |
| **안심 경로 알고리즘** | Tmap 보행자 라우팅 + PostGIS 폴리라인 청킹 + 안전 핫스팟 우회 |
| **점수 비교 카드** | 후보 3개 통합 (시간 / 거리 / 안심점수 / 시설 카운트 / 위험구역) |

---

## 안심 경로 알고리즘 (핵심 KILLER)

기존 단순 라우팅: "출발 → 도착 최단 경로 1개"
반딧불이: **"빠른 길 폴리라인 위 청킹 → 각 구간 안전 핫스팟 발굴 → 다중 후보 비교"**

### 4단계 파이프라인

#### STEP 1. 빠른 길 우선 라우팅
Tmap 보행자 라우팅 API 로 최단 경로 1개 수신. 실패 시 OSRM 폴백.

#### STEP 2. 폴리라인 위 거리 기반 동적 청킹
빠른 길 실거리에 따라 청킹 간격·검색 반경이 자동 조정:

| 빠른 길 거리 | 청킹 간격 | 검색 반경 |
|---|---|---|
| ~800m | 300m | 250m |
| 800m~2km | 500m | 350m |
| 2~4km | 800m | 450m |
| 4km+ | 1.2km | 550m |

폴리라인 누적거리 기준 **출발 15% ~ 도착 75%** 구간만 샘플링 (왕복 경로 방지).

#### STEP 3. 청킹 점별 PostGIS 핫스팟 발굴
각 청킹 점에서 `safety_hotspots` RPC 병렬 호출. 격자별 안전점수:

```
점수 = CCTV(120m)×2.0 + 비상벨(250m)×5.0 + 보안등(50m)×0.5
       (야간) + 24h 편의점(150m)×6.0
```

청킹 점당 상위 1개씩 → 좌표 4자리 dedup → 거리 비례 필터:
- 도착지 `max(120, min(350, directDist × 0.20))` m 이내 핫스팟 drop
- 출발지 `max(80, min(200, directDist × 0.12))` m 이내 핫스팟 drop

점수순 상위 N개 채택 (`< 1.5km → 3개, < 4km → 4개, else 5개`).

#### STEP 4. 안심 후보 라우팅 + 최종 선정
각 핫스팟을 Tmap 경유지로 박아 병렬 호출 → 후보 경로 N개.
세 가지 안전망:

1. **왕복 검증** — 결과 경로의 중간점이 도착지 80m 이내 통과 시 drop (출발 직후·도착 직전 4점 제외)
2. **거리 필터** — 빠른 길 × 1.6배 초과 drop
3. **중복 제거** — 좌표 평균 50m 이내 비슷한 경로 dedup

PostGIS `route_safety` RPC 로 각 후보 점수 계산 → 내림차순 정렬 → 상위 3개 반환.
1위에 `recommended: true` 배지.

### 안심 점수 계산 (route_safety RPC)

경로 폴리라인 100m 버퍼 내 시설 카운트 (PostGIS `ST_Buffer` + `ST_Intersects`):

```
가중치 (기본):
  CCTV    0.28
  보안등  0.22
  비상벨  0.15
  편의점  0.15
  사고다발 0.13 (사상자 수 비례 페널티)
  시간대   0.07

야간 (20~06시) 보정:
  보안등 × 1.5
  편의점 × 1.3
  사고   × 1.5

가로등 데이터 없으면 가중치 0 + 다른 인자에 자동 재분배
```

각 인자 정규화 → 가중합 × 100 → 0~100 점수.

---

## 사용 데이터 (실제 적재)

| 데이터 | 건수 | 출처 |
|---|---|---|
| 대전 방범 CCTV | 2,984 | 공공데이터포털 15109459 |
| 대전 보안등 | 30,005 | 자치구별 CSV 5종 (서구/동구/중구/유성구/대덕구) |
| 안전비상벨 | 205 | 행정안전부 1741000 |
| 편의점 (24h 1,368) | 1,429 | 카카오 로컬 카테고리 그리드 검색 |
| 보행자 사고다발 | 27 | KOROAD 오픈 API |

**총 시설 34,650건 + 사고다발 27건.**

---

## 기술 스택

| 레이어 | 기술 |
|---|---|
| 프론트 | Next.js 16 (App Router) · React 19 · TypeScript · TailwindCSS 4 |
| 지도 | Kakao Maps JavaScript SDK |
| 라우팅 | Tmap 보행자 API · OSRM 폴백 |
| DB | Supabase PostgreSQL + **PostGIS** |
| 인증 | Supabase Auth (예정) |
| 검색 | Kakao Places + Reverse Geocoding |
| 좌표변환 | proj4js (EPSG 5174/5179/5181 ↔ 4326) |
| 데이터 | csv-parse · dotenv · zod |

---

## 보안 설계

- **BFF 패턴** — 모든 외부 API/DB 접근은 Next.js Route Handler 경유
- **Supabase RLS** — 14 테이블 + 20 정책 (anon 기본 SELECT, 본인 데이터만 UPDATE)
- **API 키 분리** — 클라이언트는 `NEXT_PUBLIC_*` (도메인 제한된 키만), 백엔드는 secret/REST 키
- **입력 검증** — Zod 스키마
- **Rate Limit** — IP 단위 in-memory (운영시 Upstash Redis 교체 예정)
- **CSP / HSTS / X-Frame-Options** — Next.js 헤더 (적용 예정)
- **EXIF 제거 / k-익명화** — 시민 제보 (예정)

---

## 셋업

### 0. 사전 준비
- Node.js 22+
- Supabase 프로젝트 (Seoul region, PostGIS 활성)
- Kakao Developers 앱 (JavaScript 키 + REST 키 + 도메인 등록)
- Tmap openapi.sk.com 프로젝트 (보행자 라우팅 API 활성)
- 공공데이터포털 회원 + KOROAD 회원

### 1. 클론 + 설치

```bash
git clone <repo>
cd app
npm install
```

### 2. 환경 변수

```bash
cp .env.example .env.local
# .env.local 에 각 키 채우기
```

### 3. DB 셋업

Supabase 대시보드 SQL Editor 에서 차례로:

```bash
# sql/01_schema.sql 실행 (14 테이블 + PostGIS 인덱스 + 트리거)
# sql/02_rls.sql 실행 (20 RLS 정책)
```

기타 RPC 함수 (`route_safety`, `safety_hotspots`, `point_safety`, `points_in_bbox`, `danger_in_bbox`) 는
Supabase SQL Editor 에서 별도 실행 (현재 마이그레이션 미통합).

### 4. 데이터 적재

```bash
# CCTV (대전 방범 OpenAPI)
npm run load:cctv

# 보안등 (자치구 CSV — 공공데이터포털에서 직접 다운로드)
npm run load:lights:csv -- path/to/유성구.csv path/to/서구.csv ...

# 안전비상벨 (행정안전부 OpenAPI)
npm run load:bells

# 보행자 사고다발 (KOROAD)
npm run load:danger

# 편의점 (카카오 로컬 카테고리 그리드 검색)
npm run load:cvs
```

### 5. 개발 서버

```bash
npm run dev
# http://localhost:3000
```

⚠️ 카카오맵 SDK 는 도메인 등록 필수. Kakao Developers → 플랫폼 키 → JavaScript SDK 도메인 에
`http://localhost:3000` 등록 필요.

---

## 디렉터리 구조

```
app/
├── app/
│   ├── api/
│   │   ├── search/          # 카카오 Places 프록시
│   │   ├── reverse-geocode/ # 좌표 → 주소
│   │   └── route/           # 안심 경로 알고리즘 (Tmap + PostGIS)
│   ├── layout.tsx           # Kakao SDK <Script>
│   └── page.tsx             # MapView 렌더
├── components/
│   ├── MapView.tsx          # 메인 지도 + 칩 + 50m 안전점수
│   └── SearchPanel.tsx      # 검색/길찾기/경로 4 모드
├── lib/
│   ├── supabase-browser.ts  # 브라우저 클라이언트 (publishable key)
│   ├── supabase-server.ts   # 서버 클라이언트 + service role
│   └── tmap.ts              # Tmap 보행자 라우팅
├── scripts/                 # 데이터 적재
│   ├── _lib.ts              # Supabase + proj4 + fetch 헬퍼
│   ├── load_cctv.ts
│   ├── load_lights_csv.ts
│   ├── load_bells.ts
│   ├── load_danger.ts
│   └── load_cvs_kakao.ts
├── sql/
│   ├── 01_schema.sql        # 테이블 + PostGIS + 트리거
│   └── 02_rls.sql           # RLS 정책
└── types/
    └── kakao.d.ts
```

---

## API 엔드포인트

### `GET /api/search?q=...&lng=...&lat=...`
카카오 Places 키워드 검색 프록시. 현 위치 기준 거리순 정렬.

### `GET /api/reverse-geocode?lng=...&lat=...`
좌표 → 도로명/지번 주소 + 짧은 라벨.

### `POST /api/route`
```json
{ "start": { "lng": 127.34, "lat": 36.36 }, "end": { "lng": 127.34, "lat": 36.36 } }
```
응답:
```json
{
  "candidates": [
    {
      "key": "route_1", "label": "경로 1", "recommended": true,
      "route": { "geometry": {...}, "distance_m": 2108, "duration_s": 1686 },
      "score": { "score": 76, "counts": { "cctv": 8, "lights": 63, "bells": 0, "cvs": 9, "danger_zones": 0 } }
    }
  ],
  "is_night": true, "hour": 1
}
```

---

## 알려진 한계

1. **카카오 도보 길찾기 API**는 일반 키로 불가 → Tmap 채택
2. **Tmap 보행자**도 가끔 횡단보도 무시 — 라이브러리 한계
3. **CCTV 시야각 데이터 없음** — 균등 반경 가정의 한계
4. **KOROAD 사고다발 27건만** — API 자체 한계
5. **충남대 캠퍼스 내부 시설 0** — 학교 자체 자산 → 공공데이터 미포함
6. **iOS Safari 백그라운드 위치 제한** — SOS 동선 공유 시 화면 켜둬야 함

---

## 데이터 출처

- CCTV / 보안등 / 안전비상벨 — 공공데이터포털 (행정안전부 · 대전시)
- 보행자 사고다발 — 도로교통공단 KOROAD
- 지도 — Kakao Maps
- 라우팅 — Tmap (SK openapi) · OSRM (OpenStreetMap)

---

**TEAM ARGOS · 2026**
