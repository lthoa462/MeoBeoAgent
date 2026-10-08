# MeoBeo Summarizer

Chatbot multi-agent **tóm tắt group chat và kênh Microsoft Teams**: ý chính, quyết định, việc cần làm
(ai phụ trách, hạn chót) và trả lời câu hỏi về những gì đã trao đổi, có trích dẫn số tin nhắn `#n`.

MeoBeo có hai cửa vào, dùng chung một bộ agent:

- **Giao diện web**: đăng nhập bằng tài khoản Microsoft, chọn một group chat hoặc một kênh rồi hỏi.
  Backend đọc tin nhắn bằng chính quyền của bạn (token Microsoft Graph *delegated*).
- **Bot Teams**: @MeoBeo trong group chat hoặc kênh. Bot đọc lịch sử bằng quyền của app
  (*resource-specific consent* – RSC) mà thành viên đồng ý khi cài app vào cuộc trò chuyện đó.

Xây dựng trên [`@alvin0/ai-agent-sdk`](https://github.com/alvin0/ai-agent-sdk) 0.1.9, chạy với
**OpenAI** hoặc **Google Gemini** (và một provider `mock` để chạy thử không cần key).

## Mục lục

- [Tính năng](#tính-năng)
- [Quyền riêng tư](#quyền-riêng-tư)
- [Kiến trúc](#kiến-trúc)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Chạy thử nhanh (demo)](#chạy-thử-nhanh-demo)
- [Cài đặt thật](#cài-đặt-thật)
- [Cách dùng](#cách-dùng)
- [Lệnh npm](#lệnh-npm)
- [Biến môi trường](#biến-môi-trường)
- [Giới hạn và hành vi](#giới-hạn-và-hành-vi)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Deploy lên Railway (server test)](#deploy-lên-railway-server-test)
- [Triển khai production](#triển-khai-production)
- [Ghi công](#ghi-công)

## Tính năng

- **Hỏi đúng thời điểm, ngày nào trong quá khứ cũng được**: "hôm qua", "ngày 6/9", "tuần thứ 2 tháng 8",
  "tháng trước", "3 ngày qua", "quý 3"… Agent chỉ *gọi tên* khoảng thời gian theo cấu trúc (ngày, tuần,
  tháng, N đơn vị qua, từ… đến…). Server tự tính mốc chính xác theo múi giờ của bạn và trả về nhãn, ví dụ
  "Tuần 2 tháng 8/2026 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026)", để câu trả lời nhắc lại cho bạn kiểm tra.
  Không nói rõ thì mặc định 24 giờ qua. Xem [Khoảng thời gian](#khoảng-thời-gian-model-gọi-tên-server-tính).
- **Tóm tắt, việc cần làm, hỏi đáp**: coordinator chọn chuyên gia phù hợp (summarizer,
  action-tracker, qa) và gọi song song nếu yêu cầu cần nhiều thứ một lúc.
- **Hội thoại dài vẫn đọc hết**: hội thoại được chia phần theo số token. Nhiều worker đọc song song
  (map), rồi chuyên gia gộp lại (reduce). Mỗi lần đọc tối đa `MAX_RANGE_DAYS` ngày (31, tức một tháng)
  và `MAX_MESSAGES` tin.
- **Khoảng dài hơn một tháng được chia theo tháng**: tới `MAX_PERIOD_DAYS` (mặc định 92 ngày, khoảng một
  quý), mỗi tháng được đọc và tóm tắt riêng rồi gộp lại ("tóm tắt quý 3"). Cách này lâu hơn, và MeoBeo nói
  trước điều đó.
- **Hỏi tiếp không cần đọc lại**: trong vài phút (`TRANSCRIPT_CACHE_TTL_MS`), câu hỏi tiếp theo về
  cùng khoảng thời gian dùng lại bản đã đọc trong RAM.
- **Web**:
  - Danh sách group chat, team › kênh có ô lọc.
  - Nút gợi ý nhanh: hôm qua / tuần trước / tháng trước / việc cần làm tuần này.
  - Nút **📅 Chọn ngày/khoảng**: chọn một ngày ("Tóm tắt ngày 06/09/2026") hoặc hai ngày ("Tóm tắt từ
    01/08/2026 đến 15/08/2026"); yêu cầu được điền sẵn vào ô chat để bạn sửa tiếp trước khi gửi.
  - Câu trả lời stream (SSE), kèm dòng thời gian các bước: đang đọc tháng nào, đã quét tới ngày nào, thẻ
    thống kê có nhãn khoảng thời gian đã đọc (mỗi tháng một dòng khi chia theo tháng), agent nào đang
    chạy, bao nhiêu phần.
  - Nút **Dừng** và **Cuộc trò chuyện mới**.
- **Teams**:
  - Trả lời khi được @mention trong group chat và kênh.
  - Gửi tin "đang xử lý" rồi cập nhật tiến trình và kết quả ngay trên tin đó. Cuối câu trả lời ghi rõ đã
    dựa trên bao nhiêu tin nhắn của khoảng thời gian nào.
  - Chào khi được cài vào cuộc trò chuyện.
  - Trong chat 1:1 thì hướng dẫn cách dùng và gửi link web.
- **Chế độ demo**: một nhóm chat giả lập, tính lùi từ lúc bạn chạy: ~120 tin nhắn tiếng Việt dày đặc
  trong 12 ngày gần nhất, rồi thưa hơn tới 4 tháng trước (lập kế hoạch, một buổi review thiết kế có quyết
  định và việc cần làm khoảng 8 tuần trước, một sự cố production buổi tối 30 ngày trước). Đủ để thử
  hỏi ngày, tuần, tháng cũ và chia theo tháng. Chạy toàn bộ luồng mà không cần Azure; nếu dùng
  `LLM_PROVIDER=mock` thì cũng không cần API key.

## Quyền riêng tư

Đây là yêu cầu cứng của sản phẩm. Code được viết để giữ đúng các điểm dưới đây.

- **Không lưu tin nhắn.** Không có cơ sở dữ liệu, không ghi tin nhắn ra đĩa. Tin nhắn chỉ nằm trong
  RAM của tiến trình server:
  - trong một lượt trả lời;
  - hoặc tối đa `TRANSCRIPT_CACHE_TTL_MS` (mặc định 10 phút; đặt `0` để chỉ giữ trong lượt) để trả lời
    câu hỏi tiếp theo.
- **Lịch sử hỏi đáp** của mỗi cuộc trò chuyện cũng chỉ ở RAM. Lịch sử này chứa câu hỏi của bạn, thống
  kê và kết quả tóm tắt (có thể trích một phần nội dung), không chứa toàn văn hội thoại. Phiên bị xoá
  sau `SESSION_TTL_MS` không dùng (mặc định 30 phút). Khởi động lại server là mất hết.
- **Chỉ đọc khi được yêu cầu, đúng khoảng thời gian được hỏi.**
  - Tin nhắn được lấy từ Microsoft Graph tại thời điểm bạn hỏi, chỉ trong khoảng thời gian cần.
  - Ngày nào trong quá khứ cũng đọc được, nhưng server luôn kiểm giới hạn, dù model có yêu cầu gì:
    - mỗi lần đọc tối đa `MAX_RANGE_DAYS` ngày (trần cứng 31, `HARD_MAX_RANGE_DAYS`);
    - một yêu cầu tối đa `MAX_PERIOD_DAYS` ngày (trần cứng 366, `HARD_MAX_PERIOD_DAYS`). Khoảng dài hơn
      bị từ chối kèm lời giải thích, và MeoBeo đề nghị khoảng hẹp hơn.
  - Phần kéo tới tương lai chỉ đọc tới hiện tại, và câu trả lời nói rõ.
- **Model không chọn được đọc ở đâu.**
  - Model chỉ chọn được *khoảng thời gian* (dạng có cấu trúc, server tính mốc) và *câu hỏi*.
  - Cuộc trò chuyện cần đọc và thông tin đăng nhập do host gắn vào từng lượt (`TurnContext`). Chúng
    không bao giờ là tham số của tool.
- **Không log nội dung.**
  - Không ghi nội dung tin nhắn, prompt hay token vào log.
  - Observability của SDK để mặc định không kèm nội dung.
  - Log lỗi chỉ ghi thông báo hoặc mã lỗi, không kèm nội dung request.
- **Trình duyệt không lưu hội thoại.**
  - Nội dung chat chỉ nằm trong bộ nhớ React; tải lại trang là mất.
  - MSAL giữ token đăng nhập trong `sessionStorage`, nên đóng tab là đăng xuất khỏi app.
  - Backend chỉ chuyển token tới Graph, không lưu token. Backend xác định người dùng qua `/me` và chỉ
    giữ ánh xạ băm(token) → id người dùng trong RAM vài phút.
- **Bot nhận mọi tin nhưng bỏ qua tin không nhắc tới nó.** Với RSC, Teams gửi tới bot *mọi* tin trong
  chat/kênh đã cài app. Tin không @MeoBeo bị bỏ qua ngay: không xử lý, không log, không lưu.
- **Nội dung tin nhắn là dữ liệu không tin cậy** (chống prompt injection):
  - Coordinator không bao giờ thấy tin nhắn gốc: `load_messages` chỉ trả về thống kê.
  - Các agent đọc tin nhắn (chuyên gia, chunk-reader) không có tool nào, nên chữ trong tin nhắn không
    thể khiến agent làm gì ngoài viết văn bản.
  - Mỗi tin được định dạng thành một dòng `[#n dd/MM HH:mm] Tên: …`. Dòng tiếp theo của cùng một tin
    luôn thụt lề, nên nội dung không giả được thành một tin khác.
  - Link trong câu trả lời được mở với `Referrer-Policy: no-referrer`. Câu trả lời không tải ảnh: web
    hiện ảnh thành chữ và có Content-Security-Policy chặn tải từ nơi khác; trong Teams, ảnh Markdown
    thành link thường và thẻ HTML tải tài nguyên bị bỏ, để nội dung bị chèn không thể "gọi về" khi tin
    được hiển thị.
- **Bot chỉ tin Bot Framework.** Endpoint `/api/messages` chỉ nhận token do Bot Framework cấp (token
  Entra ID, như ID token của người dùng web, bị từ chối), chỉ trả lời về địa chỉ `serviceUrl` của
  Microsoft, và khi `TENANT_ID` là GUID thì chỉ đọc cuộc trò chuyện của tenant đó.
- Bản tóm tắt quyền riêng tư và điều khoản cho người dùng ở trang `/privacy` (không cần đăng nhập);
  manifest Teams trỏ tới đó.
- **Lưu ý về nhà cung cấp mô hình AI.**
  - Để tóm tắt, nội dung trong khoảng thời gian được yêu cầu *được gửi tới OpenAI hoặc Google Gemini*
    (provider bạn cấu hình). Chính sách lưu và sử dụng dữ liệu của provider đó vẫn áp dụng.
  - Với dữ liệu công việc, hãy dùng gói trả phí/doanh nghiệp không dùng dữ liệu để huấn luyện. Gói miễn
    phí của Gemini API có thể dùng dữ liệu để cải thiện sản phẩm. Cân nhắc thêm Zero Data Retention nếu
    tổ chức yêu cầu.

## Kiến trúc

Một tiến trình Next.js phục vụ cả giao diện, API cho web và endpoint của bot Teams, cùng trên cổng 3000:

```
 Trình duyệt (React + MSAL)                       Microsoft Teams
   │ Authorization: Bearer <token Graph>            │ @MeoBeo trong group chat / kênh
   │                                                │ Bot Service ─▶ POST /api/messages
   ▼                                                ▼
┌─────────────────────── Next.js :3000 · app/api/[[...route]] ─────────────────────────┐
│  Hono app (packages/backend/src/http/app.ts)                                         │
│    GET  /api/health    GET  /api/sources    POST /api/chat (SSE)    POST /api/reset  │
│    POST /api/messages ─▶ Teams SDK v2 (@microsoft/teams.apps, kiểm tra JWT)          │
│             │                                    │                                   │
│             └────────────────┬───────────────────┘                                   │
│                              ▼                                                       │
│     ConversationManager: phiên trong RAM, mỗi cuộc trò chuyện 1 lượt một lúc         │
│                              │  TurnContext = nguồn + fetcher + múi giờ (host gắn)   │
│                              ▼                                                       │
│     coordinator "MeoBeo" ──tools──▶ load_messages ──▶ MessageFetcher                 │
│                              │                         web: token người dùng         │
│                              │                         bot: token app (RSC)          │──▶ Microsoft Graph
│                              ▼                                                       │
│     summarize_messages · extract_action_items · answer_question                      │
│                              ▼                                                       │
│     chuyên gia summarizer · action-tracker · qa ──▶ chunk-reader × N                 │
└──────────────────────────────────────────┬───────────────────────────────────────────┘
                                           ▼
                          OpenAI / Google Gemini (hoặc mock)
```

`npm run serve` chạy cùng Hono app đó bằng `@hono/node-server`, không có giao diện. Lệnh này dùng khi
chỉ cần backend và bot.

### Một lượt multi-agent

```
"tóm tắt tuần này, ai đang giữ việc gì?"
   │
   ▼
coordinator ──① load_messages {period: "week_containing", date: "2026-10-06"}
   │             ──▶ resolvePeriod (múi giờ người dùng) → Graph → normalize → chia phần → RAM
   │          ◀── chỉ thống kê: transcriptId, nhãn khoảng thời gian, số tin, người tham gia, bị cắt…
   │
   ├──② summarize_messages {transcriptId}     ─┐ cùng một bước → chạy song song
   └──② extract_action_items {transcriptId}   ─┤
                                               ▼
                       runSpecialist(kind, transcript, task)  — host điều phối
                         1 phần  → chuyên gia đọc thẳng                          [single]
                         n phần  → chunk-reader × n, ≤ MAP_CONCURRENCY cùng lúc  [map]
                                 → chuyên gia gộp ghi chú (nhiều tầng nếu dài)   [reduce]
   ◀───────────────── kết quả từng chuyên gia ─┘
   │
   ③ câu trả lời cuối: ý chính, quyết định, việc cần làm (ai, hạn), trích dẫn #n
```

Khoảng dài hơn `MAX_RANGE_DAYS` (ví dụ "quý 3"): `load_messages` đọc lần lượt từng tháng, mỗi tháng một
transcript (thống kê riêng, nhãn riêng như "Tháng 7/2026"). Coordinator gọi chuyên gia cho mọi tháng trong
cùng một bước (chạy song song), rồi gộp kết quả thành một câu trả lời.

Tiến trình (đang đọc tháng nào, đã tải bao nhiêu tin, đã quét tới ngày nào, agent nào ở bước nào,
`done/total`) được gửi về:

- web: qua các frame SSE (`fetch-progress`, `transcript`, `agent-progress`, `tool-call`, `tool-result`…);
- Teams: thành dòng trạng thái trên tin nhắn tạm.

### Khoảng thời gian: model gọi tên, server tính

Model không bao giờ tự cộng trừ ngày giờ. Nó gọi `load_messages` với một khoảng *có cấu trúc*;
`resolvePeriod` (`transcript/range.ts`) tính mốc chính xác theo múi giờ của bạn (trình duyệt gửi kèm, bot
lấy từ Teams, mặc định `DEFAULT_TIMEZONE`) và trả về nhãn tiếng Việt. Ví dụ với "bây giờ" là 11:05 thứ Ba
06/10/2026, múi giờ `Asia/Ho_Chi_Minh`:

| `period` | Tham số | Câu hỏi → nhãn server trả về |
|---|---|---|
| `day` | `date` | "ngày 6/9" → Chủ Nhật, 06/09/2026 |
| `week_of_month` | `month`, `week` (1–5) | "tuần thứ 2 tháng 8" → Tuần 2 tháng 8/2026 (Thứ Hai 10/08 – Chủ Nhật 16/08/2026) |
| `week_containing` | `date` | "tuần trước" → Tuần từ Thứ Hai 28/09 đến Chủ Nhật 04/10/2026 |
| `month` | `month` | "tháng 8" → Tháng 8/2026; "tháng này" → Tháng 10/2026 (đến hiện tại) |
| `last` | `amount`, `unit` (`hour`/`day`/`week`/`month`) | "3 ngày qua" → 3 ngày qua (03/10/2026 11:05 → 06/10/2026 11:05) |
| `range` | `since`, `until` (không tính `until`) | "quý 3" → 01/07 – 30/09/2026, chia thành Tháng 7/2026, Tháng 8/2026, Tháng 9/2026 |
| (không có) | — | 24 giờ qua (`DEFAULT_LOOKBACK_HOURS`) |

- **Ngày viết kiểu Việt Nam `dd/MM`**: "6/9" là ngày 6 tháng 9. Không nói năm thì hiểu là lần gần nhất đã
  qua: hỏi "6/9" vào tháng 10/2026 là 06/09/2026, hỏi "tháng 11" vào tháng 10/2026 là tháng 11/2025.
  Khi người dùng không nói năm, model gửi `date: "09-06"` / `month: "11"` không kèm năm và server tự chọn
  năm, nên model không phải tự tính.
- **Tuần theo ISO**: tuần chạy từ Thứ Hai tới Chủ Nhật. *Tuần 1 của tháng* là tuần chứa ngày thứ Năm đầu
  tiên của tháng. Ví dụ tháng 8/2026: tuần 1 là 03–09/08, tuần 2 là 10–16/08. Tháng có 4 hoặc 5 tuần;
  hỏi tuần không tồn tại thì server liệt kê các tuần có thật.
- **Mọi ranh giới ngày/tuần/tháng là nửa đêm theo giờ địa phương**, kể cả khi đổi giờ mùa hè.
- **Chia theo tháng**: khoảng dài hơn `MAX_RANGE_DAYS` được cắt ở đầu mỗi tháng dương lịch; tháng dở
  dang ở hai đầu thành đoạn riêng (ví dụ "90 ngày qua" thành 4 đoạn: 08/07/2026 11:05 – 31/07/2026,
  Tháng 8/2026, Tháng 9/2026, 01/10/2026 – 06/10/2026 11:05). Một yêu cầu tối đa 13 đoạn (`MAX_SEGMENTS`,
  đủ cho một năm chia theo tháng); với `MAX_RANGE_DAYS` nhỏ, khoảng cần nhiều đoạn hơn bị từ chối.
- **Đọc nhầm?** Nhãn luôn hiện trong câu trả lời, trên thẻ thống kê (web) và dưới câu trả lời (Teams).
  Nếu sai ý bạn, hỏi lại với năm hoặc ngày cụ thể, ví dụ "tuần 10/08/2026 – 16/08/2026".

**Chi phí đọc một khoảng cũ** khác nhau giữa group chat và kênh:

- **Group chat: rẻ.** MeoBeo gọi `/chats/{id}/messages?$orderby=createdDateTime desc&$filter=createdDateTime
  lt {until}`. Graph nhảy thẳng tới cuối khoảng cần đọc, nên chi phí chỉ tỉ lệ với số tin *trong* khoảng,
  dù khoảng đó cách đây bao lâu.
- **Kênh: đắt hơn.** API tin nhắn kênh không lọc theo thời gian. Các thread về theo hoạt động mới nhất,
  nên muốn tới một ngày cũ phải quét lùi từ hiện tại qua mọi thread có hoạt động kể từ ngày đó. Mỗi trang
  khoảng 50 thread, khoảng 1,2 giây/trang. `MAX_SCAN_PAGES` (mặc định 200 trang, khoảng 10.000 thread)
  giới hạn việc này ở khoảng 4 phút cho mỗi lần đọc; trang trả lời của một thread dài cũng tính vào giới
  hạn này. Ngoài số trang còn có giới hạn thời gian: mọi đoạn của một yêu cầu cùng chia một quỹ thời gian
  (mặc định 25 phút). Hết trang hay hết giờ thì việc quét dừng, phần đã đọc vẫn được tóm tắt, kết quả bị
  đánh dấu chưa đầy đủ kèm ghi chú "chỉ quét được tới …". Trong lúc chờ, tiến trình trên web và Teams cho
  biết đã quét tới ngày nào.

### Vì sao agent-as-tool + map-reduce do host điều phối, không dùng `AgentTeam` của SDK

Tài liệu SDK (`skills/ai-agent-sdk/references/orchestration.md`) chia hai kiểu điều phối:

- **Model quyết định**: `createManagedAgentTeam` / `spawn_agent`. Hợp khi chưa biết trước hình dạng
  công việc.
- **Code của bạn quyết định**: `Promise.all` trên `agent.generate()`. Hợp khi "topology là kiến trúc,
  không phải lựa chọn lúc chạy". Mỗi `generate()` là một run độc lập, có budget, trace và report
  riêng, và *không chia sẻ gì ngầm*.

Bài toán của MeoBeo thuộc kiểu thứ hai:

- **Request/response.** Mỗi yêu cầu web hay tin nhắn Teams là một lượt, kết thúc bằng một câu trả lời.
  `AgentTeam` được thiết kế cho cộng tác giữa các session **sống lâu** trong tiến trình (mailbox,
  `wait_agents`, `followup_task`), nên ở đây sẽ phải dựng rồi huỷ cả đội mỗi lượt.
- **Fan-out xác định.** Số worker bằng đúng số phần của hội thoại, có giới hạn song song, nên tiến
  trình `done/total` hiển thị chính xác. `AbortSignal` từ nút Dừng hoặc khi client ngắt kết nối đi
  xuống tới từng lần gọi model.
- **Cách ly dữ liệu.** Nội dung tin nhắn chỉ đi vào các run chuyên gia/worker không có tool. Lịch sử
  của coordinator chỉ chứa thống kê và kết quả đã tóm tắt. Điều này vừa giữ context nhỏ vừa chặn
  prompt injection.
- **Model vẫn quyết định chiến thuật.** Model chọn khoảng thời gian, chọn gọi chuyên gia nào, và gọi
  nhiều chuyên gia trong một bước. Các tool chuyên gia khai báo `isConcurrencySafe`, nên chúng chạy
  song song.

## Cấu trúc thư mục

```
.
├── package.json                 npm workspaces + các lệnh (dev, build, test, teams:package…)
├── tsconfig.base.json           strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess
├── .env.example                 mọi biến môi trường, chú thích tiếng Việt
├── packages/backend/            @meobeo/backend — TypeScript thuần (ESM, không cần build)
│   ├── src/
│   │   ├── config.ts            đọc biến môi trường; giá trị sai → mặc định; trần cứng 31/366 ngày
│   │   ├── types.ts             kiểu dùng chung: ConversationSource, Transcript, TurnContext…
│   │   ├── wire.ts              giao thức SSE/JSON giữa backend và giao diện
│   │   ├── services.ts          composition root (singleton trên globalThis)
│   │   ├── index.ts             export cho apps/web
│   │   ├── http/app.ts          Hono: /health, /sources, /chat, /reset, /messages
│   │   ├── agents/              team (các agent), tools, specialists (map-reduce), session, prompts
│   │   ├── llm/                 runtime OpenAI/Gemini + provider mock chạy offline
│   │   ├── graph/               client (phân trang, retry 429), token app-only, messages, sources
│   │   ├── transcript/          range (khoảng có cấu trúc, nhãn, chia tháng), normalize, chunk, cache RAM, build
│   │   ├── teams/               bot Teams (Teams SDK v2) và adapter gắn vào Hono
│   │   ├── demo/fixture.ts      nhóm chat giả lập cho DEMO_MODE
│   │   └── serve.ts             chạy backend + bot không cần Next.js
│   └── test/                    vitest — fetch giả + provider mock, không cần mạng hay API key
├── apps/web/                    @meobeo/web — Next.js 16 + React 19
│   ├── next.config.ts           nạp .env gốc, biên dịch backend, header bảo mật (CSP)
│   └── src/
│       ├── app/api/[[...route]]/route.ts   chuyển mọi /api/* vào Hono app
│       ├── app/privacy/page.tsx             quyền riêng tư và điều khoản (manifest Teams trỏ tới)
│       └── ui/                  MSAL, chọn nguồn, khung chat, Markdown, đọc SSE
└── apps/teams-app/              gói app Teams
    ├── manifest.template.json   manifest v1.30: bot, webApplicationInfo, quyền RSC
    ├── color.png, outline.png   icon 192×192 và 32×32
    └── scripts/
        ├── make-icons.mjs       vẽ lại hai icon (chỉ dùng node:zlib)
        └── package.mjs          điền .env vào manifest → build/meobeo-teams.zip
```

## Chạy thử nhanh (demo)

Cần Node.js ≥ 22.12.

```bash
npm install
LLM_PROVIDER=mock DEMO_MODE=1 npm run dev
```

Mở <http://localhost:3000>. Chế độ demo bỏ qua đăng nhập Microsoft và mở thẳng nhóm chat giả lập.
Thử các nút gợi ý, gõ "việc cần làm tuần này", hoặc hỏi lùi xa hơn như "tóm tắt tháng trước" hay "tóm tắt 3
tháng qua" (chia theo tháng; demo giả lập độ trễ Graph nên thấy được tiến trình từng tháng).

- `LLM_PROVIDER=mock` là provider soạn sẵn, không gọi mạng. Nó đi đúng luồng thật: `load_messages`,
  hai chuyên gia chạy song song, map-reduce. Nhưng câu trả lời chỉ là đoạn trích máy móc từ tin
  nhắn, **không phải bản tóm tắt thật**.
- Muốn xem tóm tắt thật trên dữ liệu giả: giữ `DEMO_MODE=1`, đặt `OPENAI_API_KEY` + `OPENAI_MODEL`
  (hoặc Gemini) và bỏ `LLM_PROVIDER=mock`.
- Trên Windows PowerShell: `$env:LLM_PROVIDER="mock"; $env:DEMO_MODE="1"; npm run dev`. Hoặc ghi hai
  biến này vào `.env`.

Không bật `DEMO_MODE` trên server công khai, kể cả khi đang mở devtunnel: chế độ demo không yêu cầu
đăng nhập.

## Cài đặt thật

```bash
cp .env.example .env
```

Mọi cấu hình nằm trong `.env` ở **thư mục gốc**. Web, backend, bot và `teams:package` đều đọc file
này. Biến đặt trên dòng lệnh luôn thắng giá trị trong `.env`.

### a) Khoá mô hình AI

Chọn một provider:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=<model bạn chọn>          # bắt buộc; model hỗ trợ gọi tool
# OPENAI_REASONING_EFFORT=medium       # tuỳ chọn, cho model reasoning

# hoặc
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=<model bạn chọn>          # bắt buộc; model hỗ trợ function calling
```

- Tên model do bạn chọn; MeoBeo không gắn sẵn model nào.
- `WORKER_MODEL` (tuỳ chọn) là một model rẻ/nhanh hơn của cùng provider. Model này dùng cho các worker
  đọc từng phần hội thoại dài.

### b) Đăng ký app Entra ID

Dùng **một** app registration cho cả bot và web. Nếu bạn tạo bot bằng Teams CLI ở bước (c), CLI đã
tạo sẵn app này. Khi đó chỉ cần mở app đó trong Entra và làm tiếp mục 2–3 bên dưới.

1. [Entra admin center](https://entra.microsoft.com) → **App registrations** → **New registration**.
   - Ghi lại **Application (client) ID** → `CLIENT_ID`.
   - Ghi lại **Directory (tenant) ID** → `TENANT_ID`.
2. **Authentication** → **Add a platform** → **Single-page application**.
   - Redirect URI: `http://localhost:3000`.
   - Thêm địa chỉ thật nếu có, ví dụ `https://<tunnel-hoặc-domain>`.
   - Phải là nền tảng *SPA*, không phải *Web*. MSAL dùng popup với redirect URI là origin của trang.
3. **API permissions** → **Microsoft Graph** → **Delegated permissions**, thêm:

   | Quyền | Dùng để |
   |---|---|
   | `User.Read` | biết bạn là ai (`/me`) |
   | `Chat.Read` | liệt kê và đọc group chat của bạn |
   | `ChannelMessage.Read.All` | đọc tin nhắn kênh — **cần admin consent** |
   | `Team.ReadBasic.All` | liệt kê team bạn tham gia |
   | `Channel.ReadBasic.All` | liệt kê kênh của team |

   Sau đó bấm **Grant admin consent** (cần quyền quản trị). Web xin cả 5 quyền trong một lần đăng nhập.
   Chưa có admin consent thì người dùng thường gặp màn hình "Cần quản trị viên phê duyệt"
   (`AADSTS65001` / `AADSTS90094`) và không đăng nhập được.
4. **Certificates & secrets** → **New client secret** → `CLIENT_SECRET`. Bot dùng secret này để xác
   thực với Bot Framework và lấy token app-only đọc tin qua RSC.

Quyền RSC của bot (`ChatMessage.Read.Chat`, `ChannelMessage.Read.Group`) **không** thêm ở đây. Chúng
nằm trong manifest Teams và được cấp khi cài app vào từng cuộc trò chuyện.

Web dùng `NEXT_PUBLIC_AZURE_CLIENT_ID` / `NEXT_PUBLIC_AZURE_TENANT_ID`. Nếu để trống, web lấy
`CLIENT_ID` / `TENANT_ID`. Hai giá trị này được nhúng vào JavaScript lúc chạy `npm run dev` / `npm run
build`, nên đổi xong phải chạy lại.

### c) Đăng ký bot

**Cách 1: Teams CLI** (nhanh nhất)

Lệnh dưới tạo app Entra, client secret, bot (Teams-managed) và app Teams trong Developer Portal. Nó
cũng ghi `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` vào `.env`.

```bash
npm i -g @microsoft/teams.cli
teams login
teams app create --name MeoBeo --endpoint https://<tunnel>/api/messages --env .env
```

- CLI in ra **Teams App ID**. Đặt giá trị đó vào `TEAMS_APP_ID` để gói ở bước (e) cập nhật đúng app
  này, thay vì tạo app thứ hai cho cùng bot.
- `<tunnel>` là địa chỉ ở bước (d), nên hãy tạo tunnel trước. Nếu đổi địa chỉ sau này, cập nhật bằng
  `teams app update <Teams App ID> --endpoint https://<tunnel-mới>/api/messages`.
- Sau đó làm mục 2–3 của bước (b) cho app vừa tạo.

**Cách 2: Azure Bot**

1. Azure portal → tạo resource **Azure Bot**.
2. Chọn *Use existing app registration*, nhập `CLIENT_ID` và đúng loại tenant của app.
3. **Configuration** → **Messaging endpoint**: `https://<host>/api/messages`.
4. **Channels** → bật **Microsoft Teams**.

### d) Mở cổng ra Internet bằng devtunnel

Bot Service phải gọi được tới máy bạn qua https. Next.js phục vụ endpoint bot trên cùng cổng 3000
với giao diện:

```bash
devtunnel user login
devtunnel create meobeo --allow-anonymous
devtunnel port create meobeo -p 3000
devtunnel host meobeo                 # in ra https://<id>-3000.<vùng>.devtunnels.ms
npm run dev                           # ở terminal khác
```

Sau khi có địa chỉ tunnel:

- đặt `WEB_URL=https://<id>-3000.<vùng>.devtunnels.ms`;
- đặt messaging endpoint của bot là `https://<id>-3000.<vùng>.devtunnels.ms/api/messages`;
- muốn đăng nhập web qua tunnel thì thêm địa chỉ đó vào redirect URI SPA.

`--allow-anonymous` là bắt buộc vì Bot Service không đăng nhập devtunnel. Endpoint vẫn an toàn vì
Teams SDK kiểm tra JWT của mọi request.

### e) Đóng gói và cài app vào Teams

```bash
npm run teams:package
```

Lệnh này cần `CLIENT_ID` và `WEB_URL` (hoặc `BOT_DOMAIN`). Nó tạo:

- `apps/teams-app/build/manifest.json`;
- `apps/teams-app/build/meobeo-teams.zip` (manifest + 2 icon).

`TEAMS_APP_ID` lấy từ `.env`. Nếu không có, script tự tạo một lần và giữ trong
`apps/teams-app/build/.app-id`.

Cài app:

1. Teams → **Apps** → **Manage your apps** → **Upload an app** → **Upload a custom app** → chọn file zip.
   - Tenant phải cho phép tải custom app: Teams admin center → *Setup policies* → *Upload custom apps*.
2. Thêm MeoBeo vào **group chat** hoặc **team**. Màn hình cài đặt sẽ xin quyền RSC:
   - đọc tin nhắn của chat này (`ChatMessage.Read.Chat`);
   - đọc tin nhắn kênh của team này (`ChannelMessage.Read.Group`).

   Tenant phải cho phép resource-specific consent cho chat/team (cài đặt RSC của quản trị viên).
   Nếu không, bot sẽ bị Graph trả 403.
3. Khi sửa manifest hoặc đổi `WEB_URL`, tăng `TEAMS_APP_VERSION` rồi đóng gói và tải lên lại.

`node apps/teams-app/scripts/make-icons.mjs` vẽ lại `color.png` / `outline.png` (không cần thư viện
ảnh).

### f) Thử bot trên máy với Microsoft 365 Agents Playground

Playground giả lập Teams, không cần tunnel hay đăng ký bot:

```bash
npm i -g @microsoft/m365agentsplayground
DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS=true LLM_PROVIDER=mock npm run dev
agentsplayground -e http://localhost:3000/api/messages -c emulator     # terminal khác
```

- `DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS` tắt kiểm tra token. **Chỉ dùng trên máy mình**, không
  bao giờ khi đang mở tunnel hay trên server.
- Playground không có Microsoft Graph/RSC thật, và bot không dùng nhóm chat demo. Không có
  `CLIENT_ID`/`CLIENT_SECRET`, Playground chỉ thử được phần nhận tin: lời chào khi cài app, hướng dẫn
  trong chat 1:1 hay khi chỉ @MeoBeo, và thông báo thiếu cấu hình khi @MeoBeo kèm yêu cầu. Luồng đầy đủ
  (tin tạm → tiến trình → câu trả lời) cần `CLIENT_ID`/`CLIENT_SECRET` và một tenant thật (mục a–e).

**Chạy backend + bot không có giao diện:**

```bash
npm run serve
```

Lệnh này lắng nghe ở cổng `PORT` (mặc định 3978), endpoint bot `http://localhost:3978/api/messages`.

## Cách dùng

### Trên web

1. Đăng nhập Microsoft. Chọn một group chat hoặc **team › kênh** ở cột trái (có ô lọc).
2. Hỏi, bấm nút gợi ý, hoặc dùng **📅 Chọn ngày/khoảng** để điền sẵn ngày. Ví dụ:
   - `Tóm tắt hôm qua`
   - `Tóm tắt ngày 6/9` (6 tháng 9, lần gần nhất đã qua)
   - `Tuần thứ 2 tháng 8 nhóm đã chốt những gì?`
   - `Liệt kê việc cần làm tuần này, ai phụ trách, hạn khi nào`
   - `Tháng trước ai hỏi về hợp đồng với khách hàng X, đã có ai trả lời chưa?`
   - `Tóm tắt từ 01/08/2026 đến 15/08/2026`
   - `Tóm tắt quý 3, tập trung vào ngân sách` (chia thành 3 tháng nên lâu hơn)
3. Hỏi tiếp trong cùng cuộc trò chuyện, ví dụ "còn việc của Lan thì sao?". Nếu cùng khoảng thời gian
   và còn trong TTL, MeoBeo dùng lại bản đã đọc.
   - **Dừng** huỷ lượt đang chạy.
   - **Cuộc trò chuyện mới** xoá lịch sử hỏi đáp về nguồn đó.

Web đọc được cả chat 1:1 của bạn vì dùng quyền delegated của chính bạn.

### Trong Teams

```
@MeoBeo tóm tắt hôm qua
@MeoBeo tóm tắt ngày 6/9
@MeoBeo tuần thứ 2 tháng 8 có quyết định gì?
@MeoBeo việc cần làm tuần này
@MeoBeo tóm tắt quý 3
```

MeoBeo gửi ngay một tin "đang xử lý", cập nhật tiến trình trên chính tin đó, rồi thay bằng câu trả
lời. Ví dụ với "tóm tắt quý 3" trong một kênh:

```
⏳ Tháng 7/2026 ✓ 340 tin · Đang đọc Tháng 8/2026… (đã tải 150 · đang quét tới 20/08) · Khoảng dài được đọc lần lượt từng phần nên sẽ lâu hơn
⏳ Tháng 7/2026 ✓ 340 tin · Tháng 8/2026 ✓ 500 tin · Tháng 9/2026 ✓ 180 tin · Tóm tắt: xong 1/3
…câu trả lời…
Dựa trên 1020 tin nhắn — Tháng 7/2026: 340 · Tháng 8/2026: 500 · Tháng 9/2026: 180.
```

Mỗi cuộc trò chuyện xử lý một yêu cầu một lúc. Gõ `@MeoBeo` để thấy các lệnh gợi ý.

## Lệnh npm

Chạy ở thư mục gốc:

| Lệnh | Tác dụng |
|---|---|
| `npm run dev` | Next.js dev ở <http://localhost:3000>: giao diện + `/api/*` + endpoint bot `/api/messages` |
| `npm run build` | Build production (`next build`) |
| `npm start` | Chạy bản build (`next start`, cổng 3000) |
| `npm run serve` | Backend + bot không có giao diện (`@hono/node-server`, cổng `PORT`, mặc định 3978) |
| `npm test` | Test backend và web (vitest; không cần mạng hay API key) |
| `npm run typecheck` | `tsc --noEmit` cho backend và web |
| `npm run teams:package` | Tạo `apps/teams-app/build/meobeo-teams.zip` từ manifest + `.env` |

## Biến môi trường

Xem chú thích đầy đủ trong [`.env.example`](.env.example). Giá trị trống hoặc sai định dạng sẽ dùng
mặc định.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai` \| `gemini` \| `mock` |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | — | Bắt buộc khi dùng OpenAI |
| `OPENAI_REASONING_EFFORT` | — | Mức suy luận (model reasoning) |
| `OPENAI_BASE_URL` | API OpenAI | Endpoint tương thích Responses API |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | — | Bắt buộc khi dùng Gemini |
| `GEMINI_BASE_URL` | API Google | Endpoint Gemini khác (tuỳ chọn) |
| `WORKER_MODEL` | = model chính | Model cho worker map (cùng provider) |
| `CLIENT_ID` | — | App Entra = bot id |
| `CLIENT_SECRET` | — | Secret của app (bot) |
| `TENANT_ID` | — | Tenant của app |
| `NEXT_PUBLIC_AZURE_CLIENT_ID` | `CLIENT_ID` | Client id cho MSAL trên web |
| `NEXT_PUBLIC_AZURE_TENANT_ID` | `TENANT_ID`, rồi `organizations` | Tenant đăng nhập web |
| `WEB_URL` | — | Địa chỉ https công khai (link trong bot, manifest) |
| `DEFAULT_TIMEZONE` | `Asia/Ho_Chi_Minh` | Múi giờ khi không biết múi giờ người dùng |
| `MAX_RANGE_DAYS` | `31` | Một lần đọc tối đa bao nhiêu ngày (1–31; trần cứng 31). Nhỏ hơn 28 thì một tháng thành nhiều đoạn; một yêu cầu tối đa 13 đoạn |
| `MAX_PERIOD_DAYS` | `92` | Một yêu cầu tối đa bao nhiêu ngày; dài hơn `MAX_RANGE_DAYS` thì chia theo tháng (tối đa 366) |
| `MAX_SCAN_PAGES` | `200` | Trang Graph tối đa cho một lần đọc, kể cả trang trả lời trong thread (5–5000); chặn việc quét lùi trong kênh (~4 phút) |
| `DEFAULT_LOOKBACK_HOURS` | `24` | Khoảng mặc định khi không nói rõ (1 tới `MAX_RANGE_DAYS` × 24) |
| `MAX_MESSAGES` | `3000` | Số tin tối đa mỗi lần đọc (50–20000) |
| `CHUNK_TOKENS` | `12000` | Token ước tính mỗi phần giao cho một worker |
| `MAP_CONCURRENCY` | `4` | Worker song song mỗi chuyên gia (1–16) |
| `TRANSCRIPT_CACHE_TTL_MS` | `600000` | Giữ bản đã đọc trong RAM (0 = chỉ trong lượt) |
| `SESSION_TTL_MS` | `1800000` | Xoá phiên hỏi đáp sau bấy lâu không dùng |
| `MAX_SESSIONS` | `200` | Số phiên giữ cùng lúc (mỗi người dùng web tối đa 20) |
| `DEMO_MODE` | tắt | `1` = nhóm chat giả lập, bỏ qua đăng nhập |
| `PORT` | `3978` | Cổng của `npm run serve` |
| `DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS` | tắt | Chỉ cho Agents Playground trên máy mình |
| `TEAMS_APP_ID` | tự tạo | GUID app Teams cho `teams:package` |
| `TEAMS_APP_VERSION` | version gốc | Phiên bản manifest; tăng khi tải lại |

## Giới hạn và hành vi

- **Ngày nào trong quá khứ cũng được, mỗi lần tối đa `MAX_RANGE_DAYS` (31) ngày.** Khoảng dài hơn, tới
  `MAX_PERIOD_DAYS` (mặc định 92), được chia theo tháng: đọc và tóm tắt từng tháng rồi gộp, nên lâu hơn.
  Dài hơn nữa thì bị từ chối kèm gợi ý thu hẹp. Phần kéo tới tương lai chỉ đọc tới hiện tại. Cách hiểu
  ngày, tuần, tháng: xem [Khoảng thời gian](#khoảng-thời-gian-model-gọi-tên-server-tính).
- **`MAX_MESSAGES`** (mặc định 3000) cho mỗi lần đọc (mỗi tháng khi chia theo tháng). Vượt quá thì giữ
  các tin mới nhất, và câu trả lời báo hội thoại đã bị cắt.
- **Tốc độ đọc.**
  - Graph giới hạn khoảng 1 request/giây cho mỗi chat/kênh. Mỗi trang 50 tin, và MeoBeo tự giãn nhịp
    và chờ theo `Retry-After` khi bị 429.
  - Một tháng sôi nổi (vài nghìn tin) có thể mất khoảng một phút chỉ để đọc. Tiến trình hiện trong
    lúc chờ.
- **Kênh.**
  - Graph không lọc tin kênh theo thời gian. MeoBeo quét lùi các thread theo hoạt động mới nhất cho tới
    khi ra ngoài khoảng cần đọc, rồi lọc bài gốc và trả lời theo thời gian tạo.
  - Hỏi một khoảng xa trong kênh sôi nổi có thể tốn vài phút; `MAX_SCAN_PAGES` (mặc định 200 trang ≈ 4
    phút, tính cả trang trả lời trong thread) chặn trên, cùng một quỹ thời gian cho cả yêu cầu (mặc
    định 25 phút, tối đa 2 giờ). Chạm giới hạn thì câu trả lời ghi "chưa quét tới đầu …"; tăng
    `MAX_SCAN_PAGES` nếu chấp nhận chờ lâu hơn.
  - Trên web, server đọc bằng token bạn gửi lúc bắt đầu hỏi. Trình duyệt làm mới token khi còn dưới 40
    phút, nên một lần đọc dài (mặc định tối đa khoảng 30 phút) không hết hạn giữa chừng. Nếu tăng
    `MAX_SCAN_PAGES` rất cao mà token vẫn hết hạn khi đang đọc, MeoBeo báo phiên đăng nhập hết hạn: hãy
    đăng nhập lại rồi hỏi lại.
  - Bot dùng được trong kênh *standard*. Manifest chưa khai báo kênh private/shared.
- **Lịch sử có thể không còn đủ.**
  - MeoBeo chỉ đọc được những gì Graph còn trả về. Chính sách lưu giữ (retention) của Teams/Microsoft
    Purview có thể đã xoá tin cũ; tin đã xoá hay đã hết hạn lưu giữ thì không đọc được.
  - Web dùng quyền của bạn, nên chỉ thấy lịch sử bạn thấy trong Teams (ví dụ không thấy phần lịch sử
    trước khi bạn được thêm vào chat nếu người thêm không chia sẻ lịch sử).
  - **Cần kiểm chứng trên tenant thật:** bot đọc bằng RSC có lấy được tin *trước thời điểm cài app* vào
    chat/team hay không. Nếu không, hãy dùng giao diện web (quyền delegated) cho các khoảng cũ.
- **Teams không stream trong group chat/kênh.** Bot gửi một tin tạm rồi sửa tin đó: cập nhật tiến
  trình (tối đa khoảng mỗi 3 giây), sau đó thay bằng kết quả. Câu trả lời quá dài sẽ bị cắt cho vừa
  giới hạn kích thước tin nhắn.
- **Giới hạn 15 giây của Bot Service.** Handler trả lời Bot Service ngay, phần đọc và tóm tắt chạy
  nền rồi gửi kết quả sau.
- **Chat 1:1 với bot không đọc được bằng RSC.** RSC `ChatMessage.Read.Chat` chỉ áp dụng cho group
  chat và chat cuộc họp. Trong chat riêng, bot chỉ hướng dẫn và gửi link web (`WEB_URL`).
- **Mỗi cuộc trò chuyện một yêu cầu một lúc.** Web trả `409`; Teams trả lời "đang xử lý".
- Tin đã xoá, tin hệ thống và tin của chính bot bị bỏ qua. Tệp, ảnh và thẻ được thay bằng nhãn như
  `[tệp: tên]`; MeoBeo không đọc nội dung tệp.

## Xử lý sự cố

| Triệu chứng | Nguyên nhân / cách xử lý |
|---|---|
| Đọc nhầm ngày/tuần | Xem nhãn khoảng thời gian trong câu trả lời. Ngày hiểu theo `dd/MM` (6/9 = 6 tháng 9); tuần theo ISO (Thứ Hai – Chủ Nhật, tuần 1 chứa thứ Năm đầu tiên của tháng). Hỏi lại kèm năm hoặc ngày cụ thể. |
| Hỏi tháng cũ trong **kênh** rất lâu, hoặc báo "chưa quét tới đầu …" | Kênh không lọc được theo ngày nên phải quét lùi từ hiện tại. Tăng `MAX_SCAN_PAGES` (chờ lâu hơn), hoặc hỏi khoảng ngắn hơn. |
| Khoảng thời gian bị từ chối vì quá dài | Dài hơn `MAX_PERIOD_DAYS`. Hỏi từng quý/từng tháng, hoặc tăng `MAX_PERIOD_DAYS` (tối đa 366). |
| Bot báo **403** khi đọc tin | App chưa được cài vào *chính* group chat/team đó, hoặc chưa đồng ý RSC, hoặc tenant tắt RSC. Cài (lại) app vào cuộc trò chuyện; nhờ quản trị viên bật resource-specific consent. |
| `AADSTS65001` / `AADSTS90094`, "cần quản trị viên phê duyệt" | Quyền delegated (nhất là `ChannelMessage.Read.All`) chưa có admin consent → *Grant admin consent* trong Entra. |
| Web: một team báo lỗi trong danh sách / **403** khi đọc kênh | Bạn không còn quyền với team/kênh đó, hoặc consent thiếu quyền kênh → kiểm tra *API permissions* của app. |
| Web: **401** / "Cần đăng nhập lại Microsoft" | Token hết hạn hoặc bị thu hồi → bấm **Đăng nhập lại**. Trình duyệt chặn popup thì cho phép popup cho trang. |
| `AADSTS50011` (redirect URI) | Thêm đúng origin (ví dụ `http://localhost:3000`) vào redirect URI nền tảng **SPA**. |
| `AADSTS9002326` | Redirect URI đang ở nền tảng *Web*; chuyển sang **Single-page application**. |
| **503** / chip mô hình màu cảnh báo | Provider chưa cấu hình: thiếu `*_API_KEY` hoặc `*_MODEL` cho `LLM_PROVIDER`. Xem `GET /api/health`. |
| **409** | Cuộc trò chuyện đang xử lý yêu cầu khác; chờ xong hoặc bấm **Dừng**. |
| `WebApplicationInfoIdOfSideloadedAppMustBeInTheSameTenantAsUser` | App Entra (`CLIENT_ID`) thuộc tenant khác với tài khoản đang tải app lên. Đăng ký app (hoặc chạy `teams login` / `teams app create`) trong cùng tenant với Teams bạn thử. |
| Bot im lặng | Trong group/kênh phải @MeoBeo. Kiểm tra tunnel đang chạy, messaging endpoint `…/api/messages`, `CLIENT_ID`/`CLIENT_SECRET`, và log server. |
| Không tải được custom app | Quản trị viên cần bật *Upload custom apps* trong setup policy của Teams. |
| `teams:package` báo thiếu biến | Đặt `CLIENT_ID` và `WEB_URL` (hoặc `BOT_DOMAIN`) trong `.env`. |

## Deploy lên Railway (server test)

`railway.json` ở gốc repo khai báo build `npm run build`, start `npm start` (Next.js tự nhận biến `PORT`
mà Railway cấp), healthcheck `/api/health` và **1 replica**, vì session và cache chỉ nằm trong RAM
của một tiến trình.

1. Railway → New Project → Deploy from GitHub repo → chọn repo này và nhánh cần chạy. Từ đó mỗi lần
   push là Railway tự build và deploy.
2. Service → Variables:
   - Test offline, không cần Azure hay API key: `LLM_PROVIDER=mock`, `DEMO_MODE=1`.
   - Chạy thật: thêm các biến trong mục [Biến môi trường](#biến-môi-trường):

     | Nhóm | Biến |
     |---|---|
     | LLM | `OPENAI_API_KEY` + `OPENAI_MODEL`, hoặc `GEMINI_*` |
     | Bot Teams | `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` |
     | Đăng nhập web | `NEXT_PUBLIC_AZURE_CLIENT_ID`, `NEXT_PUBLIC_AZURE_TENANT_ID` |
     | Địa chỉ app | `WEB_URL` = domain Railway |

     Bỏ `DEMO_MODE` khi chạy thật.
   - Biến `NEXT_PUBLIC_*` được nhúng lúc build: đổi giá trị thì phải redeploy.
3. Settings → Networking → Generate Domain. Domain HTTPS cố định này thay được devtunnel:
   - SPA redirect URI trong Entra app: `https://<domain>`;
   - messaging endpoint của bot: `https://<domain>/api/messages`;
   - `WEB_URL` khi chạy `npm run teams:package`.

## Triển khai production

- **Cần một tiến trình Node chạy lâu dài**, ví dụ Azure App Service, Azure Container Apps, container
  hoặc VM: `npm run build && npm start`.
  - Không dùng serverless/edge: bot trả lời Bot Service ngay rồi *tiếp tục làm việc sau khi đã
    phản hồi*, và stream SSE có thể kéo dài vài phút (lâu hơn khi chia theo tháng hoặc quét kênh xa).
    Serverless sẽ đóng băng hoặc giết phần việc đó. Proxy/load balancer phía trước cũng cần cho phép
    request SSE dài như vậy.
- **Mở rộng nhiều instance** (scale-out) cần cẩn thận vì phiên, cache và khoá "một lượt một lúc" đều
  nằm trong RAM của từng tiến trình:
  - chạy 1 instance;
  - hoặc bật sticky session (ARR affinity) cho web, và chấp nhận rằng câu hỏi tiếp theo có thể phải
    đọc lại từ Graph.
  - Đưa trạng thái ra Redis/DB sẽ phá cam kết "chỉ trong RAM", nên dự án không làm.
- Khi lên production:
  - đặt `WEB_URL` là domain thật;
  - thêm domain vào redirect URI SPA;
  - đổi messaging endpoint của bot;
  - tăng `TEAMS_APP_VERSION`, chạy lại `npm run teams:package` và tải gói mới lên.
- Không bao giờ bật `DEMO_MODE` hay `DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS` trên server công khai.
- **Hướng gia cố tiếp theo: OBO.** Hiện backend chuyển tiếp token Graph của người dùng và xác định
  người dùng qua `/me`. Có thể chuyển sang luồng On-Behalf-Of: SPA xin token cho API của app, rồi
  backend kiểm tra token và đổi sang token Graph.
- Đọc lại chính sách lưu dữ liệu của provider mô hình AI (xem [Quyền riêng tư](#quyền-riêng-tư)).

## Ghi công

- Agent runtime, provider OpenAI/Gemini, tool loop và các mẫu kiến trúc từ
  [alvin0/ai-agent-sdk](https://github.com/alvin0/ai-agent-sdk) (`@alvin0/ai-agent-sdk-core`,
  `-provider-openai`, `-provider-gemini` 0.1.9). Có tham khảo các sample `edge-runtime-chat-agents`
  (Hono + Next.js, phiên trong RAM, SSE) và `chat-agents` (tách backend/web, provider mock).
- [Microsoft Teams SDK v2](https://github.com/microsoft/teams.ts) (`@microsoft/teams.apps`),
  [MSAL.js](https://github.com/AzureAD/microsoft-authentication-library-for-js), [Hono](https://hono.dev),
  [Next.js](https://nextjs.org).

Giấy phép MIT.
