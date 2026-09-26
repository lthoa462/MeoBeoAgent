// Agent loop: bản chất của một "agent" chỉ là vòng lặp
//   gọi model → model xin gọi tool → mình chạy tool → gửi kết quả lại → lặp
// cho đến khi model trả lời mà không xin gọi tool nữa.
// (Tương ứng runTurn/runAgent trong packages/core/src/agent/loop của ai-agent-sdk.)

import { validateArgs, type Tool, type ToolContext } from './tool.ts'
import type {
  Message,
  ModelAdapter,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  Usage,
} from './types.ts'

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallPart }
  | { type: 'tool-result'; result: ToolResultPart }
  | { type: 'step-end'; step: number; usage?: Usage }
  | { type: 'done'; text: string; reason: 'completed' | 'max-steps'; usage: Usage }

export type RunAgentOptions = {
  adapter: ModelAdapter
  model: string
  system?: string
  /** History của cả cuộc hội thoại; loop sẽ append trực tiếp vào mảng này. */
  history: Message[]
  tools: Tool[]
  /** Số lần gọi model tối đa trong một lượt (giới hạn an toàn). Mặc định 8. */
  maxSteps?: number
  confirm?: ToolContext['confirm']
  signal?: AbortSignal
}

export async function* runAgent(options: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { adapter, model, system, history, tools, signal } = options
  const maxSteps = options.maxSteps ?? 8
  const confirm = options.confirm ?? (async () => false)
  const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
  const specs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
  const total: Usage = { inputTokens: 0, outputTokens: 0 }

  for (let step = 1; step <= maxSteps; step++) {
    // Bước cuối: cấm gọi tool để model buộc phải tổng kết bằng chữ,
    // thay vì dừng giữa chừng không có câu trả lời.
    const isLastStep = step === maxSteps

    // 1) Gọi model và gom stream thành một assistant message.
    let text = ''
    const calls: ToolCallPart[] = []
    let usage: Usage | undefined
    for await (const event of adapter.stream({
      model,
      system,
      messages: history,
      tools: specs,
      toolChoice: isLastStep ? 'none' : 'auto',
      signal,
    })) {
      if (event.type === 'text-delta') {
        text += event.text
        yield event
      } else if (event.type === 'tool-call') {
        calls.push(event.call)
        yield event
      } else {
        usage = event.usage
      }
    }
    total.inputTokens! += usage?.inputTokens ?? 0
    total.outputTokens! += usage?.outputTokens ?? 0

    const parts: (TextPart | ToolCallPart)[] = []
    if (text) parts.push({ type: 'text', text })
    parts.push(...calls)
    history.push({ role: 'assistant', parts })
    yield { type: 'step-end', step, usage }

    // 2) Không có tool call → model đã trả lời xong.
    if (calls.length === 0) {
      yield { type: 'done', text, reason: 'completed', usage: total }
      return
    }

    // 3) Chạy từng tool, lỗi cũng được gửi lại cho model để nó tự sửa.
    const results: ToolResultPart[] = []
    for (const call of calls) {
      const result = await executeTool(toolsByName.get(call.name), call, { confirm, signal })
      results.push(result)
      yield { type: 'tool-result', result }
    }
    history.push({ role: 'tool', parts: results })
  }

  yield { type: 'done', text: '', reason: 'max-steps', usage: total }
}

async function executeTool(
  tool: Tool | undefined,
  call: ToolCallPart,
  ctx: ToolContext,
): Promise<ToolResultPart> {
  const base = { type: 'tool-result' as const, callId: call.id, name: call.name }
  if (!tool) return { ...base, result: `Không có tool tên "${call.name}"`, isError: true }

  const problem = validateArgs(tool, call.args)
  if (problem) return { ...base, result: problem, isError: true }

  try {
    return { ...base, result: await tool.execute(call.args, ctx) }
  } catch (error) {
    return { ...base, result: error instanceof Error ? error.message : String(error), isError: true }
  }
}
