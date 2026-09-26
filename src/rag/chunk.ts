// RAG bước 1 – CHUNKING: cắt tài liệu dài thành các đoạn nhỏ có nghĩa.
//
// Vì sao phải cắt? Model không thể đọc cả cuốn sách mỗi lần, và một vector
// chỉ tóm được ý chính của một đoạn ngắn. Cắt quá to → vector "loãng", tìm kém;
// cắt quá nhỏ → mất ngữ cảnh (câu hỏi rời khỏi đáp án).
//
// Chiến lược ở đây: cắt theo tiêu đề Markdown (#, ##, ...) trước, rồi gom các
// đoạn văn trong cùng mục cho tới khi đủ ~maxChars. Mỗi chunk giữ lại "đường dẫn
// tiêu đề" để khi đọc riêng lẻ vẫn biết nó thuộc bài nào, mục nào.

export type Chunk = {
  /** File gốc, tương đối so với thư mục library/. */
  source: string
  /** Đường dẫn tiêu đề, vd. "Bài 17. Dấu của tam thức bậc hai > Ví dụ". */
  heading: string
  /** Số bài SGK nếu đoán được từ tiêu đề hoặc tên file. */
  lesson?: number
  text: string
}

export function chunkMarkdown(source: string, content: string, maxChars = 1200): Chunk[] {
  const chunks: Chunk[] = []
  const headings: string[] = []
  let paragraphs: string[] = []
  let current: string[] = []

  const flushSection = () => {
    if (current.length) paragraphs.push(current.join('\n'))
    current = []
    const heading = headings.filter(Boolean).join(' > ')
    const lesson = detectLesson(heading) ?? detectLesson(source)
    for (const text of packParagraphs(paragraphs, maxChars)) {
      chunks.push({ source, heading, ...(lesson ? { lesson } : {}), text })
    }
    paragraphs = []
  }

  for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
    const match = line.match(/^(#{1,6})\s+(.*)$/)
    if (match) {
      flushSection()
      const level = match[1]!.length
      headings.length = level - 1 // bỏ các tiêu đề cấp sâu hơn của mục trước
      headings[level - 1] = match[2]!.trim()
    } else if (line.trim() === '') {
      if (current.length) paragraphs.push(current.join('\n'))
      current = []
    } else {
      current.push(line)
    }
  }
  flushSection()
  return chunks
}

/** Gom các đoạn văn liền nhau thành chunk ≤ maxChars; đoạn quá dài thì cắt theo câu. */
function packParagraphs(paragraphs: string[], maxChars: number): string[] {
  const pieces = paragraphs.flatMap(p => (p.length <= maxChars ? [p] : splitLong(p, maxChars)))
  const out: string[] = []
  let buffer = ''
  for (const piece of pieces) {
    if (buffer && buffer.length + 2 + piece.length > maxChars) {
      out.push(buffer)
      buffer = ''
    }
    buffer = buffer ? `${buffer}\n\n${piece}` : piece
  }
  if (buffer.trim()) out.push(buffer)
  return out
}

function splitLong(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text]
  const out: string[] = []
  let buffer = ''
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > maxChars) {
      out.push(buffer.trim())
      buffer = ''
    }
    // Câu dài hơn maxChars (hiếm): cắt cứng.
    for (let i = 0; i < sentence.length; i += maxChars) {
      const part = sentence.slice(i, i + maxChars)
      if (buffer.length + part.length > maxChars) {
        out.push(buffer.trim())
        buffer = ''
      }
      buffer += part
    }
  }
  if (buffer.trim()) out.push(buffer.trim())
  return out.filter(Boolean)
}

/** "Bài 17. Dấu của..." hoặc tên file "bai-17-..." → 17. */
export function detectLesson(text: string): number | undefined {
  const match = text.normalize('NFC').match(/(?:^|[^\p{L}])(?:bài|bai)[\s_-]*(\d{1,2})(?!\d)/iu)
  return match ? Number(match[1]) : undefined
}
