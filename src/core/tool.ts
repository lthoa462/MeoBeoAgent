import type { JsonSchema, ToolSpec } from './types.ts'

/** Những gì agent loop cung cấp cho tool khi chạy. */
export type ToolContext = {
  /** Hỏi người dùng xác nhận (human-in-the-loop). Trả về true nếu đồng ý. */
  confirm: (question: string) => Promise<boolean>
  signal?: AbortSignal
}

export type Tool<Args = any> = ToolSpec & {
  execute: (args: Args, ctx: ToolContext) => unknown | Promise<unknown>
}

/**
 * Khai báo một tool. Model chỉ thấy name/description/parameters;
 * `execute` chạy trên máy của bạn khi model *yêu cầu* gọi tool.
 */
export function defineTool<Args>(tool: {
  name: string
  description: string
  parameters: JsonSchema
  execute: (args: Args, ctx: ToolContext) => unknown | Promise<unknown>
}): Tool<Args> {
  return tool
}

/** Kiểm tra tối thiểu: args là object và có đủ trường bắt buộc. */
export function validateArgs(tool: ToolSpec, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return `Tham số của ${tool.name} phải là một JSON object, nhận được: ${JSON.stringify(args)}`
  }
  const required = (tool.parameters.required as string[] | undefined) ?? []
  const missing = required.filter(key => !(key in args))
  if (missing.length) return `Thiếu tham số bắt buộc: ${missing.join(', ')}`
  return undefined
}
