import { Database } from 'bun:sqlite'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { ProtectedDialogSink } from '../adapters/workdesk-dialog-store.ts'
import { withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import { object, workdeskTask } from '../core/workdesk.ts'
import { type DialogTarget, ownerMessages, validCursor, type WorkdeskDialogConfig } from '../core/workdesk-dialog.ts'

export function openWorkdeskInbox(path: unknown, readOnly = false) {
  const uid = process.getuid?.()
  if (process.platform !== 'darwin' || !uid || typeof path !== 'string' || !isAbsolute(path))
    throw new Error('Protected inbox path or UID unavailable')
  const dir = lstatSync(dirname(path))
  const file = lstatSync(path)
  if (
    !dir.isDirectory() ||
    !file.isFile() ||
    dir.uid !== uid ||
    file.uid !== uid ||
    (dir.mode & 0o777) !== 0o700 ||
    (file.mode & 0o777) !== 0o600 ||
    file.nlink !== 1
  )
    throw new Error('Protected inbox permissions unavailable')
  const db = new Database(path, readOnly ? { readonly: true } : { readwrite: true })
  try {
    if (
      db
        .query(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name NOT IN ('inbox_state','workdesk_dialog_messages')",
        )
        .get()
    )
      throw new Error('Protected inbox requires a dedicated database')
    if (readOnly) {
      db.query('SELECT sealed FROM workdesk_dialog_messages LIMIT 0').get()
      return db
    }
    db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inbox_state (binding TEXT PRIMARY KEY, through INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workdesk_dialog_messages (
        assignment_id TEXT NOT NULL, message_id INTEGER NOT NULL, sealed BLOB NOT NULL,
        PRIMARY KEY (assignment_id, message_id)
      );
    `)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

const inboxTools = ['list_board_tasks', 'read_owner_messages', 'ack_owner_messages']
export async function workdeskInboxToolsAvailable(config: WorkdeskDialogConfig) {
  return withWorkdeskMcp(config, AbortSignal.timeout(10000), async mcp => {
    const tools = await mcp.tools()
    return inboxTools.every(name => tools.has(name))
  }).catch(() => false)
}

export function startWorkdeskInbox(
  db: Database,
  config: WorkdeskDialogConfig,
  pin: DialogTarget,
  sink: ProtectedDialogSink,
  permits: () => boolean,
) {
  const binding = JSON.stringify(pin)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let current: Promise<void> | undefined

  async function poll() {
    if (!permits() || !sink.permits(pin)) return
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
    const key = { task_id: pin.task_id, assignment_id: pin.assignment_id, executor: pin.executor }
    await withWorkdeskMcp(config, signal, async mcp => {
      const tools = await mcp.tools()
      if (!inboxTools.every(name => tools.has(name))) return
      async function revision() {
        const reply = object(await mcp.call('list_board_tasks', {}))
        const rows = Array.isArray(reply?.tasks) ? reply.tasks.filter(task => object(task)?.id === pin.task_id) : []
        const task = rows.length === 1 ? workdeskTask(rows[0]) : null
        return task &&
          task.status !== 'queued' &&
          task.executor === pin.executor &&
          task.assignment?.id === pin.assignment_id
          ? task.assignment.revision
          : null
      }
      const observedRevision = await revision()
      if (observedRevision === null || !permits() || !sink.permits(pin)) return
      const after =
        db.query<{ through: number }, [string]>('SELECT through FROM inbox_state WHERE binding=?').get(binding)
          ?.through ?? 0
      const page = ownerMessages(await mcp.call('read_owner_messages', { ...key, after }), pin, after)
      if (!page?.entries.length || page.revision !== observedRevision || !permits() || !sink.permits(pin)) return
      signal.throwIfAborted()
      const tx = { db }
      db.transaction(() => {
        for (const message of page.entries) {
          const existing = db
            .query('SELECT 1 FROM workdesk_dialog_messages WHERE assignment_id=? AND message_id=?')
            .get(pin.assignment_id, message.id)
          if (!existing) sink.stage(tx, pin, message)
          else if (!sink.contains(tx, pin, message)) throw new Error('Protected Workdesk replay mismatch')
        }
      }).immediate()
      if ((await revision()) !== page.revision || !permits() || !sink.permits(pin)) return
      signal.throwIfAborted()
      if (page.deliveredThrough < page.cursor) {
        const receipt = object(await mcp.call('ack_owner_messages', { ...key, through: page.cursor }))
        if (
          receipt?.task_id !== pin.task_id ||
          receipt.assignment_id !== pin.assignment_id ||
          !validCursor(receipt.delivered_through) ||
          receipt.delivered_through < page.cursor ||
          typeof receipt.replayed !== 'boolean'
        )
          return
      }
      db.run(
        `INSERT INTO inbox_state VALUES (?,?) ON CONFLICT(binding) DO UPDATE SET through=MAX(through,excluded.through)`,
        [binding, page.cursor],
      )
    })
  }

  function tick() {
    current = poll()
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) timer = setTimeout(tick, config.intervalSec * 1000)
      })
  }
  tick()
  return async () => {
    controller.abort()
    clearTimeout(timer)
    await current
  }
}
