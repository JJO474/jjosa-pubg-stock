# 쪼사의 배그 주식시장 v3 — 무료 배포용

Cloudflare Workers(서버/API) + D1(영구 DB) + Workers Static Assets(홈페이지)를 한 프로젝트로 배포합니다. 기존 Python/SQLite 파일은 이 배포에서 사용하지 않습니다.

## 최초 1회 설치

1. GitHub에 이 폴더의 파일을 업로드하거나 로컬 PC에 ZIP을 풀어둡니다. Node.js 20+를 설치합니다.
2. 터미널에서 이 폴더로 이동해 `npm install`, `npx wrangler login`을 실행합니다.
3. `npx wrangler d1 create jjosa-stock-db`를 실행하고 표시되는 `database_id`를 `wrangler.jsonc`의 `REPLACE_WITH_YOUR_D1_DATABASE_ID`에 입력합니다.
4. `npm run db:migrate`로 테이블을 생성합니다.
5. `npx wrangler secret put PUBG_API_KEY`로 PUBG 키를 **터미널에서** 입력합니다.
6. `npx wrangler secret put ADMIN_TOKEN`으로 길고 무작위인 관리자 비밀번호를 입력합니다.
7. `npm run deploy`로 배포하면 `https://jjosa-pubg-stock.<계정>.workers.dev`와 같은 실제 주소가 표시됩니다. 이름 충돌 시 Worker 이름을 바꾸세요.
8. `/admin`에 접속해 관리자 토큰을 입력하고 닉네임을 등록합니다.

## 페이지

- `/` 공개 거래소
- `/admin` 관리자(쓰기 API에 토큰 필요)
- `/overlay` OBS 전광판
- `/api/state` 공개 읽기 전용 데이터

## 무료 운영의 조건과 제한

- Cloudflare Workers와 D1 무료 요금제의 **당시 한도와 이용약관**을 확인하세요. 한도를 초과하면 실패하거나 유료 업그레이드가 필요할 수 있습니다.
- 자동 갱신은 관리자 페이지에서 토큰을 입력한 뒤 시작하며, 열린 동안 5분 간격으로 요청합니다. 공개 거래소 방문만으로는 PUBG API가 호출되지 않습니다.
- 한 번 갱신은 선수 1명의 최근 신규 경기 최대 2개만 처리합니다. 등록 인원이 많으면 여러 번 갱신해야 합니다. D1에 경기 처리 여부, 선수, RP 스냅샷, 가격을 저장하므로 홈페이지 종료 후에도 유지됩니다.
- PUBG API의 호출량 제한을 고려해 보수적으로 60초당 최대 8회로 제한합니다. D1을 통한 호출량 관리가 엄격한 동시성 잠금은 아니므로, 고트래픽 운영에는 Durable Object 기반 직렬화가 필요합니다.
- PUBG API에 보이는 최근 경기 범위 밖의 기록은 소급 복구할 수 없습니다. 경쟁전 판별은 경기 `matchType=competitive` 기준이며 API 필드 변화 시 확인해야 합니다.
- RP는 경기별 증감값이 아닌 두 시점 간의 차이입니다. 경기 성적과 별도 구간 이벤트로 계산합니다. 시즌 변경 시 RP 차이는 주가에 반영하지 않습니다.
- API 키는 절대 HTML, GitHub 저장소, 채팅에 붙여넣지 마세요. Cloudflare secret으로만 등록합니다.
- **중요:** 이 버전은 배포 가능한 소스 코드이며, 실제 Cloudflare 계정에 배포하거나 PUBG 실계정으로 검증한 상태는 아닙니다.
