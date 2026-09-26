// RAG bước 2 – INDEXING: đọc thư viện → chunk → embedding → lưu ra file JSON.
//
// Với vài nghìn chunk, một file JSON + tìm kiếm tuần tự là đủ nhanh (vài ms).
// Database vector (pgvector, Qdrant...) chỉ cần khi lên hàng trăm nghìn chunk.

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EmbeddingAdapter } from '../core/types.ts'
import { chunkMarkdown, type Chunk } from './chunk.ts'

export const LIBRARY_DIR = path.resolve(process.env.MEOBEO_LIBRARY || 'library')
export const INDEX_DIR = path.resolve('.meobeo')

export type IndexedChunk = Chunk & { id: string; vector: number[] }

export type IndexFile = {
  version: 1
  embedding: { provider: string; model: string }
  builtAt: string
  chunks: IndexedChunk[]
}

export function indexPath(provider: string): string {
  return path.join(INDEX_DIR, `index-${provider}.json`)
}

/** Đọc mọi file .md / .txt trong thư mục (đệ quy) và cắt thành chunk. */
export async function loadLibrary(dir = LIBRARY_DIR): Promise<Chunk[]> {
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true })
  } catch {
    return []
  }
  const chunks: Chunk[] = []
  for (const entry of entries.sort()) {
    if (!/\.(md|txt)$/i.test(entry) || path.basename(entry).startsWith('.')) continue
    const content = await readFile(path.join(dir, entry), 'utf8')
    chunks.push(...chunkMarkdown(entry.split(path.sep).join('/'), content))
  }
  return chunks
}

/**
 * Tạo index. Chunk nào đã có trong index cũ (cùng nội dung, cùng model) thì
 * dùng lại vector cũ — chỉ gọi API cho phần mới/đã sửa, đỡ tốn tiền.
 */
export async function buildIndex(
  chunks: Chunk[],
  embedder: EmbeddingAdapter,
  previous?: IndexFile,
  onProgress?: (done: number, total: number) => void,
): Promise<{ index: IndexFile; embedded: number; reused: number }> {
  const sameModel = previous?.embedding.provider === embedder.provider && previous.embedding.model === embedder.model
  const cache = new Map(sameModel ? previous!.chunks.map(c => [c.id, c.vector]) : [])

  const withIds = chunks.map(chunk => ({ ...chunk, id: chunkId(chunk, embedder.model) }))
  const missing = withIds.filter(chunk => !cache.has(chunk.id))

  const BATCH = 50
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const vectors = await embedder.embed(batch.map(embeddingText), 'document')
    batch.forEach((chunk, j) => cache.set(chunk.id, normalize(vectors[j]!)))
    onProgress?.(Math.min(i + BATCH, missing.length), missing.length)
  }

  return {
    index: {
      version: 1,
      embedding: { provider: embedder.provider, model: embedder.model },
      builtAt: new Date().toISOString(),
      chunks: withIds.map(chunk => ({ ...chunk, vector: cache.get(chunk.id)! })),
    },
    embedded: missing.length,
    reused: withIds.length - missing.length,
  }
}

export async function readIndex(provider: string): Promise<IndexFile | undefined> {
  try {
    return JSON.parse(await readFile(indexPath(provider), 'utf8')) as IndexFile
  } catch {
    return undefined
  }
}

export async function writeIndex(index: IndexFile): Promise<string> {
  await mkdir(INDEX_DIR, { recursive: true })
  const file = indexPath(index.embedding.provider)
  await writeFile(file, JSON.stringify(index))
  return file
}

/**
 * Văn bản thật sự đem đi embedding: kèm tên file + tiêu đề, để một đoạn
 * "Ví dụ 2: ..." vẫn mang nghĩa "thuộc Bài 17, dấu tam thức bậc hai".
 */
export function embeddingText(chunk: Chunk): string {
  return [chunk.source, chunk.heading, chunk.text].filter(Boolean).join('\n')
}

function chunkId(chunk: Chunk, model: string): string {
  return createHash('sha256').update(`${model}\n${embeddingText(chunk)}`).digest('hex').slice(0, 16)
}

/** Chuẩn hoá vector về độ dài 1 → cosine similarity chỉ còn là tích vô hướng. */
export function normalize(vector: number[]): number[] {
  const length = Math.hypot(...vector) || 1
  return vector.map(x => x / length)
}
