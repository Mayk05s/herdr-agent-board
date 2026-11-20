import type { Item } from '../core/types.ts'
import type { DialogProblem, DialogTarget, OwnerEvent, OwnerMessage } from '../core/workdesk-dialog.ts'
import { workdeskAgent } from '../core/workdesk-topology.ts'
import type { BoardDb, Tx } from './db.ts'
import { appendEntry, getThread } from './work-thread-store.ts'
import { workdeskHandoffReader } from './workdesk-store.ts'

type Binding = DialogTarget & { revision: number; acknowledged: number }
type Pending = { board_task_id: number; assignment_id: string; count: number }
type Resolved = { binding: Binding } | { problem: DialogProblem }

/**
 * Only a protected reader can supply this, after establishing its durable recipient and
 * authenticated read path. It must stage synchronously using tx, never through the common
 * work thread. The board server does not yet have a sink with those guarantees.
 */
export interface ProtectedDialogSink {
  permits(target: DialogTarget): boolean
  stage(tx: Tx, target: DialogTarget, message: OwnerMessage): void
}

export function workdeskDialogStore(db: BoardDb, items: () => readonly Item[] | null) {
  const cursor = () =>
    db.db.query<{ cursor: number }, []>('SELECT cursor FROM workdesk_dialog_cursor WHERE singleton = 1').get()
      ?.cursor ?? 0
  const findBinding = db.db.query<Binding, [number]>('SELECT * FROM workdesk_dialog_bindings WHERE task_id = ?')

  function resolve(group: Pending): Resolved {
    const handoff = workdeskHandoffReader(db)(group.board_task_id)
    if (!handoff?.thread_id) return { problem: 'awaiting_claim' }
    const binding = findBinding.get(group.board_task_id)
    if (!binding) return { problem: 'assignment_unverified' }
    if (binding.assignment_id !== group.assignment_id) return { problem: 'assignment_mismatch' }
    const latest = db.db
      .query<{ executor: string | null }, [number, string]>(`
      SELECT executor FROM workdesk_dialog_events WHERE board_task_id = ? AND assignment_id = ? ORDER BY id DESC LIMIT 1
    `)
      .get(group.board_task_id, group.assignment_id)
    if (binding.executor !== handoff.executor || (latest?.executor && latest.executor !== binding.executor))
      return { problem: 'executor_changed' }
    const thread = getThread(db, binding.thread_id)
    if (!thread) return { problem: 'thread_missing' }
    if (
      thread.id !== handoff.thread_id ||
      thread.scope !== 'local' ||
      thread.assignee?.kind !== 'session' ||
      thread.assignee.key !== handoff.session_key ||
      thread.assignee.name !== binding.executor
    )
      return { problem: 'thread_reassigned' }
    const matches = items()?.filter(item => item.session === binding.sid || item.key === handoff.session_key) ?? []
    const item = matches[0]
    if (
      matches.length !== 1 ||
      item?.session !== binding.sid ||
      item.key !== handoff.session_key ||
      !workdeskAgent(item.agent)
    )
      return { problem: 'session_unavailable' }
    return { binding }
  }

  function current(group: Pending, expected: Binding): Resolved {
    const resolved = resolve(group)
    if ('problem' in resolved) return resolved
    const { binding } = resolved
    return binding.thread_id === expected.thread_id &&
      binding.sid === expected.sid &&
      binding.executor === expected.executor
      ? resolved
      : { problem: 'assignment_mismatch' }
  }

  return {
    cursor,
    retain(after: number, entries: OwnerEvent[], through: number): boolean {
      return db.write('workdesk-dialog', ({ db: sql }) => {
        if (cursor() !== after) return false
        const insert = sql.query(`INSERT INTO workdesk_dialog_events
          (id, board_task_id, assignment_id, revision, executor, board_status, kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        for (const e of entries)
          insert.run(
            e.id,
            e.board_task_id,
            e.assignment_id,
            e.revision,
            e.executor,
            e.board_status,
            e.kind,
            e.created_at,
          )
        if (entries.length)
          sql
            .query(`INSERT INTO workdesk_dialog_cursor VALUES (1, ?)
                     ON CONFLICT(singleton) DO UPDATE SET cursor = excluded.cursor`)
            .run(through)
        return true
      })
    },
    pending(): Pending[] {
      return db.db
        .query<Pending, []>(`
        SELECT board_task_id, assignment_id, COUNT(*) AS count
        FROM workdesk_dialog_events
        GROUP BY board_task_id, assignment_id ORDER BY MIN(id)
      `)
        .all()
    },
    resolve,
    current,
    notice(group: Pending, expected: Binding, now: number): DialogProblem | null {
      return db.write('workdesk-dialog', tx => {
        const resolved = current(group, expected)
        if ('problem' in resolved) return resolved.problem
        tx.db
          .query(`
          UPDATE workdesk_dialog_bindings
          SET revision = MAX(revision, COALESCE((
            SELECT MAX(revision) FROM workdesk_dialog_events
            WHERE board_task_id = ?1 AND assignment_id = ?2 AND kind = 'rework'
          ), revision))
          WHERE task_id = ?1 AND assignment_id = ?2
        `)
          .run(expected.task_id, expected.assignment_id)
        const updated = tx.db
          .query(`
          UPDATE workdesk_dialog_events SET noticed = 1 WHERE board_task_id = ? AND assignment_id = ? AND noticed = 0
        `)
          .run(expected.task_id, expected.assignment_id)
        if (updated.changes)
          appendEntry(tx, expected.thread_id, {
            type: 'note',
            author: { kind: 'owner' },
            at: now,
            text: 'В Workdesk появилось обновление диалога по этой карточке.',
          })
        return null
      })
    },
    stage(
      group: Pending,
      expected: Binding,
      revision: number,
      messages: OwnerMessage[],
      through: number,
      sink: ProtectedDialogSink,
    ): DialogProblem | null {
      return db.write('workdesk-dialog', tx => {
        const resolved = current(group, expected)
        if ('problem' in resolved) return resolved.problem
        const { binding } = resolved
        if (binding.acknowledged !== expected.acknowledged || binding.revision > revision) return 'invalid_page'
        if (!sink.permits(binding)) return 'protected_delivery_unavailable'
        const known = tx.db
          .query<OwnerEvent, [number, string, number, number]>(`
          SELECT * FROM workdesk_dialog_events
          WHERE board_task_id = ? AND assignment_id = ? AND id > ? AND id <= ?
        `)
          .all(binding.task_id, binding.assignment_id, binding.acknowledged, through)
        const page = new Map(messages.map(message => [message.id, message]))
        if (
          known.some(event => {
            const message = page.get(event.id)
            return message?.kind !== event.kind || message.revision !== event.revision
          })
        )
          return 'invalid_page'
        const receipt = tx.db.query('INSERT OR IGNORE INTO workdesk_dialog_receipts VALUES (?, ?)')
        for (const message of messages) {
          if (receipt.run(binding.assignment_id, message.id).changes) sink.stage(tx, binding, message)
        }
        tx.db.query('UPDATE workdesk_dialog_bindings SET revision = ? WHERE task_id = ?').run(revision, binding.task_id)
        return null
      })
    },
    confirm(expected: Binding, through: number): void {
      db.write('workdesk-dialog', ({ db: sql }) => {
        sql
          .query(`UPDATE workdesk_dialog_bindings SET acknowledged = MAX(acknowledged, ?)
                   WHERE task_id = ? AND assignment_id = ?`)
          .run(through, expected.task_id, expected.assignment_id)
        sql
          .query('DELETE FROM workdesk_dialog_events WHERE board_task_id = ? AND assignment_id = ? AND id <= ?')
          .run(expected.task_id, expected.assignment_id, through)
      })
    },
  }
}
