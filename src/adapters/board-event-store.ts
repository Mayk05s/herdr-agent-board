import { join } from 'node:path'
import type { WorkdeskEvent } from '../core/workdesk-events.ts'
import { type BoardDb, openDb, type Tx } from './db.ts'
import { MIGRATIONS } from './db-schema.ts'
import { stateDir } from './paths.ts'

export type SessionObservation = {
  sid: string
  pane: string
  terminal: string
  phase: 'running' | 'free' | 'dialog' | 'owner' | 'unknown' | 'exited'
}

export type StageObservation = {
  taskId: number
  assignmentId: string
  revision: number
  stage: string
  startedAt: number
}

type BoardEventType =
  | 'session.dialog'
  | 'session.free'
  | 'session.owner'
  | 'session.exited'
  | 'task.submitted'
  | 'task.stage_overdue'
  | 'service.unavailable'
  | 'service.recovered'

type Metadata = {
  session_id?: string
  board_task_id?: number
  source_event_id?: number
  stage_started_at?: number
  service?: string
}
type EventRow = { id: number; type: BoardEventType; created_at: number; metadata: string }
export type BoardEvent = Omit<EventRow, 'metadata'> & Metadata
const EVENT_BATCH = 100
const KEEP_ACKNOWLEDGED = 10_000
const STALE_STAGE = 90 * 60_000
const WAKE_INTERVAL = 60_000
const HEALTH_INTERVAL = 600_000

const EVENT_MIGRATIONS = [
  ...MIGRATIONS.slice(0, 1),
  {
    version: 2,
    store: 'board-events',
    sql: `
      CREATE TABLE IF NOT EXISTS board_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, created_at INTEGER NOT NULL,
        metadata TEXT NOT NULL, decision INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS board_events_decision ON board_events(id) WHERE decision = 1;
      CREATE TABLE IF NOT EXISTS board_event_submissions (
        assignment_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY (assignment_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS board_event_overdue (
        assignment_id TEXT NOT NULL, revision INTEGER NOT NULL, stage TEXT NOT NULL, started_at INTEGER NOT NULL,
        PRIMARY KEY (assignment_id, revision, stage, started_at)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS board_event_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS board_event_sessions (
        sid TEXT PRIMARY KEY, pane TEXT NOT NULL, terminal TEXT NOT NULL, phase TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS board_event_stages (
        task_id INTEGER PRIMARY KEY, assignment_id TEXT NOT NULL, revision INTEGER NOT NULL,
        stage TEXT NOT NULL, started_at INTEGER NOT NULL, emitted INTEGER NOT NULL DEFAULT 0
      ) STRICT;
    `,
  },
]

/** A separate database so restoring Board content leaves transport and wake receipts intact. */
export const openBoardEventDb = () => openDb({ path: join(stateDir(), 'board-events.db'), steps: EVENT_MIGRATIONS })

export function boardEventStore(db: BoardDb) {
  function get(key: string): string | undefined {
    return db.db.query<{ value: string }, [string]>('SELECT value FROM board_event_state WHERE key = ?').get(key)?.value
  }
  function set({ db: sql }: Tx, key: string, value: string | number): void {
    sql
      .query('INSERT INTO board_event_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value))
  }
  const number = (key: string) => Number(get(key) ?? 0)
  function event({ db: sql, journal }: Tx, type: BoardEventType, at: number, metadata: Metadata, decision = false) {
    const row = sql
      .query('INSERT INTO board_events(type, created_at, metadata, decision) VALUES (?, ?, ?, ?)')
      .run(type, at, JSON.stringify(metadata), Number(decision))
    journal({ store: 'board-events', op: type, ref: String(row.lastInsertRowid) })
  }
  function read(after: number, decision = false): BoardEvent[] {
    return db.db
      .query<EventRow, [number, number]>(`
      SELECT id,type,created_at,metadata FROM board_events WHERE id > ? ${decision ? 'AND decision = 1' : ''}
      ORDER BY id LIMIT ?
    `)
      .all(after, EVENT_BATCH)
      .map(({ metadata, ...row }) => ({ ...row, ...JSON.parse(metadata) }))
  }
  return {
    read,
    replayFloor: () => number('replay_floor'),
    readerCursor: () => number('reader_ack'),
    highWater: () =>
      db.db.query<{ id: number }, []>('SELECT COALESCE(MAX(id),0) AS id FROM board_events').get()?.id ?? 0,
    cursor(source: string) {
      const key = `source:${source}`
      return {
        read: () => number(key),
        commit(value: WorkdeskEvent, publish = true) {
          db.write('board-events', tx => {
            if (value.id <= number(key)) return
            if (publish && value.type === 'task.reported' && value.status === 'done') {
              const first = tx.db
                .query('INSERT OR IGNORE INTO board_event_submissions VALUES (?, ?)')
                .run(value.assignment_id, value.revision)
              if (first.changes)
                event(
                  tx,
                  'task.submitted',
                  value.created_at,
                  { board_task_id: value.board_task_id, source_event_id: value.id },
                  true,
                )
            }
            set(tx, key, value.id)
          })
        },
        reset() {
          db.write('board-events', tx => set(tx, key, 0))
        },
      }
    },
    health(service: string, healthy: boolean, at: number) {
      const key = `health:${service}`
      const value = healthy ? 'up' : 'down'
      if (get(key) === value) return
      db.write('board-events', tx => {
        const last = get(key)
        if (last === value) return
        set(tx, key, value)
        const incident = `${key}:incident`
        if (!healthy && (!get(incident) || at - number(incident) >= HEALTH_INTERVAL)) {
          set(tx, incident, at)
          event(tx, 'service.unavailable', at, { service }, true)
        } else if (healthy && last === 'down') {
          event(tx, 'service.recovered', at, { service })
        }
      })
    },
    sessions(current: readonly SessionObservation[], departed: ReadonlySet<string>, at: number) {
      const rows = () => db.db.query<SessionObservation, []>('SELECT * FROM board_event_sessions').all()
      const bySid = new Map(current.map(item => [item.sid, item]))
      const changed = (old: SessionObservation | undefined, item: SessionObservation): boolean =>
        !old || old.phase !== item.phase || old.pane !== item.pane || old.terminal !== item.terminal
      const differences = (previous: SessionObservation[]) => {
        const before = new Map(previous.map(item => [item.sid, item]))
        return [
          ...current.filter(item => item.phase !== 'unknown' && changed(before.get(item.sid), item)),
          ...previous
            .filter(item => item.phase !== 'exited' && !bySid.has(item.sid) && departed.has(item.sid))
            .map(item => ({ ...item, phase: 'exited' as const })),
        ]
      }
      if (!differences(rows()).length) return
      db.write('board-events', tx => {
        const previous = rows()
        const before = new Map(previous.map(item => [item.sid, item]))
        for (const item of differences(previous)) {
          const old = before.get(item.sid)
          tx.db
            .query(`INSERT INTO board_event_sessions VALUES (?, ?, ?, ?) ON CONFLICT(sid)
            DO UPDATE SET pane=excluded.pane,terminal=excluded.terminal,phase=excluded.phase`)
            .run(item.sid, item.pane, item.terminal, item.phase)
          if (old?.phase === item.phase || item.phase === 'unknown') continue
          const metadata = { session_id: item.sid }
          if (item.phase === 'dialog') event(tx, 'session.dialog', at, metadata, true)
          if (item.phase === 'owner') event(tx, 'session.owner', at, metadata)
          if (item.phase === 'exited') event(tx, 'session.exited', at, metadata)
          if (item.phase === 'free' && old && old.phase !== 'unknown' && old.phase !== 'exited')
            event(tx, 'session.free', at, metadata)
        }
      })
    },
    trackedSessions: () =>
      db.db.query<SessionObservation, []>("SELECT * FROM board_event_sessions WHERE phase != 'exited'").all(),
    stages(snapshot: readonly StageObservation[]) {
      db.write('board-events', ({ db: sql }) => {
        const active = new Set(snapshot.map(row => row.taskId))
        const old = sql.query<{ task_id: number }, []>('SELECT task_id FROM board_event_stages').all()
        const remove = sql.query('DELETE FROM board_event_stages WHERE task_id = ?')
        for (const row of old) if (!active.has(row.task_id)) remove.run(row.task_id)
        const upsert = sql.query(`INSERT INTO board_event_stages(task_id,assignment_id,revision,stage,started_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET assignment_id=excluded.assignment_id,
          revision=excluded.revision,stage=excluded.stage,started_at=excluded.started_at,emitted=0
          WHERE assignment_id != excluded.assignment_id OR revision != excluded.revision OR
                stage != excluded.stage OR started_at != excluded.started_at`)
        for (const row of snapshot) upsert.run(row.taskId, row.assignmentId, row.revision, row.stage, row.startedAt)
      })
    },
    nextStageAt(): number | null {
      const oldest = db.db
        .query<{ at: number | null }, []>('SELECT MIN(started_at) AS at FROM board_event_stages WHERE emitted=0')
        .get()?.at
      return oldest == null ? null : oldest + STALE_STAGE
    },
    expireStages(at: number) {
      db.write('board-events', tx => {
        const due = tx.db
          .query<
            { task_id: number; assignment_id: string; revision: number; stage: string; started_at: number },
            [number]
          >(
            `UPDATE board_event_stages SET emitted=1 WHERE emitted=0 AND started_at <= ?
             RETURNING task_id,assignment_id,revision,stage,started_at`,
          )
          .all(at - STALE_STAGE)
        const mark = tx.db.query('INSERT OR IGNORE INTO board_event_overdue VALUES (?, ?, ?, ?)')
        for (const row of due) {
          if (mark.run(row.assignment_id, row.revision, row.stage, row.started_at).changes)
            event(tx, 'task.stage_overdue', at, { board_task_id: row.task_id, stage_started_at: row.started_at }, true)
        }
      })
    },
    pendingWake(at: number): BoardEvent[] {
      return at >= number('wake_at') + WAKE_INTERVAL ? read(number('wake_cursor'), true) : []
    },
    reserveWake(rows: readonly BoardEvent[], at: number): boolean {
      const first = rows[0]
      const last = rows.at(-1)
      if (!first || !last) return false
      // Record the attempt before the terminal side effect. A crash during dispatch has an
      // uncertain outcome, so a second prompt is suppressed. The SSE record remains readable.
      return db.write('board-events', tx => {
        if (first.id <= number('wake_cursor') || at < number('wake_at') + WAKE_INTERVAL) return false
        set(tx, 'wake_cursor', last.id)
        set(tx, 'wake_at', at)
        return true
      })
    },
    deferWake(id: number, previous: number): void {
      db.write('board-events', tx => {
        if (number('wake_cursor') === id) set(tx, 'wake_cursor', previous)
      })
    },
    wakeCursor: () => number('wake_cursor'),
    ack(id: number, wakeEnabled = false): boolean {
      return db.write('board-events', tx => {
        const high =
          tx.db.query<{ id: number }, []>('SELECT COALESCE(MAX(id),0) AS id FROM board_events').get()?.id ?? 0
        if (id > high) return false
        set(tx, 'reader_ack', Math.max(number('reader_ack'), id))
        const acknowledged = Math.max(0, number('reader_ack') - KEEP_ACKNOWLEDGED)
        const wake = wakeEnabled
          ? tx.db
              .query<{ id: number | null }, [number]>(
                'SELECT MIN(id) AS id FROM board_events WHERE decision = 1 AND id > ?',
              )
              .get(number('wake_cursor'))?.id
          : null
        const keepFrom = wake == null ? acknowledged : Math.min(acknowledged, wake - 1)
        if (keepFrom > number('replay_floor')) {
          tx.db.query('DELETE FROM board_events WHERE id <= ?').run(keepFrom)
          set(tx, 'replay_floor', keepFrom)
        }
        return true
      })
    },
  }
}
