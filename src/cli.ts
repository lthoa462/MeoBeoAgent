// Giao diện dòng lệnh: đọc yêu cầu của giáo viên, chạy agent, in kết quả dạng stream.

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { runAgent } from './core/agent.ts'
import type { Message } from './core/types.ts'
import { providerFromEnv, type ProviderName, type ProviderConfig } from './providers/index.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import { allTools } from './tools/index.ts'

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

function switchProvider(name: ProviderName) {
  try {
    provider = providerFromEnv(name)
    providerName = name
    console.log(dim(`Đang dùng ${name} · model ${provider.model}`))
  } catch (error) {
    console.log(red((error as Error).message))
  }
}

console.log(cyan('🐱 MeoBeo – trợ lý soạn bài Toán 10'))
console.log(dim('Lệnh: /openai, /gemini (đổi provider) · /reset (xoá hội thoại) · /exit'))
switchProvider(providerName)

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
    switchProvider(line.slice(1) as ProviderName)
    continue
  }
  if (!provider) {
    console.log(red('Chưa cấu hình provider. Tạo file .env từ .env.example rồi chạy lại.'))
    continue
  }

  history.push({ role: 'user', parts: [{ text: line, type: 'text' }] })
  const checkpoint = history.length
  const abort = (running = new AbortController())
  process.stdout.write('\n🐱 ')

  try {
    for await (const event of runAgent({
      ...provider,
      system: SYSTEM_PROMPT,
      history,
      tools: allTools,
      maxSteps: 12,
      signal: abort.signal,
      confirm: async question => (await rl.question(`\n${cyan('?')} ${question} (y/n) `)).trim().toLowerCase().startsWith('y'),
    })) {
      switch (event.type) {
        case 'text-delta':
          process.stdout.write(event.text)
          break
        case 'tool-call':
          process.stdout.write(dim(`\n  ⚙ ${event.call.name}(${JSON.stringify(event.call.args)})`))
          break
        case 'tool-result':
          process.stdout.write(dim(`\n  ${event.result.isError ? '✗' : '✓'} ${preview(event.result.result)}\n`))
          break
        case 'done':
          if (event.reason === 'max-steps') console.log(red('\n(Đã chạm giới hạn số bước, dừng lại.)'))
          console.log(dim(`\n[${providerName} · vào ${event.usage.inputTokens} / ra ${event.usage.outputTokens} tokens]`))
          break
      }
    }
  } catch (error) {
    // Lượt lỗi: bỏ cả câu hỏi lẫn phần history dang dở để hội thoại vẫn hợp lệ.
    history.length = checkpoint - 1
    console.log(red(`\nLỗi: ${abort.signal.aborted ? 'đã huỷ' : (error as Error).message}`))
  } finally {
    running = undefined
  }
}

rl.close()

function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}
