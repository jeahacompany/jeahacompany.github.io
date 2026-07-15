# 도반글로벌 마케팅 관리 웹앱 — 인수인계 문서

> 이 문서 하나로 이 앱이 뭐고, 어디 있고, 문제 생기면 어디부터 봐야 하는지 알 수 있게 정리했습니다.
> (작성: 2026-07-15 · 개발 모르는 사람도 읽을 수 있게 씀)

---

## 1. 이 앱은 뭐고, 뭐로 만들었나

리뷰마케팅 회사(도반글로벌)의 **광고주(점주) 관리 웹앱**입니다.
- **관리자**: 광고주·견적·작업·명단·정산 관리
- **점주**: 자기 매장 마케팅 진행현황 조회 (로그인)
- **블로거**: 블로그 체험단 방문일정·후기 URL 제출

**기술 스택**
| 구성 | 기술 | 비고 |
|---|---|---|
| 화면(프론트) | 순수 HTML/JS (프레임워크 없음) | 정적 파일 |
| 백엔드 DB | **Supabase (PostgreSQL)** | 서울 리전 |
| 백엔드 로직 | Supabase **RPC 함수**(pl/pgSQL) | 테이블은 잠그고 함수로만 접근 |
| 호스팅 | **Vercel** + GitHub Pages (둘 다) | 같은 코드 |

---

## 2. 배포 주소 (접속 URL)

| 용도 | 주소 |
|---|---|
| 관리자(직원) | https://dobanglobal.vercel.app/ |
| 점주 | https://dobanglobal.vercel.app/client/ |
| 블로거 | https://dobanglobal.vercel.app/b/?s=공유코드&n=매장명 |

- 예전 주소 https://jeahacompany.github.io/doban/ 도 동일하게 작동(같은 레포).
- 둘 다 GitHub 레포 `jeahacompany/jeahacompany.github.io` 의 `doban/` 폴더를 서빙.

---

## 3. 계정·키는 어디에 있나 (중요)

| 서비스 | 계정 | 로그인 방법 |
|---|---|---|
| Supabase (DB) | jeahacompany's Org · 프로젝트 `doban` | GitHub 계정(jeahacompany)으로 로그인 |
| Vercel (호스팅) | 프로젝트 `dobanglobal` | GitHub 계정으로 로그인 |
| GitHub (코드) | `jeahacompany` | 본인 GitHub |

**키(비밀번호) 종류**
- **Publishable key** (`sb_publishable_...`) — 공개용, 프론트 코드에 들어감. **안전** (노출돼도 됨).
- **Secret key** (`sb_secret_...`) — **절대 비밀.** 아무 데도 넣지 말 것. Supabase 대시보드 안에만.
- **DB 비밀번호** — Supabase 프로젝트 만들 때 설정. 형님 메모장에 보관.
- **관리자 PIN `2944`** — 코드에 하드코딩됨(임시). ⚠️ 나중에 진짜 로그인(Supabase Auth)으로 교체 필요.
- 공개용 URL·키 정리: `마케팅관리/supabase_config.txt`

---

## 4. 폴더·파일 구조

**소스(원본) — `C:\Users\windows11\마케팅관리\`**
```
index.html          관리자 화면 (제일 큼)
client_web.html     점주 화면
blogger.html        블로거 화면
supabase/
  01_schema.sql     DB 테이블 정의
  02_functions.sql  DB 로직 함수 (로그인·저장·조회 전부) — 재실행 가능
  03_data.sql       (이사 당시 데이터 스냅샷, 1회용)
supabase_config.txt 공개 URL·키
doban_backup.ps1    매일 백업 스크립트 (윈도우 예약작업 DobanBackup)
README.md           이 문서
```

**배포(git) — `C:\Users\windows11\_ghpages_tmp\` (레포 jeahacompany.github.io)**
```
doban/index.html         ← 마케팅관리/index.html 복사본
doban/client/index.html  ← client_web.html 복사본
doban/b/index.html       ← blogger.html 복사본
doban/client/manifest.webmanifest, sw.js, icon-*.png  (점주 앱 설치용)
```

---

## 5. 수정·배포 방법 (화면 고칠 때)

1. `마케팅관리/index.html`(또는 client_web/blogger) 수정
2. `_ghpages_tmp/doban/…`로 복사
3. `git add . && git commit && git push`
4. → 약 40초 뒤 Vercel·GitHub 둘 다 자동 반영

**DB(백엔드) 고칠 때**
1. `supabase/02_functions.sql` 수정 (컬럼 추가는 파일 상단 `alter table ... add column if not exists`)
2. Supabase 대시보드 → SQL Editor → 파일 전체 붙여넣기 → Run
   - 함수는 `create or replace`라 언제든 재실행 안전.
   - ⚠️ 한글 컬럼명은 정규화 문제 소지 → 새 컬럼은 **영문(ASCII)** 권장 (예: `sort_no`).

---

## 6. 백업 (데이터 안전)

- **자동**: 매일 오후 1시, 윈도우 예약작업 `DobanBackup`이 `doban_backup.ps1` 실행 → `OneDrive\doban_backup\`에 날짜별 JSON 저장(최근 60일). PC 꺼져 있었으면 켤 때 자동 실행.
- **수동**: 관리자 → 로그 탭 → "지금 전체 데이터 받기(JSON)".
- **복구 절차**: 백업 JSON을 열어 → `03_data.sql`처럼 INSERT SQL로 변환 → Supabase SQL Editor에서 실행. (개발자에게 "이 JSON으로 복구해줘" 요청하면 됨)
- ⚠️ Supabase 무료 플랜은 서버측 자동백업이 없음. 그래서 위 OneDrive 백업이 안전장치.

---

## 7. 롤백 (배포 잘못했을 때)

- **Vercel**: 대시보드 → 프로젝트 → Deployments → 이전 배포 옆 "..." → Promote/Rollback (원클릭).
- **Git**: `git revert HEAD && git push` 로 직전 커밋 되돌리기.

---

## 8. 문제 생기면 — 어디부터 보나

1. **화면이 안 뜸** → Vercel 대시보드에서 최근 배포 상태 확인, 롤백.
2. **로그인/저장이 안 됨** → Supabase 대시보드 → 프로젝트 `doban`이 살아있는지(Active), SQL Editor에서 `select 1;` 되는지.
3. **데이터가 이상함** → 백업 JSON으로 복구.
4. **키/주소 확인** → `supabase_config.txt`.

---

## 9. 형님이 직접 해야 하는 것 (순서대로)

1. **Supabase·Vercel·GitHub 계정 로그인 유지** (비번 잊지 않기, 2단계 인증 백업코드 보관).
2. **DB 비밀번호·Secret key 메모장 보관** (분실 주의).
3. **가끔 로그 탭에서 "지금 전체 데이터 받기"** 눌러 수동 백업 하나 떠두기.
4. PC를 며칠에 한 번은 켜기 (자동백업이 돌게).

---

## 10. 아직 안 한 것 (앞으로 — 전부 무료로 가능)

- 🔴 **진짜 로그인(Supabase Auth)** — 지금은 PIN·평문 비번(임시). 제일 중요.
- created_at/updated_at/감사로그(변경 추적), 소프트삭제 전체 적용
- 봇차단(Cloudflare Turnstile 무료), 에러알림(Sentry 무료)
- 약관·개인정보처리방침·사업자정보 페이지(외부 사용자 대비)

(유료: Supabase Pro $25/월 = 서버 자동백업. 매출 나오면 그때.)
