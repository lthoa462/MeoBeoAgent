import { CHAPTERS, TEXTBOOK } from '../data/curriculum.ts'
import { defineTool } from '../core/tool.ts'

export const lookupCurriculum = defineTool<{ query?: string }>({
  name: 'lookup_curriculum',
  description:
    `Tra mục lục SGK ${TEXTBOOK} để lấy đúng tên chương, số bài. `
    + 'Bỏ trống query để lấy toàn bộ mục lục; hoặc truyền từ khoá ("vectơ", "xác suất"), '
    + 'số bài ("bài 16") hoặc số chương ("chương VI").',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
  },
  execute: ({ query }) => {
    const q = normalize(query ?? '')
    const lessonNo = q.match(/^bai\s*(\d+)$/)?.[1]
    const chapterNo = q.match(/^chuong\s*([ivx]+)$/)?.[1]

    const matches = CHAPTERS.flatMap(chapter => {
      if (!q || chapterNo === chapter.number.toLowerCase()) return [chapter]
      const lessons = chapter.lessons.filter(lesson =>
        lessonNo ? lesson.number === Number(lessonNo) : normalize(lesson.title).includes(q),
      )
      if (!lessonNo && normalize(chapter.title).includes(q)) return [chapter]
      return lessons.length ? [{ ...chapter, lessons }] : []
    })

    if (!matches.length) return { textbook: TEXTBOOK, message: `Không tìm thấy "${query}" trong mục lục` }
    return {
      textbook: TEXTBOOK,
      chapters: matches.map(ch => ({
        chapter: `Chương ${ch.number}. ${ch.title} (Tập ${ch.volume})`,
        lessons: ch.lessons.map(l => `Bài ${l.number}. ${l.title}`),
      })),
    }
  },
})

/** Bỏ dấu tiếng Việt, chữ thường, để tìm kiếm "vecto" khớp "Vectơ". */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'd').toLowerCase().trim()
}
