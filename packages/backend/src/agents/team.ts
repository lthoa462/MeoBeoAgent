/**
 * The agents. All use runtime.agent({ id, model: { provider, id }, instructions, ... }).
 *
 * - coordinator (lead, "MeoBeo"): talks to the user; tools come per session
 *   from tools.ts; maxTurns ~8.
 * - specialists (no tools, single-shot via agent.generate):
 *   summarizer, action-tracker, qa — used for the "single" and "reduce" steps.
 * - chunkReader (no tools, uses llm.workerModel): the "map" worker reading one
 *   chunk and extracting notes relevant to a task.
 */

import type { RuntimeAgent } from '@alvin0/ai-agent-sdk-core'
import type { SpecialistKind } from '../types.ts'
import type { LlmRuntime } from '../llm/runtime.ts'
import {
  ACTION_TRACKER_INSTRUCTIONS,
  CHUNK_READER_INSTRUCTIONS,
  COORDINATOR_INSTRUCTIONS,
  QA_INSTRUCTIONS,
  SUMMARIZER_INSTRUCTIONS,
} from './prompts.ts'

export interface AgentTeam {
  readonly coordinator: RuntimeAgent
  readonly specialists: Readonly<Record<SpecialistKind, RuntimeAgent>>
  readonly chunkReader: RuntimeAgent
}

/**
 * Output caps. A specialist's answer becomes a coordinator tool result, which
 * the SDK cuts at ~10k tokens, so the cap stays below that. It is not tighter
 * because reasoning models (OpenAI o-series/GPT-5, Gemini 2.5 thinking) count
 * hidden reasoning against the same cap; brevity comes from the prompts.
 */
const SPECIALIST_MAX_TOKENS = 8_000
const CHUNK_READER_MAX_TOKENS = 4_000

export function createAgentTeam(llm: LlmRuntime): AgentTeam {
  const { runtime, provider } = llm
  const worker = (id: string, name: string, instructions: string, model: string, maxTokens: number): RuntimeAgent =>
    runtime.agent({
      id,
      name,
      model: { provider, id: model },
      instructions,
      maxTokens,
      // One answer per call: there are no tools to loop over.
      maxTurns: 2,
      commentary: 'off',
    })

  return {
    coordinator: runtime.agent({
      id: 'coordinator',
      name: 'MeoBeo',
      description: 'Trợ lý tóm tắt cuộc trò chuyện Microsoft Teams.',
      model: { provider, id: llm.model },
      instructions: COORDINATOR_INSTRUCTIONS,
      // llm.effort is only ever set for OpenAI; Gemini rejects any effort.
      ...(llm.effort === undefined ? {} : { effort: llm.effort }),
      commentary: 'concise',
      maxTurns: 8,
      maxToolCalls: 16,
    }),
    specialists: {
      summarizer: worker('summarizer', 'Summarizer', SUMMARIZER_INSTRUCTIONS, llm.model, SPECIALIST_MAX_TOKENS),
      'action-tracker': worker('action-tracker', 'Action tracker', ACTION_TRACKER_INSTRUCTIONS, llm.model, SPECIALIST_MAX_TOKENS),
      qa: worker('qa', 'Q&A', QA_INSTRUCTIONS, llm.model, SPECIALIST_MAX_TOKENS),
    },
    chunkReader: worker('chunk-reader', 'Chunk reader', CHUNK_READER_INSTRUCTIONS, llm.workerModel, CHUNK_READER_MAX_TOKENS),
  }
}
