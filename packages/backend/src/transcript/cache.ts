/**
 * RAM-only transcript cache. Nothing here is ever written to disk or logged.
 *
 * - `load(key, loader)`: returns a fresh cached transcript for `key`; otherwise
 *   shares an in-flight load for the same key; otherwise runs `loader`. A failed
 *   load is not cached.
 * - With ttlMs > 0, a loaded transcript is retrievable by key and by id until
 *   ttlMs after it was loaded; expired entries are evicted lazily and by
 *   `prune()`. `maxEntries` (default 50) evicts the oldest first.
 * - With ttlMs = 0 nothing is retained after `load` settles (callers keep their
 *   own per-turn reference).
 *
 * Keys must identify the reader as well as the source and window (e.g.
 * "oid:…|chat:…|since|until"): a transcript fetched with one person's token
 * must never be served to someone else.
 */

import type { Transcript } from '../types.ts'

export interface TranscriptCacheOptions {
  readonly ttlMs: number
  readonly maxEntries?: number
  readonly now?: () => number
}

interface Entry {
  readonly key: string
  readonly transcript: Transcript
  readonly expiresAt: number
}

export class TranscriptCache {
  /** Insertion order is load order, so the first entry is always the oldest. */
  readonly #byKey = new Map<string, Entry>()
  readonly #byId = new Map<string, Entry>()
  readonly #inflight = new Map<string, Promise<Transcript>>()
  /** Bumped by clear() so loads that were in flight cannot repopulate the cache. */
  #generation = 0
  #sweep: ReturnType<typeof setTimeout> | undefined

  constructor(readonly options: TranscriptCacheOptions) {}

  load(key: string, loader: () => Promise<Transcript>): Promise<Transcript> {
    const hit = this.#byKey.get(key)
    if (hit !== undefined) {
      if (hit.expiresAt > this.#now()) return Promise.resolve(hit.transcript)
      this.#evict(hit)
    }
    const pending = this.#inflight.get(key)
    if (pending !== undefined) return pending

    const generation = this.#generation
    const loading = run(loader)
      .then(transcript => {
        if (this.options.ttlMs > 0 && generation === this.#generation) this.#store(key, transcript)
        return transcript
      })
      .finally(() => {
        if (this.#inflight.get(key) === loading) this.#inflight.delete(key)
      })
    this.#inflight.set(key, loading)
    return loading
  }

  get(id: string): Transcript | undefined {
    const entry = this.#byId.get(id)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.#now()) {
      this.#evict(entry)
      return undefined
    }
    return entry.transcript
  }

  prune(): void {
    const now = this.#now()
    for (const entry of this.#byKey.values()) if (entry.expiresAt <= now) this.#evict(entry)
  }

  clear(): void {
    this.#generation++
    this.#byKey.clear()
    this.#byId.clear()
    this.#inflight.clear()
    if (this.#sweep !== undefined) clearTimeout(this.#sweep)
    this.#sweep = undefined
  }

  get size(): number {
    this.prune()
    return this.#byKey.size
  }

  #store(key: string, transcript: Transcript): void {
    const previous = this.#byKey.get(key)
    if (previous !== undefined) this.#evict(previous)
    const entry: Entry = { key, transcript, expiresAt: this.#now() + this.options.ttlMs }
    this.#byKey.set(key, entry)
    this.#byId.set(transcript.id, entry)
    const max = Math.max(1, this.options.maxEntries ?? 50)
    for (const oldest of this.#byKey.values()) {
      if (this.#byKey.size <= max) break
      this.#evict(oldest)
    }
    this.#armSweep()
  }

  #evict(entry: Entry): void {
    if (this.#byKey.get(entry.key) === entry) this.#byKey.delete(entry.key)
    if (this.#byId.get(entry.transcript.id) === entry) this.#byId.delete(entry.transcript.id)
  }

  /**
   * Lazy eviction alone would keep expired message text in RAM until the next
   * cache access; a background sweep releases it within about one TTL. The
   * timer is unref'd so it never keeps the process alive.
   */
  #armSweep(): void {
    if (this.#sweep !== undefined) return
    const timer = setTimeout(() => {
      this.#sweep = undefined
      this.prune()
      if (this.#byKey.size > 0) this.#armSweep()
    }, this.options.ttlMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    this.#sweep = timer
  }

  #now(): number {
    return (this.options.now ?? Date.now)()
  }
}

/** Run a loader, turning a synchronous throw into a rejection. */
function run<T>(loader: () => Promise<T>): Promise<T> {
  try {
    return loader()
  } catch (error) {
    return Promise.reject(error)
  }
}
