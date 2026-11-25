import type { Item } from './types.ts'

export const DEVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TASK_LIMIT = 100
export const WORKER_LIMIT = 50
const BYTE_LIMIT = 16_384
// biome-ignore lint/suspicious/noControlCharactersInRegex: topology v1's name contract
const NAME_CONTROL = /[\x00-\x1f\x7f]/

export interface MasterObservation {
  session_id: string
  name: string
  task_ids: number[]
  workers_active: number | null
}

export interface WorkdeskTopology {
  version: 1
  device_id: string
  observed_at: number
  masters: MasterObservation[]
}

export interface BoardObservation {
  items: readonly Item[]
  observedAt: number
}

/** Native session identity, never a synthesized pane key. */
export const stableWorkdeskSid = (id: unknown): id is string =>
  typeof id === 'string' && SESSION_ID.test(id) && !id.startsWith('pane-')

export const workdeskAgent = (agent: unknown): boolean => agent === 'claude' || agent === 'codex'

export function topologyV1(device: string, observedAt: number, masters: MasterObservation[]): WorkdeskTopology | null {
  if (!DEVICE_ID.test(device) || !Number.isSafeInteger(observedAt) || observedAt < 1 || masters.length > TASK_LIMIT)
    return null
  const tasks = masters.flatMap(master => master.task_ids)
  if (tasks.length > TASK_LIMIT || new Set(tasks).size !== tasks.length) return null
  if (
    new Set(masters.map(master => master.name.trim())).size !== masters.length ||
    new Set(masters.map(master => master.session_id)).size !== masters.length
  )
    return null
  for (const master of masters) {
    if (
      !stableWorkdeskSid(master.session_id) ||
      !master.name.trim() ||
      master.name.length > 100 ||
      NAME_CONTROL.test(master.name)
    )
      return null
    if (!master.task_ids.every(id => Number.isSafeInteger(id) && id > 0)) return null
    const workers = master.workers_active
    if (workers !== null && (!Number.isSafeInteger(workers) || workers < 0 || workers > WORKER_LIMIT)) return null
  }
  const snapshot: WorkdeskTopology = { version: 1, device_id: device, observed_at: observedAt, masters }
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= BYTE_LIMIT ? snapshot : null
}
