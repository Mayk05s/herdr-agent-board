import { isAbsolute } from 'node:path'
import { object, validAssignmentId, validTaskId } from './workdesk.ts'

const TYPES = [
  'task.created',
  'task.assigned_board',
  'task.claimed',
  'task.reported',
  'owner.message',
  'owner.rework',
  'task.accepted',
] as const

type EventType = (typeof TYPES)[number]
type ReportStatus = 'doing' | 'waiting' | 'done' | 'failed'
type Metadata = {
  id: number
  created_at: number
  board_task_id: number
  miniapp_id: number | null
  assignment_id: string
  revision: number
}

export type WorkdeskEvent = Metadata &
  (
    | { type: 'task.reported'; status: ReportStatus; stage: string | null }
    | { type: 'owner.message' | 'owner.rework'; message_id: number }
    | { type: Exclude<EventType, 'task.reported' | 'owner.message' | 'owner.rework'> }
  )

export function eventCursor(raw: string): number | null {
  if (!/^\d{1,16}$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

function eventType(value: unknown): value is EventType {
  return TYPES.some(type => type === value)
}

export function workdeskEvent(idLine: string, eventLine: string, data: string): WorkdeskEvent | null {
  const body = object(JSON.parse(data))
  if (!body) return null
  const { id, type, created_at, board_task_id, miniapp_id, assignment_id, revision } = body
  if (
    !validTaskId(id) ||
    eventCursor(idLine) !== id ||
    !eventType(type) ||
    type !== eventLine ||
    !validTaskId(created_at) ||
    !validTaskId(board_task_id) ||
    (miniapp_id !== null && !validTaskId(miniapp_id)) ||
    !validAssignmentId(assignment_id) ||
    !validTaskId(revision)
  )
    return null

  const common = { id, created_at, board_task_id, miniapp_id, assignment_id, revision }
  const keys = Object.keys(body).length
  if (type === 'task.reported') {
    const { status, stage } = body
    if (
      keys !== 9 ||
      (status !== 'doing' && status !== 'waiting' && status !== 'done' && status !== 'failed') ||
      (stage !== null && typeof stage !== 'string')
    )
      return null
    return { ...common, type, status, stage }
  }
  if (type === 'owner.message' || type === 'owner.rework') {
    return keys === 8 && validTaskId(body.message_id) ? { ...common, type, message_id: body.message_id } : null
  }
  return keys === 7 ? { ...common, type } : null
}

export type WorkdeskEventsConfig = { url: string; tokenFile: string; caFile?: string; cursorEpoch?: string }

export function workdeskEventsConfig(source: unknown): WorkdeskEventsConfig | null {
  const events = object(object(source)?.events)
  if (!events) return null
  const { url, tokenFile, caFile, cursorEpoch } = events
  if (typeof url !== 'string' || typeof tokenFile !== 'string' || !isAbsolute(tokenFile)) return null
  const endpoint = URL.parse(url)
  if (
    endpoint?.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/workdesk/api/board/events'
  )
    return null
  if (caFile !== undefined && (typeof caFile !== 'string' || !isAbsolute(caFile))) return null
  if (cursorEpoch !== undefined && (typeof cursorEpoch !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(cursorEpoch)))
    return null
  return {
    url: endpoint.href,
    tokenFile,
    ...(caFile !== undefined && { caFile }),
    ...(cursorEpoch !== undefined && { cursorEpoch }),
  }
}
