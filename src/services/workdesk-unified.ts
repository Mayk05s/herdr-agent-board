import { type BoardDb, openDb } from '../adapters/db.ts'
import { appendEntry, findEntry, getThread } from '../adapters/work-thread-store.ts'
import { WorkdeskToolError, withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import { workdeskHandoffReader } from '../adapters/workdesk-store.ts'
import { isMirrored } from '../core/thread-import.ts'
import type { Item } from '../core/types.ts'
import { cleanText, type ThreadEntry, type ThreadHead, type ThreadStatus } from '../core/work-threads.ts'
import { object, validAssignmentId, workdeskMcpConfig, workdeskTask } from '../core/workdesk.ts'
import { workdeskDialogConfig } from '../core/workdesk-dialog.ts'
import type { WorkdeskEvent } from '../core/workdesk-events.ts'

function settings(cfg: { workdesk?: unknown; workdeskDialog?: unknown }) {
  const board = workdeskMcpConfig(object(cfg.workdesk)?.unified)
  const dialog = workdeskDialogConfig(cfg.workdeskDialog, cfg.workdesk)
  const id = dialog?.onlyTaskId
  const pin = id === undefined ? undefined : dialog?.legacyBindings.get(id)
  return board && dialog && pin ? { board, dialog, pin } : null
}

function binding(db: Pick<BoardDb, 'db'>, config: NonNullable<ReturnType<typeof settings>>) {
  const { pin } = config
  const handoff = workdeskHandoffReader(db as BoardDb)(pin.taskId)
  const head = getThread(db, pin.threadId)
  if (
    handoff?.thread_id !== pin.threadId ||
    handoff.session_key !== pin.sessionId ||
    !head ||
    head.scope !== 'local' ||
    isMirrored(head) ||
    head.assignee?.kind !== 'session' ||
    head.assignee.key !== handoff.session_key ||
    head.assignee.name !== handoff.executor
  )
    return null
  return { head, sid: pin.sessionId, executor: handoff.executor }
}

function eligible(entry: ThreadEntry, head: ThreadHead, target: NonNullable<ReturnType<typeof binding>>) {
  return (
    head.id === target.head.id &&
    entry.author.kind === 'session' &&
    entry.author.key === target.sid &&
    entry.author.name === target.executor &&
    !entry.private &&
    !entry.out &&
    !entry.files?.length &&
    !entry.links?.length &&
    !!entry.text &&
    entry.author.name.length <= 100 &&
    entry.text.length <= (entry.type === 'ask' ? 4000 : 12000) &&
    (entry.type === 'note' || entry.type === 'ask')
  )
}

export const WORKDESK_POST_TOOL = {
  name: 'post_workdesk_message',
  description:
    'Explicitly send a public message to the owner of your assigned Workdesk thread. Use the same request_id when retrying. Returns the durable Board entry UUID and queue status.',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['message', 'question'] },
      text: { type: 'string', minLength: 1, maxLength: 12000 },
    },
    required: ['request_id', 'text'],
    additionalProperties: false,
  },
} as const

export function workdeskUnifiedEnabled(cfg: { workdesk?: unknown; workdeskDialog?: unknown }) {
  return settings(cfg) !== null
}

export function queueNativeWorkdeskMessage(
  cfg: { workdesk?: unknown; workdeskDialog?: unknown },
  sid: string,
  items: readonly Item[] | null,
  args: unknown,
) {
  const config = settings(cfg)
  const input = object(args)
  const requestId = input?.request_id
  const kind = input?.kind ?? 'message'
  const type = kind === 'question' ? 'ask' : 'note'
  const text = typeof input?.text === 'string' ? cleanText(input.text, 12001) : ''
  if (
    !config ||
    sid !== config.pin.sessionId ||
    !validAssignmentId(requestId) ||
    !input ||
    (kind !== 'message' && kind !== 'question') ||
    Object.keys(input).some(key => key !== 'request_id' && key !== 'text' && key !== 'kind') ||
    !text ||
    text.length > (type === 'ask' ? 4000 : 12000)
  )
    return null
  const matches = items?.filter(item => item.key === sid || item.session === sid)
  if (
    matches?.length !== 1 ||
    matches[0]?.key !== sid ||
    matches[0].session !== sid ||
    matches[0].agent !== 'codex' ||
    matches[0].sleeping
  )
    return null
  const db = openDb({ create: false })
  if (!db) return null
  try {
    return db.write('workdesk-unified', tx => {
      const target = binding(tx, config)
      if (!target || target.head.status === 'done' || target.head.status === 'dropped') return null
      const prior = tx.db
        .query<{ entry_id: string; state: string }, [string, string]>(
          'SELECT entry_id,state FROM workdesk_unified_outbox WHERE assignment_id=? AND request_id=?',
        )
        .get(config.pin.assignmentId, requestId)
      if (prior) {
        const saved = findEntry(db, target.head.id, prior.entry_id)
        return eligible(saved, target.head, target) && saved.type === type && saved.text === text
          ? { entry_uuid: prior.entry_id, state: prior.state, replayed: true }
          : null
      }
      const { entry } = appendEntry(tx, target.head.id, {
        at: Date.now(),
        author: { kind: 'session', key: sid, name: target.executor },
        type,
        text,
      })
      tx.db
        .query(
          'INSERT INTO workdesk_unified_outbox (entry_id,request_id,task_id,assignment_id,thread_id,kind) VALUES (?,?,?,?,?,?)',
        )
        .run(entry.id, requestId, config.pin.taskId, config.pin.assignmentId, target.head.id, entry.type)
      return { entry_uuid: entry.id, state: 'pending', replayed: false }
    })
  } finally {
    db.close()
  }
}

export function applyWorkdeskThreadEvent(cfg: { workdesk?: unknown; workdeskDialog?: unknown }, event: WorkdeskEvent) {
  const config = settings(cfg)
  if (!config || event.board_task_id !== config.pin.taskId || event.assignment_id !== config.pin.assignmentId) return
  const db = openDb({ create: false })
  if (!db) return
  try {
    db.write('workdesk-unified', tx => {
      const target = binding(tx, config)
      if (!target) return
      const prior = tx.db
        .query<{ event_id: number; revision: number; state: string }, [string]>(
          'SELECT event_id,revision,state FROM workdesk_unified_status WHERE assignment_id=?',
        )
        .get(event.assignment_id)
      if (prior && (prior.event_id >= event.id || prior.revision > event.revision)) return
      let status: ThreadStatus | undefined
      let waitingOn = ''
      let phase = prior?.state ?? 'doing'
      if (event.type === 'task.reported') {
        phase = event.status
        if (phase === 'waiting') status = 'owner'
        if (phase === 'doing') status = 'doing'
        if (phase === 'done') {
          status = 'waiting'
          waitingOn = 'Приёмка в Workdesk'
        }
      } else if (event.type === 'owner.rework' || (event.type === 'owner.message' && phase === 'waiting')) {
        phase = 'doing'
        status = 'doing'
      } else if (event.type === 'task.accepted') {
        if (phase !== 'done' || prior?.revision !== event.revision) return
        phase = 'accepted'
        status = 'done'
      } else return
      if (status && (target.head.status !== status || (waitingOn && target.head.waitingOn !== waitingOn)))
        appendEntry(tx, target.head.id, {
          at: event.created_at,
          author: { kind: 'owner' },
          type: 'system',
          set: { status, ...(waitingOn && { waitingOn }) },
        })
      tx.db
        .query('INSERT OR REPLACE INTO workdesk_unified_status VALUES (?,?,?,?)')
        .run(event.assignment_id, event.id, event.revision, phase)
    })
  } finally {
    db.close()
  }
}

type Pending = { entry_id: string; kind: string; payload: string | null }

export function startWorkdeskUnified(cfg: { workdesk?: unknown; workdeskDialog?: unknown }) {
  if (!settings(cfg)) return async () => {}
  let current: Promise<void> | undefined
  const controller = new AbortController()
  async function flush() {
    const config = settings(cfg)
    if (!config || controller.signal.aborted) return
    const db = openDb({ create: false })
    if (!db) return
    try {
      const row = db.db
        .query<Pending, [number, string, string]>(
          "SELECT entry_id,kind,payload FROM workdesk_unified_outbox WHERE task_id=? AND assignment_id=? AND thread_id=? AND state='pending' ORDER BY rowid LIMIT 1",
        )
        .get(config.pin.taskId, config.pin.assignmentId, config.pin.threadId)
      if (!row) return
      const mark = (state: string, messageId: number | null = null) =>
        db.write('workdesk-unified', tx => {
          tx.db
            .query('UPDATE workdesk_unified_outbox SET state=?,message_id=? WHERE entry_id=?')
            .run(state, messageId, row.entry_id)
        })
      const target = binding(db, config)
      if (!target) return mark('conflict')
      const entry = findEntry(db, target.head.id, row.entry_id)
      if (!eligible(entry, target.head, target)) return mark('conflict')
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
      const claim = await withWorkdeskMcp(config.dialog, signal, async mcp => {
        const reply = object(await mcp.call('list_board_tasks', {}))
        return Array.isArray(reply?.tasks) ? reply.tasks.map(workdeskTask).find(t => t?.id === config.pin.taskId) : null
      })
      if (claim?.assignment?.id !== config.pin.assignmentId || claim.executor !== target.executor)
        return mark('conflict')
      const scope = {
        task_id: config.pin.taskId,
        assignment_id: config.pin.assignmentId,
        revision: claim.assignment.revision,
      }
      const payload =
        row.kind === 'ask'
          ? { ...scope, status: 'waiting', summary: entry.text }
          : {
              ...scope,
              executor: target.executor,
              thread_uuid: target.head.id,
              entry_uuid: entry.id,
              author: target.executor,
              text: entry.text,
            }
      const frozen = JSON.stringify(payload)
      if (row.payload !== null && row.payload !== frozen) return mark('conflict')
      if (!binding(db, config) || JSON.stringify(settings(cfg)) !== JSON.stringify(config)) return
      db.write('workdesk-unified', tx => {
        tx.db
          .query('UPDATE workdesk_unified_outbox SET payload=?,state=? WHERE entry_id=?')
          .run(frozen, row.kind === 'ask' ? 'unknown' : 'pending', row.entry_id)
      })
      try {
        const result =
          row.kind === 'ask'
            ? await withWorkdeskMcp(config.dialog, signal, mcp => mcp.call('report_task', payload))
            : await withWorkdeskMcp(config.board, signal, mcp => mcp.call('post_board_thread_message', payload))
        if (row.kind === 'ask') {
          if (object(result)?.status === 'waiting') mark('sent')
        } else {
          const receipt = object(result)
          if (
            typeof receipt?.message_id === 'number' &&
            Number.isSafeInteger(receipt.message_id) &&
            receipt.message_id > 0 &&
            typeof receipt.replayed === 'boolean'
          )
            mark('sent', receipt.message_id)
        }
      } catch (error) {
        if (
          error instanceof WorkdeskToolError &&
          (error.conflict || error.code === 'assignment_mismatch' || error.code === 'role_denied')
        )
          mark('conflict')
      }
    } finally {
      db.close()
    }
  }
  const timer = setInterval(() => {
    if (!current)
      current = flush()
        .catch(() => {})
        .finally(() => {
          current = undefined
        })
  }, 1000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    controller.abort()
    await current
  }
}
