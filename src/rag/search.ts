// RAG bước 3 – RETRIEVAL: tìm các chunk liên quan nhất tới câu hỏi.
//
// Dùng hai cách tìm rồi trộn kết quả (hybrid search):
//  - Theo NGHĨA (vector): "cách xét dấu f(x)" khớp "định lý về dấu của tam thức"
//    dù không chung chữ nào. Nhưng hay trượt với thuật ngữ/số hiệu chính xác.
//  - Theo TỪ KHOÁ (BM25): "Bài 13", "tứ phân vị", "Δ" khớp chính xác.
// Trộn bằng Reciprocal Rank Fusion: chỉ dùng THỨ HẠNG của mỗi cách,
// nên không phải lo hai loại điểm có thang đo khác nhau.

import { normalize, type IndexFile, type IndexedChunk } from './store.ts'

export type SearchHit = {
  chunk: IndexedChunk
  score: number
  /** Thứ hạng theo từng cách (1 = tốt nhất); undefined = cách đó không tìm thấy. */
  vectorRank?: number
  keywordRank?: number
  similarity: number
}

export type SearchOptions = { limit?: number; lesson?: number }

export class LibraryIndex {
  private readonly tokens: string[][]
  private readonly docFreq = new Map<string, number>()
  private readonly avgLength: number

  constructor(readonly file: IndexFile) {
    this.tokens = file.chunks.map(chunk => tokenize(`${chunk.heading}\n${chunk.text}`))
    for (const doc of this.tokens) {
      for (const term of new Set(doc)) this.docFreq.set(term, (this.docFreq.get(term) ?? 0) + 1)
    }
    this.avgLength = this.tokens.reduce((sum, doc) => sum + doc.length, 0) / (this.tokens.length || 1)
  }

  get size(): number {
    return this.file.chunks.length
  }

  search(query: string, queryVector: number[], options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 5
    const q = normalize(queryVector)
    const candidates = this.file.chunks
      .map((chunk, i) => ({ chunk, i }))
      .filter(({ chunk }) => options.lesson === undefined || chunk.lesson === options.lesson)

    // Cosine similarity (vector đã chuẩn hoá → tích vô hướng).
    const similarity = new Map(candidates.map(({ chunk, i }) => [i, dot(q, chunk.vector)]))
    const byVector = [...candidates].sort((a, b) => similarity.get(b.i)! - similarity.get(a.i)!)

    const queryTerms = tokenize(query)
    const keyword = new Map(candidates.map(({ i }) => [i, this.bm25(queryTerms, i)]))
    const byKeyword = candidates.filter(({ i }) => keyword.get(i)! > 0).sort((a, b) => keyword.get(b.i)! - keyword.get(a.i)!)

    const K = 60 // hằng số chuẩn của RRF
    const hits = new Map<number, SearchHit>()
    const hitFor = (i: number, chunk: IndexedChunk) =>
      hits.get(i) ?? hits.set(i, { chunk, score: 0, similarity: similarity.get(i)! }).get(i)!
    byVector.forEach(({ chunk, i }, rank) => {
      const hit = hitFor(i, chunk)
      hit.vectorRank = rank + 1
      hit.score += 1 / (K + rank + 1)
    })
    byKeyword.forEach(({ chunk, i }, rank) => {
      const hit = hitFor(i, chunk)
      hit.keywordRank = rank + 1
      hit.score += 1 / (K + rank + 1)
    })

    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** Okapi BM25: từ hiếm (ít chunk chứa) được điểm cao hơn từ phổ biến ("là", "của"). */
  private bm25(queryTerms: string[], i: number): number {
    const doc = this.tokens[i]!
    const k1 = 1.2
    const b = 0.75
    const n = this.tokens.length
    let score = 0
    for (const term of new Set(queryTerms)) {
      const tf = doc.filter(t => t === term).length
      if (!tf) continue
      const df = this.docFreq.get(term) ?? 0
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / this.avgLength))
    }
    return score
  }
}

/** Tách từ: chữ thường, giữ dấu tiếng Việt (bỏ dấu sẽ nhập "dấu" với "đầu"). */
export function tokenize(text: string): string[] {
  return text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function dot(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * (b[i] ?? 0)
  return sum
}
