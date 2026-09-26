// RAG bước 4 – GENERATION: đưa kết quả tìm được cho model.
//
// Thay vì lúc nào cũng nhét tài liệu vào prompt ("RAG cố định"), ta biến việc
// tìm kiếm thành một TOOL ("agentic RAG"): model tự quyết định khi nào cần tra,
// tra với từ khoá gì, và có thể tra nhiều lần nếu lần đầu chưa đủ.

import { defineTool, type Tool } from '../core/tool.ts'
import type { EmbeddingAdapter } from '../core/types.ts'
import type { LibraryIndex } from '../rag/search.ts'

export type LibraryAccess = {
  embedder: EmbeddingAdapter
  /** undefined nếu chưa chạy `npm run ingest` cho provider này. */
  index: LibraryIndex | undefined
}

export function createSearchLibraryTool(getLibrary: () => LibraryAccess | undefined): Tool {
  return defineTool<{ query: string; lesson?: number; limit?: number }>({
    name: 'search_library',
    description:
      'Tìm trong thư viện tài liệu riêng của giáo viên (SGK, sách giáo viên, đề mẫu, bài soạn cũ). '
      + 'Dùng TRƯỚC khi soạn giáo án/đề để bám sát nội dung, cách trình bày và mức độ của tài liệu thật. '
      + 'Có thể gọi nhiều lần với các query khác nhau. Trích nguồn (source) khi dùng nội dung tìm được.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nội dung cần tìm, vd. "ví dụ xét dấu tam thức bậc hai có tham số m"' },
        lesson: { type: 'integer', description: 'Tuỳ chọn: chỉ tìm trong tài liệu của bài số này (vd. 17)' },
        limit: { type: 'integer', description: 'Số đoạn trả về, mặc định 5, tối đa 10' },
      },
      required: ['query'],
    },
    execute: async ({ query, lesson, limit }, ctx) => {
      const library = getLibrary()
      if (!library?.index || library.index.size === 0) {
        return { results: [], message: 'Thư viện trống. Giáo viên cần thêm tài liệu vào library/ rồi chạy "npm run ingest".' }
      }
      const [vector] = await library.embedder.embed([query], 'query', ctx.signal)
      const hits = library.index.search(query, vector!, { lesson, limit: Math.min(limit ?? 5, 10) })
      if (!hits.length) return { results: [], message: lesson ? `Không có tài liệu nào gắn với Bài ${lesson}` : 'Không tìm thấy' }
      return {
        results: hits.map(hit => ({
          source: hit.chunk.source,
          heading: hit.chunk.heading,
          ...(hit.chunk.lesson ? { lesson: hit.chunk.lesson } : {}),
          similarity: Number(hit.similarity.toFixed(3)),
          text: hit.chunk.text,
        })),
      }
    },
  })
}
