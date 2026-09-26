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

Lệnh trong CLI: `/openai`, `/gemini` (đổi provider giữa chừng, vẫn giữ hội thoại), `/reset`, `/exit`.
Nhấn Ctrl+C khi agent đang chạy để huỷ lượt đó.

## Cấu trúc

```
src/
  core/                 ← không biết gì về OpenAI hay Gemini
    types.ts            Message, ToolCall, StreamEvent, ModelAdapter: "ngôn ngữ trung lập"
    sse.ts              đọc Server-Sent Events từ fetch
    tool.ts             defineTool + kiểm tra tham số
    agent.ts            ★ agent loop: model → tool → model → … → câu trả lời
  providers/            ← chỉ lớp này biết wire format
    openai.ts           Chat Completions (nối các mẩu JSON tham số tool bị chia nhỏ)
    gemini.ts           streamGenerateContent (functionCall/functionResponse, thoughtSignature)
    index.ts            chọn provider từ .env
  tools/
    curriculum.ts       tra mục lục SGK Toán 10 (Kết nối tri thức)
    math.ts             calculate (mathjs), analyze_quadratic, describe_statistics
    files.ts            save_lesson: ghi Markdown vào output/, có hỏi xác nhận
  data/curriculum.ts    mục lục SGK (sửa file này nếu trường bạn dùng bộ sách khác)
  prompt.ts             system prompt: vai trò và quy tắc soạn bài
  cli.ts                giao diện dòng lệnh
test/                   test bằng fetch giả, không cần API key
```

## Học được gì từ từng file

| Khái niệm | Ở đâu | Ghi chú |
|---|---|---|
| Message, role, system prompt | `core/types.ts`, `prompt.ts` | Hai provider có format khác nhau nhưng agent chỉ thấy một |
| Streaming | `core/sse.ts`, `translate()` trong từng provider | In chữ ngay khi model sinh ra |
| Tool calling | `core/tool.ts`, `tools/*` | Model chỉ *xin* gọi tool; code của bạn mới là thứ thực thi |
| **Agent loop** | `core/agent.ts` | Một vòng `for` quanh model; lỗi tool được gửi lại để model tự sửa |
| Giới hạn an toàn | `maxSteps`, bước cuối `toolChoice: 'none'` | Chống lặp vô hạn nhưng vẫn luôn có câu trả lời |
| Human-in-the-loop | `ctx.confirm` trong `save_lesson` | Hỏi người dùng trước khi làm việc có tác dụng phụ |
| Memory (ngắn hạn) | `history` trong `cli.ts` | Mỗi lượt gửi lại toàn bộ hội thoại |
| Provider-neutral | `providers/*` | Đổi `/openai` ↔ `/gemini` giữa chừng mà hội thoại vẫn liền mạch |

## Kiểm tra

```bash
npm test          # vitest: agent loop, 2 provider (fetch giả), các tool toán
npm run typecheck
```

## Hướng phát triển tiếp

- **RAG**: cho agent tra cứu SGK, tài liệu, đề mẫu của giáo viên
- Nén history khi hội thoại dài (compaction)
- Skills: nạp hướng dẫn định dạng đề (trắc nghiệm 4 phương án, đúng/sai, trả lời ngắn) khi cần
- Xuất file .docx
