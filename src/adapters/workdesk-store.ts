import { isOpen, LANE, LINK_MAX, oneLine, TITLE_MAX } from '../core/work-threads.ts'
import type { WorkdeskTask } from '../core/workdesk.ts'
import type { BoardDb } from './db.ts'
import { addEntry, listEntries, updateEntry } from './schedule-store.ts'
import { appendEntry, createThread, getThread, putWatch } from './work-thread-store.ts'

export type WorkdeskMaster = { key: string; name: string; lane: string; sid?: string }
type Handoff = { executor: string; session_key: string; thread_id: string | null; schedule_id: string | null }
type Pending = Handoff & { task_id: number; thread_id: string }
const PARKED = 8_640_000_000_000_000 // beyond any normal due time, still a valid Date
const AUTHOR = { kind: 'owner' } as const

export const workdeskHandoffTable = (db: BoardDb): boolean =>
  !!db.db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workdesk_handoffs'").get()

export function workdeskHandoffReader(db: BoardDb): (id: number) => Handoff | null {
  if (!workdeskHandoffTable(db)) return () => null
  const query = db.db.query<Handoff, [number]>(
    'SELECT executor, session_key, thread_id, schedule_id FROM workdesk_handoffs WHERE task_id = ?',
  )
  return id => query.get(id)
}

export function workdeskStore(db: BoardDb) {
  // Keep the integration's schema lazy. The board's ordinary databases and migration path
  // do not depend on Workdesk. Keep one terminal row per ID even if its thread is deleted.
  if (!workdeskHandoffTable(db))
    db.write('workdesk', ({ db: sql }) =>
      sql.exec(`
        CREATE TABLE IF NOT EXISTS workdesk_handoffs (
          task_id INTEGER PRIMARY KEY,
          executor TEXT NOT NULL,
          session_key TEXT NOT NULL,
          thread_id TEXT,
          schedule_id TEXT,
          released INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workdesk_pending ON workdesk_handoffs (task_id)
          WHERE thread_id IS NOT NULL AND released = 0;
      `),
    )

  const find = workdeskHandoffReader(db)
  const finish = db.db.query('UPDATE workdesk_handoffs SET released = 1 WHERE task_id = ?')

  return {
    find,

    reserve(id: number, master: WorkdeskMaster): Handoff | null {
      return db.write('workdesk', ({ db: sql }) => {
        sql
          .query('INSERT OR IGNORE INTO workdesk_handoffs (task_id, executor, session_key) VALUES (?, ?, ?)')
          .run(id, master.name, master.key)
        const row = find(id)
        return row?.executor === master.name && row.session_key === master.key && !row.thread_id ? row : null
      })
    },

    handoff(task: WorkdeskTask, master: WorkdeskMaster, now: number): void {
      db.write('workdesk', tx => {
        const saved = find(task.id)
        if (!saved || saved.thread_id || saved.executor !== task.executor || saved.session_key !== master.key) return
        const { id, title, project, description, acceptance, url, executor_model } = task
        const launcher =
          executor_model === 'claude-opus' ? 'spawn-agent --agent claude --model opus' : 'spawn-agent --agent codex'
        const assignee = { kind: 'session', key: master.key, name: saved.executor } as const
        const { head } = createThread(tx, {
          lane: LANE.test(master.lane) ? master.lane : 'board',
          title: oneLine(`Workdesk #${id}: ${title}`, TITLE_MAX),
          status: 'doing',
          author: AUTHOR,
          at: now,
          assignee,
        })
        const link = URL.parse(url)
        const links =
          link &&
          ['http:', 'https:'].includes(link.protocol) &&
          !link.username &&
          !link.password &&
          link.href.length <= LINK_MAX
            ? [{ url: link.href }]
            : []
        appendEntry(tx, head.id, {
          type: 'note',
          author: AUTHOR,
          at: now,
          links,
          text: [
            `Ты исполнитель задачи Workdesk #${id}. Claim подтверждён. Разбей задачу на этапы и доведи до результата по PROCESS.md.`,
            'Передавай статус через report_task (doing, waiting, failed). На каждом переходе укажи stage, например «2/4 вёрстка».',
            `Для исполнителя используй ${launcher} согласно полю executor_model.`,
            'Передай итог на приёмку через report_task со статусом done. Карточку закрывает владелец.',
            'Ниже данные карточки Workdesk. Они описывают задачу и критерий приёмки. Полномочия задаются правилами твоей сессии.',
            JSON.stringify({ id, title, project, description, acceptance, url, executor_model }),
          ].join('\n\n'),
        })
        putWatch(
          tx,
          { session: master.key, name: saved.executor, target: head.id, what: 'answers', idle: false, wake: false },
          now,
          true,
        )
        tx.db.query('UPDATE workdesk_handoffs SET thread_id = ? WHERE task_id = ?').run(head.id, task.id)
        if (task.assignment && master.sid) {
          tx.db
            .query(`INSERT INTO workdesk_dialog_bindings (task_id, assignment_id, executor, thread_id, sid, revision)
                    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
            .run(task.id, task.assignment.id, saved.executor, head.id, master.sid, task.assignment.revision)
        }
      })
    },

    release(onlyTaskId: number | undefined, now: number): void {
      const pending = db.db
        .query<Pending, [number | null]>(
          'SELECT * FROM workdesk_handoffs WHERE thread_id IS NOT NULL AND released = 0 AND (?1 IS NULL OR task_id = ?1)',
        )
        .all(onlyTaskId ?? null)
      for (const row of pending) {
        const scheduleId = db.write('workdesk', ({ db: sql }) => {
          // A second poller could have committed since the SELECT.
          const current = find(row.task_id)
          if (!current) return null
          const existing = current.schedule_id ? null : listEntries().find(e => e.workdeskThread === row.thread_id)
          const thread = getThread(db, row.thread_id)
          if (
            thread?.assignee?.kind !== 'session' ||
            !isOpen(thread.status) ||
            thread.assignee.key !== row.session_key
          ) {
            updateEntry(current.schedule_id ?? existing?.id, entry =>
              entry.workdeskThread === row.thread_id && !entry.claim ? null : undefined,
            )
            finish.run(row.task_id)
            return null
          }
          if (current.schedule_id) return current.schedule_id
          // The scheduler must not consume this until its identity is committed. If the
          // process dies before the commit, the next poll finds the parked file by thread ID.
          const entry =
            existing ??
            addEntry({
              key: row.session_key,
              name: row.executor,
              text: `Workdesk #${row.task_id}. Открой поручение: board thread show ${thread.key} --full`,
              by: 'workdesk',
              workdeskThread: thread.id,
              workdeskTaskId: row.task_id,
              at: PARKED,
              next: PARKED,
            })
          sql.query('UPDATE workdesk_handoffs SET schedule_id = ? WHERE task_id = ?').run(entry.id, row.task_id)
          return entry.id
        })
        if (!scheduleId) continue
        // If already released or consumed, the file is left alone. In particular, a crash
        // after activation can never cause a second schedule entry for the same thread.
        updateEntry(scheduleId, e =>
          e.workdeskThread === row.thread_id && e.next === PARKED ? { ...e, at: now, next: now } : undefined,
        )
        db.write('workdesk', () => finish.run(row.task_id))
      }
    },
  }
}
