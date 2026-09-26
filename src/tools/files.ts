import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineTool } from '../core/tool.ts'

/** Thư mục chứa bài soạn; tool không bao giờ ghi ra ngoài thư mục này. */
export const OUTPUT_DIR = path.resolve('output')

export const saveLesson = defineTool<{ filename: string; content: string }>({
  name: 'save_lesson',
  description:
    'Lưu bài soạn / đề / phiếu bài tập hoàn chỉnh ra file Markdown trong thư mục output/. '
    + 'Người dùng sẽ được hỏi xác nhận trước khi ghi. Chỉ gọi khi nội dung đã được kiểm tra xong.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Tên file ngắn, không dấu, vd. "bai16-ham-so-bac-hai"' },
      content: { type: 'string', description: 'Toàn bộ nội dung Markdown (công thức viết bằng LaTeX $...$)' },
    },
    required: ['filename', 'content'],
  },
  execute: async ({ filename, content }, ctx) => {
    // Chỉ giữ tên file, bỏ mọi đường dẫn để tránh ghi ra ngoài output/.
    const safeName = path.basename(filename).replace(/[^\w.-]+/g, '-').replace(/\.md$/i, '') || 'bai-soan'
    const target = path.join(OUTPUT_DIR, `${safeName}.md`)

    const approved = await ctx.confirm(`Lưu ${content.length} ký tự vào ${path.relative(process.cwd(), target)}?`)
    if (!approved) return { saved: false, reason: 'Người dùng từ chối lưu file' }

    await mkdir(OUTPUT_DIR, { recursive: true })
    await writeFile(target, content, 'utf8')
    return { saved: true, path: path.relative(process.cwd(), target) }
  },
})
