import { isMirrored } from '../core/thread-import.ts'
import type { Item } from '../core/types.ts'
import type { WorkdeskTask } from '../core/workdesk.ts'
import type { DialogProblem, DialogTarget, LegacyDialogBinding, OwnerEvent } from '../core/workdesk-dialog.ts'
import { workdeskAgent } from '../core/workdesk-topology.ts'
import type { BoardDb } from './db.ts'
import { appendEntry, getThread } from './work-thread-store.ts'
import { workdeskHandoffReader } from './workdesk-store.ts'

type Handoff = NonNullable<ReturnType<ReturnType<typeof workdeskHandoffReader>>>
type Binding = DialogTarget & { revision: number }
type Pending = { board_task_id: number; assignment_id: string; count: number }
type Resolved = { binding: Binding } | { problem: DialogProblem }

export function workdeskDialogStore(db: BoardDb, items: () => readonly Item[] | null) {
  const cursor = () =>
    db.db.query<{ cursor: number }, []>('SELECT cursor FROM workdesk_dialog_cursor WHERE singleton = 1').get()
      ?.cursor ?? 0
  const findBinding = db.db.query<Binding, [number]>('SELECT * FROM workdesk_dialog_bindings WHERE task_id = ?')

  const latestEvent = db.db.query<{ executor: string | null }, [number, string]>(`
    SELECT executor FROM workdesk_dialog_events WHERE board_task_id = ? AND assignment_id = ? ORDER BY id DESC LIMIT 1
  `)

  function localTarget(handoff: Handoff, target: DialogTarget): DialogProblem | null {
    const thread = getThread(db, target.thread_id)
    if (!thread) return 'thread_missing'
    if (thread.scope !== 'local' || isMirrored(thread)) return 'thread_scope'
    if (
      thread.id !== handoff.thread_id ||
      thread.assignee?.kind !== 'session' ||
      thread.assignee.key !== handoff.session_key ||
      thread.assignee.name !== target.executor
    )
      return 'thread_reassigned'
    const matches = items()?.filter(item => item.session === target.sid || item.key === handoff.session_key) ?? []
    const item = matches[0]
    if (
      matches.length !== 1 ||
      item?.session !== target.sid ||
      item.key !== handoff.session_key ||
      !workdeskAgent(item.agent)
    )
      return 'session_unavailable'
    return null
  }

  function resolve(group: Pending): Resolved {
    const handoff = workdeskHandoffReader(db)(group.board_task_id)
    if (!handoff?.thread_id) return { problem: 'awaiting_claim' }
    const binding = findBinding.get(group.board_task_id)
    if (!binding) return { problem: 'assignment_unverified' }
    if (binding.assignment_id !== group.assignment_id) return { problem: 'assignment_mismatch' }
    const latest = latestEvent.get(group.board_task_id, group.assignment_id)
    if (binding.executor !== handoff.executor || (latest?.executor && latest.executor !== binding.executor))
      return { problem: 'executor_changed' }
    const problem = localTarget(handoff, binding)
    return problem ? { problem } : { binding }
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
    pending(onlyTaskId?: number): Pending[] {
      return db.db
        .query<Pending, [number | null]>(`
          SELECT board_task_id, assignment_id, COUNT(*) AS count
          FROM workdesk_dialog_events
          WHERE (?1 IS NULL OR board_task_id = ?1)
          GROUP BY board_task_id, assignment_id ORDER BY MIN(id)
        `)
        .all(onlyTaskId ?? null)
    },
    adoptLegacy(group: Pending, pin: LegacyDialogBinding, task: WorkdeskTask): Resolved {
      return db.write('workdesk-dialog', ({ db: sql }) => {
        if (findBinding.get(group.board_task_id)) return resolve(group)
        const handoff = workdeskHandoffReader(db)(pin.taskId)
        if (!handoff?.thread_id) return { problem: 'awaiting_claim' }
        if (handoff.thread_id !== pin.threadId) return { problem: 'thread_reassigned' }
        // Old handoffs can be adopted only when their original key is itself a verified native SID.
        if (handoff.session_key !== pin.sessionId) return { problem: 'session_unavailable' }
        if (
          group.board_task_id !== pin.taskId ||
          group.assignment_id !== pin.assignmentId ||
          task.id !== pin.taskId ||
          task.assignment?.id !== pin.assignmentId
        )
          return { problem: 'assignment_mismatch' }
        if (task.status === 'queued' || task.executor !== handoff.executor) return { problem: 'executor_changed' }
        const binding: Binding = {
          task_id: pin.taskId,
          assignment_id: pin.assignmentId,
          executor: handoff.executor,
          thread_id: pin.threadId,
          sid: pin.sessionId,
          revision: task.assignment.revision,
        }
        const problem = localTarget(handoff, binding)
        if (problem) return { problem }
        const latest = latestEvent.get(group.board_task_id, group.assignment_id)
        if (!latest || (latest.executor !== null && latest.executor !== binding.executor))
          return { problem: 'executor_changed' }
        sql
          .query(`INSERT INTO workdesk_dialog_bindings (task_id, assignment_id, executor, thread_id, sid, revision)
                   VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(
            binding.task_id,
            binding.assignment_id,
            binding.executor,
            binding.thread_id,
            binding.sid,
            binding.revision,
          )
        return resolve(group)
      })
    },
    resolve,
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
            text: 'В Workdesk появилось обновление диалога по этой карточке. Доставка ответа ожидает подключения получателя.',
            private: true,
          })
        return null
      })
    },
  }
}
