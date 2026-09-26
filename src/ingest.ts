// npm run ingest [-- openai|gemini]
// Đọc library/ → cắt chunk → tạo embedding → ghi .meobeo/index-<provider>.json

import path from 'node:path'
import { embedderFromEnv, type ProviderName } from './providers/index.ts'
import { buildIndex, LIBRARY_DIR, loadLibrary, readIndex, writeIndex } from './rag/store.ts'

try {
  process.loadEnvFile()
} catch {}

const arg = process.argv[2] ?? process.env.MEOBEO_PROVIDER ?? 'openai'
if (arg !== 'openai' && arg !== 'gemini') {
  console.error('Dùng: npm run ingest -- openai   hoặc   npm run ingest -- gemini')
  process.exit(1)
}
const provider: ProviderName = arg

const chunks = await loadLibrary()
if (!chunks.length) {
  console.error(`Không tìm thấy file .md/.txt nào trong ${path.relative(process.cwd(), LIBRARY_DIR) || '.'}/`)
  process.exit(1)
}

const files = new Set(chunks.map(c => c.source))
console.log(`Đọc ${files.size} file → ${chunks.length} chunk`)
for (const file of files) {
  const own = chunks.filter(c => c.source === file)
  const lessons = [...new Set(own.flatMap(c => (c.lesson ? [c.lesson] : [])))]
  console.log(`  ${file}: ${own.length} chunk${lessons.length ? ` · bài ${lessons.join(', ')}` : ''}`)
}

const embedder = embedderFromEnv(provider)
const { index, embedded, reused } = await buildIndex(chunks, embedder, await readIndex(provider), (done, total) =>
  process.stdout.write(`\rEmbedding ${done}/${total}…`),
)
const file = await writeIndex(index)
const dims = index.chunks[0]?.vector.length ?? 0
console.log(`\n✓ ${provider} · ${embedder.model} · ${dims} chiều · gọi API ${embedded} chunk, dùng lại ${reused}`)
console.log(`  → ${path.relative(process.cwd(), file)}`)
