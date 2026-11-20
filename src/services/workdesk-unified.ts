import { Database } from 'bun:sqlite'
import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { type BoardDb, openDb } from '../adapters/db.ts'
import { appendEntry, getThread } from '../adapters/work-thread-store.ts'
import { WorkdeskToolError, withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import { workdeskHandoffReader } from '../adapters/workdesk-store.ts'
import { isMirrored } from '../core/thread-import.ts'
import { cleanText, type ThreadStatus } from '../core/work-threads.ts'
import { object, validAssignmentId, workdeskMcpConfig, workdeskTask } from '../core/workdesk.ts'
import { workdeskDialogConfig } from '../core/workdesk-dialog.ts'
import type { WorkdeskEvent } from '../core/workdesk-events.ts'

function settings(cfg: { workdesk?: unknown; workdeskDialog?: unknown }) {
  const raw = object(object(cfg.workdesk)?.unified)
  const board = workdeskMcpConfig(raw)
  const isolation = object(raw?.isolation)
  const dialog = workdeskDialogConfig(cfg.workdeskDialog, cfg.workdesk)
  const id = dialog?.onlyTaskId
  const pin = id === undefined ? undefined : dialog?.legacyBindings.get(id)
  return board && pin && isolation ? { board, pin, isolation } : null
}

function isolated(config: NonNullable<ReturnType<typeof settings>>, role: 'writerUid' | 'senderUid') {
  const { writerUid, senderUid, interactiveUid, sharedGid, queuePath, executor } = config.isolation
  const uids = [writerUid, senderUid, interactiveUid]
  if (
    process.platform !== 'darwin' ||
    typeof queuePath !== 'string' ||
    !isAbsolute(queuePath) ||
    typeof executor !== 'string' ||
    !executor.trim() ||
    executor.length > 100 ||
    ![...uids, sharedGid].every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
    new Set(uids).size !== uids.length ||
    process.getuid?.() !== config.isolation[role]
  )
    return false
  try {
    const directory = lstatSync(dirname(queuePath))
    const database = lstatSync(queuePath)
    return (
      directory.isDirectory() &&
      database.isFile() &&
      directory.uid === writerUid &&
      database.uid === writerUid &&
      directory.gid === sharedGid &&
      database.gid === sharedGid &&
      (directory.mode & 0o777) === 0o770 &&
      (database.mode & 0o777) === 0o660
    )
  } catch {
    return false
  }
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
  const config = settings(cfg)
  return !!config && isolated(config, 'writerUid')
}

export function queueNativeWorkdeskMessage(
  cfg: { workdesk?: unknown; workdeskDialog?: unknown },
  sid: string,
  args: unknown,
) {
  const config = settings(cfg)
  const input = object(args)
  const requestId = input?.request_id
  const kind = input?.kind ?? 'message'
  const text = typeof input?.text === 'string' ? cleanText(input.text, 12001) : ''
  if (
    !config ||
    !isolated(config, 'writerUid') ||
    sid !== config.pin.sessionId ||
    !validAssignmentId(requestId) ||
    !input ||
    (kind !== 'message' && kind !== 'question') ||
    Object.keys(input).some(key => key !== 'request_id' && key !== 'text' && key !== 'kind') ||
    !text ||
    text.length > (kind === 'question' ? 4000 : 12000)
  )
    return null
  const { taskId, assignmentId, threadId } = config.pin
  const executor = config.isolation.executor as string
  const db = openQueue(config)
  try {
    return db
      .transaction(() => {
        const prior = db
          .query<Pending, [string, string]>('SELECT * FROM outbox WHERE assignment_id=? AND request_id=?')
          .get(assignmentId, requestId)
        if (prior) {
          return prior.task_id === taskId &&
            prior.thread_id === threadId &&
            prior.sid === sid &&
            prior.executor === executor &&
            prior.kind === kind &&
            prior.text === text
            ? { entry_uuid: prior.entry_id, state: prior.state, replayed: true }
            : null
        }
        const entryId = crypto.randomUUID()
        db.run(
          'INSERT INTO outbox (entry_id,request_id,task_id,assignment_id,thread_id,sid,executor,kind,text) VALUES (?,?,?,?,?,?,?,?,?)',
          [entryId, requestId, taskId, assignmentId, threadId, sid, executor, kind, text],
        )
        return { entry_uuid: entryId, state: 'pending', replayed: false }
      })
      .immediate()
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

type Pending = {
  entry_id: string
  task_id: number
  thread_id: string
  sid: string
  executor: string
  text: string
  kind: string
  state: string
  payload: string | null
}

function openQueue(config: NonNullable<ReturnType<typeof settings>>) {
  const db = new Database(config.isolation.queuePath as string, { readwrite: true })
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL')
    if (db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT IN ('outbox') LIMIT 1").get())
      throw new Error('The Workdesk sender requires a dedicated queue database')
    db.exec(`CREATE TABLE IF NOT EXISTS outbox (
      entry_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, task_id INTEGER NOT NULL,
      assignment_id TEXT NOT NULL, thread_id TEXT NOT NULL, sid TEXT NOT NULL, executor TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('message','question')), text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', payload TEXT, message_id INTEGER,
      UNIQUE (assignment_id, request_id)
    )`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function receiptDir(config: NonNullable<ReturnType<typeof settings>>) {
  const path = config.isolation.receiptDir
  if (typeof path !== 'string' || !isAbsolute(path)) return null
  const stat = lstatSync(path)
  return stat.isDirectory() && stat.uid === config.isolation.senderUid && (stat.mode & 0o777) === 0o755 ? path : null
}

export function importWorkdeskReceipts(cfg: { workdesk?: unknown; workdeskDialog?: unknown }) {
  const config = settings(cfg)
  if (!config?.isolation.receiptDir) return
  try {
    const dir = receiptDir(config)
    if (!dir) return
    const receipts = readdirSync(dir).flatMap(name => {
      const id = name.replace(/\.json$/, '')
      if (name !== `${id}.json` || !validAssignmentId(id)) return []
      const file = join(dir, name)
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.uid !== config.isolation.senderUid || (stat.mode & 0o777) !== 0o444 || stat.size > 512)
        return []
      const receipt = object(JSON.parse(readFileSync(file, 'utf8')))
      return receipt?.assignment === config.pin.assignmentId &&
        receipt.thread === config.pin.threadId &&
        (receipt.state === 'sent' || receipt.state === 'conflict')
        ? [{ id, state: receipt.state, at: stat.mtimeMs }]
        : []
    })
    if (!receipts.length) return
    const db = openDb({ create: false })
    if (!db) return
    try {
      db.write('workdesk-unified', tx => {
        const target = binding(tx, config)
        if (
          !target ||
          target.executor !== config.isolation.executor ||
          target.head.status === 'done' ||
          target.head.status === 'dropped'
        )
          return
        const existing = tx.db.query('SELECT 1 FROM thread_entries WHERE id=?')
        for (const receipt of receipts) {
          if (existing.get(receipt.id)) continue
          appendEntry(tx, target.head.id, {
            id: receipt.id,
            at: Math.trunc(receipt.at),
            author: { kind: 'session', key: target.sid, name: target.executor },
            type: 'system',
            text: receipt.state === 'sent' ? 'Сообщение доставлено в Workdesk.' : 'Workdesk отклонил отправку.',
          })
        }
      })
    } finally {
      db.close()
    }
  } catch {
    // Receipt access is optional and never affects regular Board polling.
  }
}

export function startWorkdeskUnified(cfg: { workdesk?: unknown; workdeskDialog?: unknown }) {
  const startup = settings(cfg)
  if (!startup || !isolated(startup, 'senderUid')) return null
  let current: Promise<void> | undefined
  const controller = new AbortController()
  async function flush() {
    const config = settings(cfg)
    if (!config || !isolated(config, 'senderUid') || controller.signal.aborted) return
    const db = openQueue(config)
    try {
      const dir = receiptDir(config)
      if (!dir) return
      const terminal = db
        .query<Pending, [number, string, string, string, string]>(
          "SELECT entry_id,state FROM outbox WHERE task_id=? AND assignment_id=? AND thread_id=? AND sid=? AND executor=? AND state IN ('sent','conflict')",
        )
        .all(
          config.pin.taskId,
          config.pin.assignmentId,
          config.pin.threadId,
          config.pin.sessionId,
          config.isolation.executor as string,
        )
      for (const receipt of terminal) {
        if (!validAssignmentId(receipt.entry_id)) continue
        const path = join(dir, `${receipt.entry_id}.json`)
        try {
          lstatSync(path)
          continue
        } catch {}
        const temp = join(dir, `.${receipt.entry_id}.tmp`)
        try {
          unlinkSync(temp)
        } catch {}
        writeFileSync(
          temp,
          JSON.stringify({ assignment: config.pin.assignmentId, thread: config.pin.threadId, state: receipt.state }),
          { mode: 0o444, flag: 'wx' },
        )
        chmodSync(temp, 0o444)
        renameSync(temp, path)
      }
      const row = db
        .query<Pending, [number, string, string, string, string]>(
          "SELECT * FROM outbox WHERE task_id=? AND assignment_id=? AND thread_id=? AND sid=? AND executor=? AND state='pending' ORDER BY rowid LIMIT 1",
        )
        .get(
          config.pin.taskId,
          config.pin.assignmentId,
          config.pin.threadId,
          config.pin.sessionId,
          config.isolation.executor as string,
        )
      if (!row) return
      const mark = (state: string, messageId: number | null = null) => {
        db.run('UPDATE outbox SET state=?,message_id=? WHERE entry_id=?', [state, messageId, row.entry_id])
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
      const claim = await withWorkdeskMcp(config.board, signal, async mcp => {
        const reply = object(await mcp.call('list_board_tasks', {}))
        return Array.isArray(reply?.tasks) ? reply.tasks.map(workdeskTask).find(t => t?.id === config.pin.taskId) : null
      })
      if (
        claim?.assignment?.id !== config.pin.assignmentId ||
        claim.executor !== row.executor ||
        claim.status === 'queued'
      )
        return mark('conflict')
      const scope = {
        task_id: config.pin.taskId,
        assignment_id: config.pin.assignmentId,
        revision: claim.assignment.revision,
      }
      const payload =
        row.kind === 'question'
          ? { ...scope, status: 'waiting', summary: row.text }
          : {
              ...scope,
              executor: row.executor,
              thread_uuid: row.thread_id,
              entry_uuid: row.entry_id,
              author: row.executor,
              text: row.text,
            }
      const frozen = JSON.stringify(payload)
      if (row.payload !== null && row.payload !== frozen) return mark('conflict')
      if (controller.signal.aborted || !isolated(config, 'senderUid')) return
      const reserved = db.run("UPDATE outbox SET payload=?,state=? WHERE entry_id=? AND state='pending'", [
        frozen,
        row.kind === 'question' ? 'unknown' : 'pending',
        row.entry_id,
      ])
      if (!reserved.changes) return
      try {
        const result =
          row.kind === 'question'
            ? await withWorkdeskMcp(config.board, signal, mcp => mcp.call('report_task', payload))
            : await withWorkdeskMcp(config.board, signal, mcp => mcp.call('post_board_thread_message', payload))
        if (row.kind === 'question') {
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
  return async () => {
    clearInterval(timer)
    controller.abort()
    await current
  }
}
