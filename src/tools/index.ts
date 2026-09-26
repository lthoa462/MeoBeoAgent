import type { Tool } from '../core/tool.ts'
import { lookupCurriculum } from './curriculum.ts'
import { saveLesson } from './files.ts'
import { analyzeQuadratic, calculate, describeStatistics } from './math.ts'

export const allTools: Tool[] = [lookupCurriculum, calculate, analyzeQuadratic, describeStatistics, saveLesson]
