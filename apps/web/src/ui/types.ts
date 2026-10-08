/**
 * What the chat view renders. Lives only in React memory: nothing here is
 * written to localStorage, sessionStorage or IndexedDB (privacy requirement).
 */

import type { SpecialistKind, TranscriptStats, WireUsage } from '@meobeo/backend/wire'

/** Map/reduce progress of one specialist agent. */
export interface AgentProgress {
  readonly agent: SpecialistKind
  readonly stage: 'map' | 'reduce' | 'single'
  readonly done: number
  readonly total: number
}

/** One entry of a turn's "process" timeline. */
export type Step =
  | { readonly kind: 'commentary'; readonly id: string; readonly blockId: string; readonly text: string }
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string }
  | {
    readonly kind: 'tool'
    /** The tool call id. */
    readonly id: string
    readonly name: string
    readonly input: unknown
    readonly status: 'running' | 'completed' | 'failed'
    /** Progress of the specialist this tool runs (summarize/extract/answer). */
    readonly progress?: AgentProgress
  }
  | {
    readonly kind: 'fetch'
    readonly id: string
    readonly fetched: number
    /** ISO time the scan has reached (channels page back from now). */
    readonly scannedBackTo?: string
    /** Label of the month being read when a long period is split. */
    readonly segment?: string
  }
  | { readonly kind: 'transcript'; readonly id: string; readonly stats: TranscriptStats }
  /** Specialist progress that matched no tool call (kept so nothing is lost). */
  | ({ readonly kind: 'agent'; readonly id: string } & AgentProgress)

export interface AnswerBlock {
  readonly blockId: string
  readonly text: string
}

export interface TurnError {
  readonly message: string
  /** Codes and status, for whoever is diagnosing rather than reading. */
  readonly detail?: string
  /** The server rejected the Microsoft token: offer to sign in again. */
  readonly reauth?: boolean
}

export interface Turn {
  readonly id: string
  readonly prompt: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly status: 'running' | 'done' | 'stopped' | 'failed'
  readonly steps: readonly Step[]
  readonly answer: readonly AnswerBlock[]
  /** False when the run ended without a complete answer (step limit, abort). */
  readonly completed?: boolean
  readonly usage?: WireUsage
  readonly error?: TurnError
}

/** One conversation: everything said about one source since the last "Cuộc trò chuyện mới". */
export interface Thread {
  readonly conversationId: string
  readonly turns: readonly Turn[]
}
