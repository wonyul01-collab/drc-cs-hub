# 외부 API·플랫폼 조사 노트 (Phase 0, 2026-11-23)

> **확인 수준 표시:** ✅ 확인(공식 출처 발췌·공식 답변 확인) · 🟡 부분확인(2차 출처 또는 일부만 확인) · ❌ 미확인
>
> **중요 한계:** 이 조사 환경에서는 `apicenter.commerce.naver.com`, `developers.coupangcorp.com`, `vercel.com`, `solapi.com` 등 공식 사이트 **원문 페이지 직접 열람이 네트워크 정책으로 막혀** 있었습니다. 검색 결과에 나온 공식 페이지 발췌와 공식 GitHub 토론(원문 열람 가능)을 근거로 했습니다. ❌·🟡 항목은 **해당 기능 구현 직전에 원문으로 재확인**합니다.

---

## 1. 네이버 커머스API (스마트스토어)

| 항목 | 결과 | 확인 | 출처 |
|---|---|---|---|
| 리뷰 조회·답글 API | **없음.** 2026-04-28 공식 답변 "현재 리뷰 관련 API를 제공하고 있지 않습니다", 2024-08 "가까운 시일 내 계획 없음" | ✅ | github.com/commerce-api-naver/commerce-api/discussions/3463 , /1909 |
| 상품문의(Q&A) 답변 | `PUT /v1/contents/qnas/{id}` (본문 `commentContent`) 동작 보고 (2026-06). PUT이라 수정 겸용 가능성 | 🟡 | discussions/3563 |
| 상품문의 목록 경로·답변 글자수 | 미확인 (`GET /v1/contents/qnas` 추정) | ❌ | — |
| 고객문의(주문 문의) | 목록 `GET /v1/pay-user/inquiries`, 답변 `POST /v1/pay-merchant/inquiries/:inquiryNo/answer` (2026-06-23 공식 담당자 답변) | ✅(경로) / ❌(파라미터·글자수) | discussions/3563 |
| 「고객센터 문의 관리」(2026-07 신설) | API 미제공 (2차 출처: Channel.io 도움말이 네이버 공식 답변 인용) | 🟡 | docs.channel.io/help/ko/articles/네이버-스마트스토어-6d4e4039 |
| 톡톡 | 커머스API 범위 밖. 톡톡 파트너센터 챗봇 API는 별도 존재 — 이 프로젝트 범위에서 제외 | 🟡 | github.com/navertalk/chatbot-api |
| 인증 | OAuth2 client credentials. `client_id + "_" + timestamp`를 `client_secret`을 salt로 bcrypt → Base64 = `client_secret_sign` | 🟡 | 블로그 예시 (nernado.tistory.com/58) |
| 토큰 유효시간 | 약 3시간으로 알려짐 | ❌ | — (구현 시 응답의 `expires_in` 사용) |
| 호출 IP 등록 | 애플리케이션에 API 호출 IP 등록 필요, 미등록 시 `GW.IP_NOT_ALLOWED` | 🟡 | 2차 출처 |
| 호출 한도 | '내 스토어 애플리케이션'은 **모든 API 2 RPS 고정**, 초과 시 429. Burst 2배 일시 허용 | ✅ | discussions/6 |
| 리뷰 엑셀 | 판매자센터 → 리뷰 관리 → 구매평 엑셀 다운로드 메뉴 존재. **열 구성 미확인** (실제 파일로 확인 필요) | 🟡 | imweb.me/blog?idx=402 |

**설계 반영:** 10분 주기 수집 × 2 RPS면 여유 충분. 호출기는 초당 1회로 제한(안전 마진). 리뷰는 파일 방식.

## 2. 쿠팡 Open API (Wing)

| 항목 | 결과 | 확인 | 출처 |
|---|---|---|---|
| 상품별 고객문의 조회 | `GET /v2/providers/openapi/apis/api/v5/vendors/{vendorId}/onlineInquiries`, **조회 기간 최대 7일** | ✅ | developers.coupangcorp.com/hc/en-us/articles/360033400754 |
| 상품별 고객문의 답변 | `POST .../v4/vendors/{vendorId}/onlineInquiries/{inquiryId}/replies`, `content` **2~1,000자**, `replyBy`(Wing 사용자 ID) 필수 | ✅ | 위 + /hc/ko/articles/360023158193 |
| 답변 수정 | **불가.** "완료된 답변은 수정 및 삭제할 수 없음", 재답변 시 새 글로 등록 | ✅ | 공식 FAQ |
| 고객센터 문의 | 조회 `GET .../callCenterInquiries`, 답변 `POST .../callCenterInquiries/{id}/replies` (`parentAnswerId`·`replyBy` 필수, 2~1,000자), 확인 `POST .../{id}/confirms` | ✅ | /hc/en-us/articles/360034156233 , 360033645354 , 360034204013 |
| 고객센터 답변 가능 조건 | `inquiryStatus=progress` **그리고** `partnerTransferStatus=requestAnswer` 일 때만 | ✅ | 위 |
| 24시간 규칙 | 미답변 24시간 경과 시 쿠팡이 자동 안내 후 답변완료 처리 → 이후 API 답변 불가 (오류 코드 522) | ✅ | 위 |
| 인증 | HMAC-SHA256, `Authorization: CEA algorithm=HmacSHA256, ...`, 서명은 **5분** 유효 → 요청마다 생성 | ✅ | /hc/en-us/articles/360033461914 |
| 키 만료 | Open API 키 **180일** 만료, 재발급 필요 | ✅ | /hc/ko/articles/20873272894105 |
| 호출 IP | 허용 목록 등록 필수, 미등록 시 403 "Not allowed IP". 변경 반영 최대 30분, **연동정보 수정 10회 제한** FAQ | ✅ | /hc/en-us/articles/20414599556889 |
| 호출 한도 | vendorId 기준 **초당 5회 초과 시 즉시 차단**, 지속 초과 시 영구 차단 가능 (2023 공지) | ✅ | /hc/ko/articles/23902034110617 |
| 리뷰(상품평) 답글 API | 공식 API 목록에 없음 | 🟡 | /hc/ko/articles/360033917473 |
| Wing 상품평 엑셀 다운로드 | **미확인** — 실제 Wing 화면에서 확인 필요 | ❌ | — |
| 로켓그로스 문의 | 로켓그로스 API 안내 표에 "상품별 고객문의 조회·답변은 마켓플레이스 스키마 공용" 표시. 로켓그로스 상품 문의가 같은 API로 나온다는 명시 문구는 없음 | 🟡 | /hc/ko/articles/35157075045017 |

**설계 반영:**
- 쿠팡 호출은 초당 2회 이하로 제한 (차단 위험이 크므로 보수적으로).
- IP 수정 횟수 제한(10회) → **작업기 IP를 자주 바꾸면 안 됨**. 처음부터 고정 IP 장비 확정이 중요.
- 상품문의 조회 7일 제한 → 휴일 연휴가 길어도 수집이 빠지지 않도록 7일 창을 겹쳐 조회.
- 답변 등록은 **멱등성 키 + 중복 응답(이미 답변됨) 처리** 필수. 한 번 나가면 수정 불가.
- 로켓그로스 여부는 Phase 1에서 실제 키로 조회해 확인.

## 3. 판매자센터 자동 접속(리뷰 다운로드) — 약관 위험

| 플랫폼 | 내용 | 확인 | 위험도 |
|---|---|---|---|
| 네이버 | 네이버 서비스 이용약관에 "사전 허락 없는 자동화 수단(매크로·로봇·스크래퍼 등)" 이용 제한 조항이 있다고 2차 자료가 전함. 커머스(판매자) 약관 원문 조항 ❌ | 🟡 | **중~고** |
| 쿠팡 | 판매자 약관 제14조에 크롤링 직접 언급은 발췌상 없음. 「마켓플레이스 금지 행위 가이드라인」에 "WING 사이트 내 기능 등을 인위적으로 조작하거나 악용하는 행위 엄격히 금지" 포괄 조항, 위반 시 판매 중단·자격 정지 가능. 제13조 구매자 개인정보 목적 외 이용 금지 | 🟡 | **중~고** |

**해석:** "본인 계정으로, 하루 4회, 사람 속도로, 판매자센터가 제공하는 엑셀 다운로드 버튼만 누르는" 방식은 대량 크롤링보다는 위험이 낮지만, 약관상 **허용된다는 근거는 없습니다.** 계정 제재 시 판매 자체가 막히는 위험이므로 → 설계에서 **수동 업로드를 기본 경로**, 자동 다운로드는 **설정으로 켜는 옵션**으로 두고 켤지 여부는 담당자님이 결정 (design.md 7장).

출처: https://www.coupang.com/np/policies/seller , https://www.coupang.com/np/safety/news/detail?id=1007451 , brunch.co.kr/@ainote/226

## 4. Vercel

| 항목 | 결과 | 확인 | 출처 |
|---|---|---|---|
| Hobby 상업 이용 | **금지** (non-commercial personal use only) | ✅ | vercel.com/docs/plans/hobby , /docs/limits/fair-use-policy |
| Pro 요금 | 월 $20 (배포 좌석 1개 + 사용 크레딧 $20 포함), 추가 Owner/Member 좌석 $20, **Viewer 무료** | 🟡 | vercel.com/docs/plans/pro-plan |
| Cron | Hobby 하루 1회(1시간 오차), Pro 1분 단위. Cron Jobs → "Schedules"로 이전 중이라 문서 간 수치 충돌 | 🟡 | /docs/cron-jobs/usage-and-pricing , /docs/schedules/limits |
| Static IPs | Pro 이상, **프로젝트당 월 $100** + 전송량 별도 | ✅ | /docs/networking/static-ips |

**참고:** CS 허브 사용자(담당자)는 Vercel 계정이 아니라 **Supabase 로그인**으로 들어오므로 Vercel 좌석은 배포 담당 1개면 충분합니다. Vercel 크론은 쓰지 않으므로 크론 제한은 무관.

## 5. Supabase

| 항목 | 결과 | 확인 |
|---|---|---|
| Free | DB 500MB, MAU 5만, 스토리지 1GB(파일당 50MB), 활성 프로젝트 2개, **1주 비활성 시 일시정지**, **자동 백업 없음** | 🟡 (supabase.com/pricing) |
| Pro | 월 $25, 디스크 8GB, 일일 백업 7일 보관, 일시정지 없음 | ✅ |
| Free 상업 이용 | 금지 조항 못 찾음, 명시 허용 문구도 없음 | ❌ |

**설계 반영:** 개발·테스트는 Free. 실제 운영 시작(Phase 5) 전에 Pro 전환 권장. 백업은 플랜과 무관하게 작업기가 매 운영일 `pg_dump` → 30일 보관(요구사항 14장).

## 6. 작업기 위치 후보 — 고정 IP 서버

| 후보 | 월 비용 | 비고 | 확인 |
|---|---|---|---|
| 사무실 PC | 0원 (전기료 제외) | 고정 IP 여부·상시 켜짐 여부 확인 필요. 판매자센터 재로그인(2단계 인증)을 **그 PC 화면에서 바로** 할 수 있어 리뷰 자동화에 유리 | — |
| AWS Lightsail 서울 2GB | **$12** (IPv4·고정 IP 포함, 연결 시 무료) | Playwright 안정 구동 최소 2GB 권장. 원격 재로그인은 번거로움 | 🟡 aws.amazon.com/ko/lightsail/pricing |
| Lightsail 1GB | $7 | 브라우저 자동화엔 부족, API 수집만이면 가능 | 🟡 |
| 네이버 클라우드 Micro | 1년 무료 후 약 1.1만 원 + 공인IP 별도(단가 ❌) | | 🟡 |
| Oracle Always Free | 0원 | 서울/춘천 자원 부족 빈번, 가입 리전 변경 불가 → 운영용 비추천 | 🟡 |
| GCP 무료 e2-micro | 0원 | 미국 리전만 → 제외 | ✅ |

## 7. Windows 상시 실행

- `pm2-windows-service`: 유지보수 중단, Node 14+ 실패 → 사용 안 함
- `pm2-windows-startup`: 로그인해야 실행됨 → 사용 안 함
- **NSSM**(또는 WinSW): 단순·검증됨, 크래시 자동 재시작 → **채택 권장**
- `pm2-installer`: PM2 기능이 필요할 때 대안
- 출처: github.com/jessety/pm2-installer , npmjs.com/package/pm2-windows-service (🟡)

## 8. 공휴일

- 공공데이터포털 「한국천문연구원 특일 정보」 `getRestDeInfo` — 무료, 활용신청 필요, `locdate`·`dateName`·`isHoliday` 반환. 대체공휴일 반영은 실사례상 포함(공식 명세 ❌). 임시공휴일은 지정 후 반영.
- 출처: https://www.data.go.kr/data/15012690/openapi.do
- **설계 반영:** API로 연 1회+매월 1회 갱신 → `holidays` 테이블에 저장, 웹에서 수동 추가/수정 가능 (API 장애 대비 2026·2027년 목록을 설정 파일로도 동봉).

## 9. 카카오 알림

| 항목 | 결과 | 확인 |
|---|---|---|
| 일반 단톡방·오픈채팅 전송 API | **없음** (카카오 운영자 답변) | ✅ devtalk.kakao.com/t/api/151008 |
| 나에게 보내기 | 푸시 알림 없음 → 알림용 부적합 | 🟡 |
| 친구에게 보내기 | 친구 관계·동의·검수 필요, 쌍당 하루 약 20건 → 부적합 | 🟡 developers.kakao.com/docs/latest/ko/kakaotalk-message/common |
| 알림톡 조건 | **비즈니스 인증 카카오톡 채널** 필수, 채널 심사 3~5영업일, 템플릿 검수 2~3영업일, 대체문자용 발신번호 등록 | 🟡 kakaobusiness.gitbook.io |
| 알림톡 템플릿 | 정보성만 가능, `#{변수}` 사용. **직원 대상 내부 알림이 승인되는지 공식 근거 없음 → 반려 위험** | 🟡 kakaobusiness.gitbook.io/main/ad/infotalk/audit |
| 단가 (VAT 별도) | 솔라피 알림톡 13원 / SMS 18원 / LMS 45원. 알리고 알림톡 6.5원 / SMS 8.4원 / LMS 25.9원(제3자 확인). NHN Cloud ❌ | 🟡 solapi.com/pricing |
| 실패 시 문자 대체 | 3사 모두 지원, 성공 채널 기준 과금 | 🟡 |
| 결과 조회 | 솔라피 웹훅(서명 검증 권장, 2026-11), 공식 Node SDK `solapi` | ✅ npmjs.com/package/solapi |
| 카카오워크 | 서비스 운영 중(종료 공지 없음). **2026-11-01 운영 주체가 카카오 본사로 변경, 2026-11-13 해킹·개인정보 유출 보도.** Free 플랜 30명, 봇 사용 가능 여부 ❌. API: `users.find_by_email` → `conversations.open` → `messages.send` | 🟡 |
| 이메일 대체 | Gmail SMTP 무료(개인 하루 500통), Resend 무료(하루 100통) | ✅ |

## 10. Claude API (Anthropic)

| 모델 | 용도 | 입력 / 출력 ($/100만 토큰) |
|---|---|---|
| `claude-haiku-5-5` | 분류(저가) | $0.10 / $0.50 |
| `claude-sonnet-5-5` | 답변 초안(중급) | $2.00 / $10.00 |
| `claude-opus-5-5` | (필요 시) 최고 품질 | $4.00 / $20.00 |

출처: Anthropic 공식 모델·가격표 (2026-11-03 기준 캐시). 모델명은 설정(`AI_MODEL_CLASSIFY`, `AI_MODEL_DRAFT`)으로 분리.

## 11. 무료 전용안 추가 조사 (2026-11-23)

| 항목 | 결과 | 확인 | 출처 |
|---|---|---|---|
| Cloudflare Pages 무료 상업 이용 | 상업 이용 금지 조항 못 찾음. 약관 우려는 대용량 미디어 전송 쪽. 요금제 페이지는 Free를 "중요하지 않은 개인·취미 프로젝트용"으로 안내. 무료 한도: 사이트당 파일 2만 개, 월 빌드 500회 | 🟡 | developers.cloudflare.com/pages/platform/limits , developers.cloudflare.com/plans , cloudflare.com/terms (원문 재확인 필요) |
| Gemini API 무료 구간 데이터 | 무료 사용 시 입력·출력을 구글이 제품 개선에 사용, 사람 검토 가능 (2026-03-23 시행 약관). 유료는 개선에 미사용 | ✅ | ai.google.dev/gemini-api/terms , ai.google.dev/gemini-api/docs/logs-policy |
| 카카오워크 Free 플랜 | 멤버 30명 제한, 전자결재 제외(2026-07-01 전체 적용). 봇 사용 가능 여부 ❌ | 🟡 | news.bizwatch.co.kr/article/mobile/2026/01/30/0039 |
