# PaperShare

연구실 논문 공유를 자동화하는 AI 시스템. 팀원 각자의 Claude가 공용 노션 DB에 접근해 논문을 요약해 올리고 자연어로 찾을 수 있게 하는 MCP 서버 + Claude 스킬.

[Easy PubMed Search](https://chromewebstore.google.com/detail/easy-pubmed-search/ebahifkcefggmbfobcjmepdfladggpmg) 익스텐션(2026.6, 검색식 생성)에서 출발해, 연구 과정의 다음 단계인 "찾은 논문을 팀과 공유"까지 AI 활용 범위를 넓힌 프로젝트입니다.

## 왜 만들었나

연구원마다 읽는 논문과 그 내용이 메신저 대화에 흩어져 사라지는 문제를 해소하려 했습니다. AI가 논문을 표준 포맷(연구 질문·방법·핵심 결과·한계·시사점)으로 요약해 팀 DB에 적재하고, 팀원이 자연어로 물으면 관련 논문을 찾아주게 만들었습니다.

## 구조

```
팀원의 Claude (paper-share 스킬)
        │  MCP (x-api-key로 식별)
        ▼
Supabase Edge Function "paper-share"  ──▶  Notion DB "논문 공유"
        │
        ▼
Supabase Postgres "team_members" (API 키 해시 → 이름)
```

- **노션을 저장소로 사용**: 팀원이 이미 보는 곳이라 별도 UI가 필요 없음. 제약조건은 서버 코드가 대신 검사.
- **팀원은 추가 비용 없음**: 요약·검색은 각자의 Claude 구독으로 실행되고, 서버 쪽에는 LLM이 없음.
- **신원 식별은 서버 책임**: 노션 워크스페이스에 개별 연구원 계정이 없다는 걸 구현 중 발견해, "공유자"를 Notion Person이 아니라 서버가 관리하는 이름 목록(Multi-select)으로 설계를 수정함.

## 구성

| 경로 | 내용 |
|---|---|
| `supabase/functions/paper-share/` | MCP 서버 — `find_paper`, `get_options`, `share_paper`, `search_papers` 4개 도구 |
| `supabase/functions/paper-share-digest/` | 주간 Teams 다이제스트 (어댑티브 카드 생성까지 완료, 실제 게시는 기관 인증 정책 보완 중) |
| `supabase/migrations/` | `team_members` 테이블 스키마 |
| `skills/paper-share/SKILL.md` | 팀원 Claude에 설치하는 스킬 — 올리기·찾기 절차 |
| `docs/notion-db-design.md` | 노션 DB 속성·뷰·도구 설계 |
| `docs/paper-share-context.md` | 설계 결정과 그 이유, 구현 중 바뀐 점 |

## 확인된 동작

- 신규 공유(페이지 생성, 5항목 요약 본문) — 정상
- 같은 사람이 같은 논문 재공유 시 거절 — 정상
- 태그·조건 검색 — 정상
- Claude Code 커스텀 MCP 커넥터로 실제 연결 및 호출 확인 (`claude mcp add --transport http`)

## 진행 중

- 주간 Teams 다이제스트 실제 게시: Power Automate 트리거가 익명 웹훅 호출에 OAuth 인증을 요구해(`DirectApiAuthorizationRequired`) 인증 방식 보완 필요
- pg_cron 기반 주간 스케줄 등록은 다이제스트 게시 보완 이후 진행 예정

## 함께 보면 좋은 프로젝트

이 프로젝트의 출발점인 검색식 생성 익스텐션: https://github.com/2njeong/easy-pubmed-search
