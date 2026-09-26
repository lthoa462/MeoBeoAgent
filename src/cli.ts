// Giao diện dòng lệnh: đọc yêu cầu của giáo viên, chạy agent, in kết quả dạng stream.

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { runAgent } from './core/agent.ts'
import type { Message } from './core/types.ts'
import { embedderFromEnv, providerFromEnv, type ProviderName, type ProviderConfig } from './providers/index.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import { TurnRenderer } from './render.ts'
import { LibraryIndex } from './rag/search.ts'
import { readIndex } from './rag/store.ts'
import { allTools } from './tools/index.ts'
import { createSearchLibraryTool, type LibraryAccess } from './tools/library.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

try {
  process.loadEnvFile()
} catch {
  // Không có file .env thì dùng biến môi trường sẵn có.
}

const rl = createInterface({ input, output })
let providerName: ProviderName = process.env.MEOBEO_PROVIDER === 'gemini' ? 'gemini' : 'openai'
let provider: ProviderConfig | undefined
// Thư viện RAG của provider đang dùng (mỗi provider một index riêng).
let library: LibraryAccess | undefined
const tools = [...allTools, createSearchLibraryTool(() => library)]
// Suy nghĩ: "on" = yêu cầu model suy nghĩ và hiện tiến trình; "hidden" = vẫn suy nghĩ nhưng ẩn nội dung;
// "off" = không yêu cầu (cho model không hỗ trợ reasoning).
let thinking: 'on' | 'hidden' | 'off' = (['hidden', 'off'].includes(process.env.MEOBEO_THINKING ?? '')
  ? process.env.MEOBEO_THINKING
  : 'on') as 'on' | 'hidden' | 'off'
let effort: string | undefined
// History = "trí nhớ" của cuộc hội thoại; mỗi lượt đều gửi lại toàn bộ cho model.
let history: Message[] = []
// Ctrl+C: đang chạy thì huỷ lượt hiện tại, đang chờ nhập thì thoát.
let running: AbortController | undefined
rl.on('SIGINT', () => {
  if (running) running.abort()
  else {
    rl.close()
  }
})
// Hết input (Ctrl+D hoặc stdin đóng) thì thoát.
rl.on('close', () => process.exit(0))

async function switchProvider(name: ProviderName) {
  try {
    provider = providerFromEnv(name)
    providerName = name
    effort = provider.reasoningEffort
    console.log(dim(`Đang dùng ${provider.label} · model ${provider.model} · ${thinkingStatus()}`))
  } catch (error) {
    console.log(red((error as Error).message))
    return
  }
  const file = await readIndex(name)
  library = { embedder: embedderFromEnv(name), index: file && new LibraryIndex(file) }
  console.log(dim(file
    ? `Thư viện: ${file.chunks.length} chunk từ ${new Set(file.chunks.map(c => c.source)).size} file (${file.embedding.model})`
    : `Thư viện: chưa có index cho ${name} – chạy "npm run ingest -- ${name}"`))
}

function thinkingStatus(): string {
  const mode = { on: 'hiện suy nghĩ', hidden: 'suy nghĩ (ẩn nội dung)', off: 'tắt suy nghĩ' }[thinking]
  return thinking === 'off' ? mode : `${mode}, mức ${effort ?? 'mặc định'}`
}

/** /search <câu hỏi>: xem RAG tìm được gì, KHÔNG gọi model chat. Để học xem retrieval hoạt động ra sao. */
async function debugSearch(query: string) {
  if (!library?.index) return console.log(red('Chưa có index. Chạy "npm run ingest" trước.'))
  const lesson = Number(query.match(/@(\d+)/)?.[1]) || undefined
  const text = query.replace(/@\d+/, '').trim()
  const [vector] = await library.embedder.embed([text], 'query')
  const hits = library.index.search(text, vector!, { lesson, limit: 5 })
  console.log(dim(`vector: thứ hạng theo nghĩa · từ khoá: thứ hạng BM25 · RRF: điểm trộn${lesson ? ` · lọc bài ${lesson}` : ''}`))
  hits.forEach((hit, i) => {
    console.log(`\n${cyan(`#${i + 1}`)} ${hit.chunk.source} › ${hit.chunk.heading || '(không tiêu đề)'}`)
    console.log(dim(`   cosine ${hit.similarity.toFixed(3)} · vector #${hit.vectorRank ?? '-'} · từ khoá #${hit.keywordRank ?? '-'} · RRF ${hit.score.toFixed(4)}`))
    console.log(`   ${hit.chunk.text.slice(0, 200).replace(/\n/g, ' ')}${hit.chunk.text.length > 200 ? '…' : ''}`)
  })
}

console.log(cyan('🐱 MeoBeo – trợ lý soạn bài Toán 10'))
console.log(dim('Lệnh: /openai, /gemini (đổi provider) · /think on|hidden|off · /effort low|medium|high|auto'))
console.log(dim('      /search <câu> [@số bài] (thử tìm thư viện) · /reset · /exit'))
await switchProvider(providerName)

while (true) {
  const line = (await rl.question('\n👩‍🏫 > ')).trim()
  if (!line) continue
  if (line === '/exit') break
  if (line === '/reset') {
    history = []
    console.log(dim('Đã xoá hội thoại.'))
    continue
  }
  if (line === '/openai' || line === '/gemini') {
    await switchProvider(line.slice(1) as ProviderName)
    continue
  }
  if (line === '/think' || line.startsWith('/think ')) {
    const arg = line.slice(7).trim()
    thinking = arg === 'on' || arg === 'hidden' || arg === 'off' ? arg : thinking === 'off' ? 'on' : 'off'
    console.log(dim(thinkingStatus()))
    continue
  }
  if (line.startsWith('/effort')) {
    const arg = line.slice(7).trim()
    effort = !arg || arg === 'auto' ? undefined : arg
    console.log(dim(thinkingStatus()))
    continue
  }
  if (line.startsWith('/search ')) {
    await debugSearch(line.slice(8)).catch(error => console.log(red(`Lỗi: ${(error as Error).message}`)))
    continue
  }
  if (!provider) {
    console.log(red('Chưa cấu hình provider. Tạo file .env từ .env.example rồi chạy lại.'))
    continue
  }

  history.push({ role: 'user', parts: [{ text: line, type: 'text' }] })
  const checkpoint = history.length
  const abort = (running = new AbortController())
  const renderer = new TurnRenderer({ label: providerName, showThinking: thinking === 'on' })

  try {
    for await (const event of runAgent({
      adapter: provider.adapter,
      model: provider.model,
      system: SYSTEM_PROMPT,
      history,
      tools,
      maxSteps: 12,
      reasoning: thinking === 'off' ? undefined : { effort },
      signal: abort.signal,
      confirm: async question => (await rl.question(`\n${cyan('?')} ${question} (y/n) `)).trim().toLowerCase().startsWith('y'),
    })) {
      renderer.handle(event)
    }
  } catch (error) {
    // Lượt lỗi: bỏ cả câu hỏi lẫn phần history dang dở để hội thoại vẫn hợp lệ.
    history.length = checkpoint - 1
    const message = abort.signal.aborted ? 'đã huỷ' : (error as Error).message
    console.log(red(`\nLỗi: ${message}`))
    if (!abort.signal.aborted && thinking !== 'off' && /reasoning|thinking|verif/i.test(message)) {
      console.log(dim('Gợi ý: model này có thể không hỗ trợ suy nghĩ (hoặc tổ chức OpenAI chưa xác minh để xem tóm tắt suy nghĩ).'
        + ' Thử /effort auto, /think hidden hoặc /think off.'))
    }
  } finally {
    running = undefined
  }
}

rl.close()
