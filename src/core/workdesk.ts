import { isAbsolute } from 'node:path'

const DEFAULT_MASTERS = {
  BoxMap: 'BoxMap-master',
  MokuPilot: 'MokuPilot-master',
  CV: 'CV-master',
  Board: 'Board-master',
  Tripio: 'Tripio-master',
  Трипио: 'Tripio-master',
  Hermes: 'Tripio-master',
  LessonPilot: 'LessonPilot-master',
  Workdesk: 'Workdesk-master',
}

export type WorkdeskConfig = {
  executable: string
  args: string[]
  caFile?: string
  intervalSec: number
  masters: Map<string, string>
  fallback: string
  onlyTaskId?: number
}

export const projectKey = (name: string): string => name.trim().toLowerCase()

export const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

export const validTaskId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0

// biome-ignore lint/suspicious/noControlCharactersInRegex: exclude control characters from local argv paths and names
const localWord = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !/[\x00-\x1f\x7f]/.test(v)

export function workdeskConfig(raw: unknown): WorkdeskConfig | null {
  const config = object(raw)
  if (!config) return null
  const {
    executable,
    args = [],
    caFile,
    intervalSec = 120,
    masters = {},
    fallback = 'Coordinator-backup',
    onlyTaskId,
  } = config
  if (
    !localWord(executable) ||
    !isAbsolute(executable) ||
    !Array.isArray(args) ||
    !args.every(arg => typeof arg === 'string' && !arg.includes('\0')) ||
    (caFile !== undefined && (!localWord(caFile) || !isAbsolute(caFile))) ||
    typeof intervalSec !== 'number' ||
    !Number.isFinite(intervalSec) ||
    intervalSec < 1 ||
    intervalSec > 86400 ||
    !localWord(fallback) ||
    (onlyTaskId !== undefined && !validTaskId(onlyTaskId))
  )
    return null

  const routes = object(masters)
  if (!routes) return null
  const mapping = new Map(Object.entries(DEFAULT_MASTERS).map(([project, name]) => [projectKey(project), name]))
  for (const [project, name] of Object.entries(routes)) {
    if (!localWord(project) || !localWord(name)) return null
    mapping.set(projectKey(project), name.trim())
  }
  return {
    executable,
    args,
    intervalSec,
    masters: mapping,
    fallback: fallback.trim(),
    ...(caFile !== undefined && { caFile }),
    ...(onlyTaskId !== undefined && { onlyTaskId }),
  }
}

export type WorkdeskProblem =
  | 'config'
  | 'tools'
  | 'connection'
  | 'heartbeat'
  | 'list'
  | 'claim'
  | 'threads'
  | 'master'
  | 'conflict'
  | 'handoff'

export type WorkdeskPayload = {
  queue: number | null
  polledAt: number | null
  problem: WorkdeskProblem | null
}

export type WorkdeskExecutorModel = 'codex' | 'claude-opus'

export type WorkdeskTask = {
  id: number
  title: string
  project: string
  description: string
  acceptance: string
  url: string
  status: 'queued' | 'doing' | 'waiting'
  executor: string | null
  executor_model: WorkdeskExecutorModel
}

export function workdeskTask(raw: unknown): WorkdeskTask | null {
  const task = object(raw)
  if (!task) return null
  const { id, title, project, description, acceptance, url, status, executor, executor_model = 'codex' } = task
  if (
    !validTaskId(id) ||
    typeof title !== 'string' ||
    !title.trim() ||
    typeof project !== 'string' ||
    typeof description !== 'string' ||
    typeof acceptance !== 'string' ||
    typeof url !== 'string' ||
    (status !== 'queued' && status !== 'doing' && status !== 'waiting') ||
    (executor !== null && typeof executor !== 'string') ||
    (executor_model !== 'codex' && executor_model !== 'claude-opus')
  )
    return null
  return { id, title, project, description, acceptance, url, status, executor, executor_model }
}
