// Ngôn ngữ trung lập (provider-neutral) của MeoBeo.
// Mọi lớp phía trên (agent loop, tools, CLI) chỉ dùng các kiểu ở đây;
// chỉ adapter trong src/providers/ biết wire format của OpenAI hay Gemini.
// (Tương ứng packages/core/src/message + stream trong ai-agent-sdk.)

export type TextPart = { type: 'text'; text: string }

export type ToolCallPart = {
  type: 'tool-call'
  id: string
  name: string
  /** Tham số đã parse từ JSON; nếu model trả JSON hỏng thì là chuỗi thô. */
  args: unknown
  /** Dữ liệu riêng của provider cần gửi lại nguyên vẹn (vd. thoughtSignature của Gemini). */
  providerMeta?: Record<string, unknown>
}

/**
 * Phần "suy nghĩ" của model (reasoning / thinking). Thường là BẢN TÓM TẮT do
 * provider tạo ra, không phải toàn bộ chuỗi suy luận nội bộ.
 * providerMeta giữ dữ liệu mã hoá mà provider cần nhận lại ở lượt sau
 * (vd. encrypted_content của OpenAI) để model "nhớ" mạch suy nghĩ khi gọi tool.
 */
export type ReasoningPart = {
  type: 'reasoning'
  text: string
  providerMeta?: Record<string, unknown>
}

export type ToolResultPart = {
  type: 'tool-result'
  callId: string
  name: string
  result: unknown
  isError?: boolean
}

export type AssistantPart = ReasoningPart | TextPart | ToolCallPart

export type Message =
  | { role: 'user'; parts: TextPart[] }
  | { role: 'assistant'; parts: AssistantPart[] }
  | { role: 'tool'; parts: ToolResultPart[] }

/** JSON Schema tối giản cho tham số tool. */
export type JsonSchema = Record<string, unknown>

export type ToolSpec = {
  name: string
  description: string
  parameters: JsonSchema
}

export type Usage = {
  inputTokens?: number
  outputTokens?: number
  /** Số token dành cho suy nghĩ (đã nằm trong outputTokens). */
  reasoningTokens?: number
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'other'

/** Sự kiện stream mà mọi adapter đều phải phát ra theo cùng một dạng. */
export type StreamEvent =
  | { type: 'reasoning-delta'; text: string }
  /** Kết thúc một khối suy nghĩ; kèm dữ liệu cần gửi lại cho provider (nếu có). */
  | { type: 'reasoning-end'; providerMeta?: Record<string, unknown> }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCallPart }
  | { type: 'finish'; reason: FinishReason; usage?: Usage }

export type ModelRequest = {
  model: string
  system?: string
  messages: Message[]
  tools?: ToolSpec[]
  /** 'none' = cấm gọi tool, buộc model trả lời bằng chữ. */
  toolChoice?: 'auto' | 'none'
  /**
   * Bật suy nghĩ và yêu cầu provider trả về bản tóm tắt tiến trình tư duy.
   * effort: mức độ suy nghĩ ("low" | "medium" | "high"...), bỏ trống = mặc định của model.
   * Không truyền = không yêu cầu (dùng cho model không hỗ trợ reasoning).
   */
  reasoning?: { effort?: string }
  signal?: AbortSignal
}

/** Hợp đồng duy nhất mà một provider phải thực hiện. */
export interface ModelAdapter {
  readonly name: string
  stream(request: ModelRequest): AsyncIterable<StreamEvent>
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`[${provider}] HTTP ${status}: ${body.slice(0, 500)}`)
    this.name = 'ProviderError'
  }
}

// ---- Embedding (dùng cho RAG) ----------------------------------------------

/**
 * "document": đoạn tài liệu đưa vào kho; "query": câu tìm kiếm.
 * Một số provider (Gemini) tối ưu vector khác nhau cho hai mục đích này.
 */
export type EmbeddingPurpose = 'document' | 'query'

/** Biến văn bản thành vector số; hai đoạn cùng ý nghĩa sẽ có vector gần nhau. */
export interface EmbeddingAdapter {
  readonly provider: string
  readonly model: string
  embed(texts: string[], purpose: EmbeddingPurpose, signal?: AbortSignal): Promise<number[][]>
}
