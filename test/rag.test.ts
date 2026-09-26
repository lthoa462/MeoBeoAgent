import { describe, expect, it } from 'vitest'
import type { EmbeddingAdapter } from '../src/core/types.ts'
import { geminiEmbedding } from '../src/providers/gemini.ts'
import { openAiEmbedding } from '../src/providers/openai.ts'
import { chunkMarkdown, detectLesson } from '../src/rag/chunk.ts'
import { LibraryIndex } from '../src/rag/search.ts'
import { buildIndex, type IndexFile } from '../src/rag/store.ts'
import { createSearchLibraryTool } from '../src/tools/library.ts'

/**
 * Embedder giả: mỗi "chủ đề" là một trục của vector. Đủ để kiểm tra
 * logic tìm kiếm mà không cần gọi API thật.
 */
function topicEmbedder(): EmbeddingAdapter & { calls: string[][] } {
  const topics = [/tam thức|dấu|Δ|delta/i, /trung vị|tứ phân vị|trung bình/i, /vectơ/i]
  const calls: string[][] = []
  return {
    provider: 'fake',
    model: 'topics-v1',
    calls,
    async embed(texts) {
      calls.push(texts)
      return texts.map(text => topics.map(re => (re.test(text) ? 1 : 0.01)))
    },
  }
}

const DOC = `# Bài 17. Dấu của tam thức bậc hai

## Lý thuyết
Định lí về dấu của tam thức bậc hai f(x) = ax² + bx + c.

Nếu Δ < 0 thì f(x) cùng dấu với a.

## Đề mẫu
Câu 1. Xét dấu x² - 5x + 6.
`

describe('chunkMarkdown', () => {
  it('cắt theo tiêu đề, giữ đường dẫn tiêu đề và số bài', () => {
    const chunks = chunkMarkdown('toan/bai17.md', DOC)
    expect(chunks).toEqual([
      { source: 'toan/bai17.md', heading: 'Bài 17. Dấu của tam thức bậc hai > Lý thuyết', lesson: 17,
        text: 'Định lí về dấu của tam thức bậc hai f(x) = ax² + bx + c.\n\nNếu Δ < 0 thì f(x) cùng dấu với a.' },
      { source: 'toan/bai17.md', heading: 'Bài 17. Dấu của tam thức bậc hai > Đề mẫu', lesson: 17,
        text: 'Câu 1. Xét dấu x² - 5x + 6.' },
    ])
  })

  it('đoạn dài được chia nhỏ, không chunk nào vượt maxChars', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Câu ${i + 1} là một câu khá dài để thử cắt.`).join(' ')
    const chunks = chunkMarkdown('a.md', `# A\n${long}`, 200)
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.every(c => c.text.length <= 200)).toBe(true)
    expect(chunks.map(c => c.text).join(' ').replace(/\s+/g, ' ')).toBe(long)
  })

  it('đoán số bài từ tiêu đề hoặc tên file', () => {
    expect(detectLesson('Bài 13. Các số đặc trưng')).toBe(13)
    expect(detectLesson('de-kiem-tra/bai-24-to-hop.md')).toBe(24)
    expect(detectLesson('bai17.md')).toBe(17)
    expect(detectLesson('Chương VI')).toBeUndefined()
  })
})

describe('buildIndex + LibraryIndex', () => {
  const chunks = [
    { source: 'b17.md', heading: 'Bài 17 > Lý thuyết', lesson: 17, text: 'Định lí về dấu của tam thức bậc hai' },
    { source: 'b13.md', heading: 'Bài 13 > Ví dụ', lesson: 13, text: 'Tính trung vị và tứ phân vị của mẫu số liệu' },
    { source: 'b7.md', heading: 'Bài 7', lesson: 7, text: 'Hai vectơ cùng phương' },
  ]

  it('tìm theo nghĩa và theo từ khoá, lọc theo bài', async () => {
    const embedder = topicEmbedder()
    const { index } = await buildIndex(chunks, embedder)
    const library = new LibraryIndex(index)
    const [q] = await embedder.embed(['xét dấu tam thức'], 'query')

    const hits = library.search('xét dấu tam thức', q!)
    expect(hits[0]!.chunk.source).toBe('b17.md')
    expect(hits[0]).toMatchObject({ vectorRank: 1, keywordRank: 1 })

    expect(library.search('xét dấu tam thức', q!, { lesson: 13 }).map(h => h.chunk.source)).toEqual(['b13.md'])
  })

  it('từ khoá chính xác vẫn thắng khi vector không phân biệt được', async () => {
    const embedder = topicEmbedder()
    const { index } = await buildIndex(chunks, embedder)
    // "cùng phương" không thuộc chủ đề nào của embedder giả → vector vô dụng.
    const hits = new LibraryIndex(index).search('cùng phương', [1, 1, 1])
    expect(hits[0]!.chunk.source).toBe('b7.md')
    expect(hits[0]!.keywordRank).toBe(1)
  })

  it('chỉ gọi API cho chunk mới, dùng lại vector cũ', async () => {
    const embedder = topicEmbedder()
    const first = await buildIndex(chunks.slice(0, 2), embedder)
    expect(first).toMatchObject({ embedded: 2, reused: 0 })

    const second = await buildIndex(chunks, embedder, first.index)
    expect(second).toMatchObject({ embedded: 1, reused: 2 })
    expect(embedder.calls.at(-1)).toEqual(['b7.md\nBài 7\nHai vectơ cùng phương'])
  })
})

describe('search_library tool', () => {
  it('báo thư viện trống khi chưa ingest', async () => {
    const tool = createSearchLibraryTool(() => ({ embedder: topicEmbedder(), index: undefined }))
    expect(await tool.execute({ query: 'x' }, { confirm: async () => true })).toMatchObject({ results: [] })
  })

  it('trả về nguồn, tiêu đề và nội dung chunk', async () => {
    const embedder = topicEmbedder()
    const file: IndexFile = (await buildIndex(
      [{ source: 'b17.md', heading: 'Bài 17', lesson: 17, text: 'dấu tam thức' }], embedder,
    )).index
    const tool = createSearchLibraryTool(() => ({ embedder, index: new LibraryIndex(file) }))
    expect(await tool.execute({ query: 'dấu tam thức' }, { confirm: async () => true })).toEqual({
      results: [{ source: 'b17.md', heading: 'Bài 17', lesson: 17, similarity: 1, text: 'dấu tam thức' }],
    })
  })
})

describe('embedding adapters', () => {
  const jsonFetch = (payload: unknown, requests: any[]) =>
    (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)), headers: init.headers })
      return Response.json(payload)
    }) as unknown as typeof fetch

  it('OpenAI /embeddings giữ đúng thứ tự theo index', async () => {
    const requests: any[] = []
    const fetch = jsonFetch({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }, requests)
    const vectors = await openAiEmbedding({ apiKey: 'k', model: 'emb', fetch }).embed(['a', 'b'], 'document')
    expect(vectors).toEqual([[1, 0], [0, 1]])
    expect(requests[0]).toMatchObject({ url: 'https://api.openai.com/v1/embeddings', body: { model: 'emb', input: ['a', 'b'] } })
  })

  it('Gemini batchEmbedContents gửi taskType theo mục đích', async () => {
    const requests: any[] = []
    const fetch = jsonFetch({ embeddings: [{ values: [0.5, 0.5] }] }, requests)
    const vectors = await geminiEmbedding({ apiKey: 'k', model: 'gemini-embedding-001', fetch }).embed(['câu hỏi'], 'query')
    expect(vectors).toEqual([[0.5, 0.5]])
    expect(requests[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents')
    expect(requests[0].body).toEqual({
      requests: [{ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'câu hỏi' }] }, taskType: 'RETRIEVAL_QUERY' }],
    })
  })
})
