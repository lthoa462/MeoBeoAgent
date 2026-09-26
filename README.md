# 🐱 MeoBeo Agent

AI agent chạy trên terminal, hỗ trợ giáo viên **soạn bài môn Toán lớp 10**: giáo án, phiếu bài tập,
đề kiểm tra kèm lời giải. Chạy được với **OpenAI** và **Gemini**.

Đây cũng là một project để học cách build AI agent từ đầu. Code được viết tay, không dùng SDK của
provider, và lấy cảm hứng từ kiến trúc của
[alvin0/ai-agent-sdk](https://github.com/alvin0/ai-agent-sdk).

## Chạy thử

Yêu cầu Node.js ≥ 22.

```bash
npm install
cp .env.example .env    # điền API key và tên model
npm start
```

Ví dụ yêu cầu:

- `Soạn phiếu 10 câu trắc nghiệm Bài 17 – Dấu của tam thức bậc hai, 3 mức độ, có đáp án`
- `Soạn giáo án 2 tiết Bài 24 – Hoán vị, chỉnh hợp, tổ hợp`
- `Cho mẫu số liệu 5 7 8 8 9 10 3 6 30, soạn bài tập tính tứ phân vị và tìm giá trị bất thường`

Lệnh trong CLI:

| Lệnh | Tác dụng |
|---|---|
| `/openai`, `/gemini` | Đổi provider giữa chừng, vẫn giữ hội thoại |
| `/think on\|hidden\|off` | Hiện / ẩn / tắt tiến trình suy nghĩ |
| `/effort low\|medium\|high\|auto` | Mức độ suy nghĩ |
| `/search <câu hỏi> [@số bài]` | Xem RAG tìm được gì, không gọi model |
| `/reset`, `/exit` | Xoá hội thoại, thoát |
Nhấn Ctrl+C khi agent đang chạy để huỷ lượt đó.

## Tiến trình suy nghĩ

MeoBeo hiện quá trình làm việc theo dòng thời gian:

```
👩‍🏫 > Soạn 1 câu vận dụng bài 17 có tham số m

💭 Suy nghĩ
│ **Xác định yêu cầu** Giáo viên cần một câu vận dụng về dấu tam thức có tham số m.
│ **Kế hoạch** Chọn f(x) = x² + 2x + m ... Cần kiểm tra Δ bằng tool trước khi ra đáp án.
└ 2.0 giây
🐱 Mình kiểm tra tam thức với m = 2 để chắc đáp án.          ← "commentary": lời dẫn công khai
⚙ analyze_quadratic({"a":1,"b":2,"c":2})
✓ {"delta":"-4","roots":"vô nghiệm (Δ < 0)", ...}
── Bước 2 ──                                                ← agent loop lặp lại
💭 Suy nghĩ
│ **Đối chiếu kết quả** Với m = 2 thì Δ = -4 < 0 ...
└ 1.1 giây
🐱 Câu hỏi: Tìm m để x² + 2x + m > 0 với mọi x ∈ ℝ. ...

[openai · 5.0 giây · vào 2100 / ra 270, suy nghĩ 160 tokens]
```

Có hai loại "tiến trình" khác nhau:

| | Suy nghĩ (reasoning) | Lời dẫn (commentary) |
|---|---|---|
| Là gì | Model suy luận **trước** khi trả lời; provider trả **bản tóm tắt** | Câu ngắn model viết công khai trước khi gọi tool |
| Cần gì | Model reasoning + API hỗ trợ | Chỉ cần quy tắc 8 trong `prompt.ts`, model nào cũng làm được |
| Hiện bằng | `💭 Suy nghĩ` (chữ mờ, nghiêng) | `🐱 ...` trước dòng `⚙` |

Mỗi provider trả suy nghĩ theo một cách khác nhau:

| Provider | Cách bật | Model trả về | Gửi lại ở lượt sau? |
|---|---|---|---|
| OpenAI **Responses API** (mặc định) | `reasoning: { effort, summary: 'auto' }` | Tóm tắt qua `response.reasoning_summary_text.delta` + suy nghĩ đầy đủ **đã mã hoá** | Có: gửi lại item mã hoá để model giữ mạch suy nghĩ giữa các lần gọi tool |
| OpenAI Chat Completions | `reasoning_effort` | **Không** trả suy nghĩ (chỉ đếm token) | Không |
| Gateway Chat Completions (DeepSeek, OpenRouter, Ollama…) | tuỳ gateway | `delta.reasoning_content` / `delta.reasoning` | Không |
| Gemini | `thinkingConfig.includeThoughts` | Part có `thought: true` | Không gửi bản tóm tắt; mạch suy nghĩ đi theo `thoughtSignature` |

Lưu ý:
- Model không phải loại reasoning (vd. dòng GPT-4.x) sẽ báo lỗi khi nhận tham số reasoning. Khi đó dùng `/think off`.
- OpenAI có thể yêu cầu tổ chức phải **xác minh (verify)** mới xem được bản tóm tắt suy nghĩ. Nếu gặp lỗi này, dùng
  `/think hidden` (model vẫn suy nghĩ nhưng không hiện nội dung) hoặc xác minh tổ chức trên trang OpenAI Platform.
- Những gì hiện ra là **bản tóm tắt** do provider tạo, không phải toàn bộ suy luận bên trong model.

## Thư viện tài liệu (RAG)

MeoBeo có thể tra cứu tài liệu riêng của bạn (SGK, sách giáo viên, đề mẫu, bài soạn cũ) trước khi soạn.

```bash
# 1. Chép tài liệu dạng .md hoặc .txt vào library/ (có thể chia thư mục con)
# 2. Tạo index (chạy lại mỗi khi thêm/sửa tài liệu; chỉ phần mới bị tính phí embedding)
npm run ingest -- openai     # hoặc: npm run ingest -- gemini
# 3. Thử tìm kiếm mà không cần gọi model chat
npm start
👩‍🏫 > /search tìm m để tam thức luôn dương @17
```

Thư mục `library/vi-du/` có 2 file mẫu (Bài 13, Bài 17) để thử ngay. Các file khác trong `library/`
**không** được đưa lên git (xem `.gitignore`).

Mẹo để RAG tìm tốt:
- Dùng tiêu đề Markdown (`#`, `##`) cho từng bài, từng mục. MeoBeo cắt tài liệu theo tiêu đề.
- Ghi số bài trong tiêu đề (`# Bài 17. ...`) hoặc tên file (`bai-17-...md`) để lọc được theo bài.
- Viết công thức bằng LaTeX (`$x^2 - 5x + 6$`). Công thức chép từ PDF thường bị vỡ (`x2 5x 6`).
- Mỗi provider có index riêng, vì vector của OpenAI và Gemini không so sánh được với nhau.

### RAG hoạt động thế nào

```
 NẠP (npm run ingest, làm 1 lần)                 TRA CỨU (mỗi khi agent gọi search_library)
 ─────────────────────────────                   ────────────────────────────────────────────
 library/*.md                                    câu hỏi của agent
   │ rag/chunk.ts   cắt theo tiêu đề                │ embedding (purpose = 'query')
   ▼                                                ▼
 các chunk ≤ 1200 ký tự + tiêu đề + số bài      vector câu hỏi ──┐
   │ embedding (purpose = 'document')                            ├─ rag/search.ts
   ▼                                              từ khoá ───────┘   cosine + BM25 → trộn RRF
 .meobeo/index-<provider>.json  ─────────────────────────────────▶  top-k chunk
                                                                    │ tools/library.ts
                                                                    ▼
                                                  kết quả tool → model đọc → soạn bài, ghi nguồn
```

| Bước | File | Ý chính |
|---|---|---|
| Chunking | `rag/chunk.ts` | Cắt theo tiêu đề rồi gom đoạn văn; mỗi chunk giữ "đường dẫn tiêu đề" để không mất ngữ cảnh |
| Embedding | `providers/*` (`openAiEmbedding`, `geminiEmbedding`) | Văn bản → vector; hai đoạn cùng nghĩa có vector gần nhau |
| Index | `rag/store.ts` | File JSON + băm nội dung để chỉ embedding lại phần thay đổi |
| Retrieval | `rag/search.ts` | Hybrid: theo nghĩa (cosine) + theo từ khoá (BM25), trộn bằng Reciprocal Rank Fusion |
| Generation | `tools/library.ts` | *Agentic RAG*: tìm kiếm là một tool, model tự quyết khi nào tra và tra gì |

## Cấu trúc

```
src/
  core/                 ← không biết gì về OpenAI hay Gemini
    types.ts            Message, ToolCall, StreamEvent, ModelAdapter: "ngôn ngữ trung lập"
    sse.ts              đọc Server-Sent Events từ fetch
    tool.ts             defineTool + kiểm tra tham số
    agent.ts            ★ agent loop: model → tool → model → … → câu trả lời
  providers/            ← chỉ lớp này biết wire format
    openai-responses.ts Responses API: tóm tắt suy nghĩ + gửi lại suy nghĩ mã hoá (mặc định)
    openai.ts           Chat Completions (nối các mẩu JSON tham số tool bị chia nhỏ) + embeddings
    gemini.ts           streamGenerateContent (functionCall/functionResponse, thoughtSignature)
    index.ts            chọn provider từ .env
  tools/
    curriculum.ts       tra mục lục SGK Toán 10 (Kết nối tri thức)
    math.ts             calculate (mathjs), analyze_quadratic, describe_statistics
    files.ts            save_lesson: ghi Markdown vào output/, có hỏi xác nhận
    library.ts          search_library: tool tra thư viện RAG
  rag/
    chunk.ts            cắt tài liệu thành chunk
    store.ts            đọc library/, tạo và lưu index embedding
    search.ts           tìm kiếm hybrid (vector + BM25 + RRF)
  ingest.ts             lệnh npm run ingest
  data/curriculum.ts    mục lục SGK (sửa file này nếu trường bạn dùng bộ sách khác)
  prompt.ts             system prompt: vai trò và quy tắc soạn bài
  render.ts             vẽ dòng thời gian: 💭 suy nghĩ → ⚙ tool → 🐱 trả lời
  cli.ts                giao diện dòng lệnh
test/                   test bằng fetch giả, không cần API key
```

## Học được gì từ từng file

| Khái niệm | Ở đâu | Ghi chú |
|---|---|---|
| Message, role, system prompt | `core/types.ts`, `prompt.ts` | Hai provider có format khác nhau nhưng agent chỉ thấy một |
| Streaming | `core/sse.ts`, `translate()` trong từng provider | In chữ ngay khi model sinh ra |
| Suy nghĩ (reasoning) | `ReasoningPart` trong `core/types.ts`, `render.ts` | Suy nghĩ là một phần của message; có provider cần nhận lại nó |
| Tool calling | `core/tool.ts`, `tools/*` | Model chỉ *xin* gọi tool; code của bạn mới là thứ thực thi |
| **Agent loop** | `core/agent.ts` | Một vòng `for` quanh model; lỗi tool được gửi lại để model tự sửa |
| Giới hạn an toàn | `maxSteps`, bước cuối `toolChoice: 'none'` | Chống lặp vô hạn nhưng vẫn luôn có câu trả lời |
| Human-in-the-loop | `ctx.confirm` trong `save_lesson` | Hỏi người dùng trước khi làm việc có tác dụng phụ |
| Memory (ngắn hạn) | `history` trong `cli.ts` | Mỗi lượt gửi lại toàn bộ hội thoại |
| Provider-neutral | `providers/*` | Đổi `/openai` ↔ `/gemini` giữa chừng mà hội thoại vẫn liền mạch |

## Kiểm tra

```bash
npm test          # vitest: agent loop, provider (fetch giả), suy nghĩ, các tool toán, RAG
npm run typecheck
```

## Hướng phát triển tiếp

- Nạp thêm định dạng .docx / .pdf cho thư viện RAG
- Nén history khi hội thoại dài (compaction)
- Skills: nạp hướng dẫn định dạng đề (trắc nghiệm 4 phương án, đúng/sai, trả lời ngắn) khi cần
- Xuất file .docx
