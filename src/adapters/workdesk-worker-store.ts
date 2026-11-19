import type { BoardDb } from './db.ts'

const schema = `
  CREATE TABLE IF NOT EXISTS workdesk_workers (
    worker_sid TEXT PRIMARY KEY,
    master_sid TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS workdesk_workers_master ON workdesk_workers(master_sid);
  CREATE TABLE IF NOT EXISTS workdesk_worker_coverage (master_sid TEXT PRIMARY KEY) STRICT;
`

export function workerRoster(db: BoardDb, master: string): string[] | null {
  if (!db.db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workdesk_worker_coverage'").get())
    return null
  // Read the attestation and its associations in the same statement, including an empty roster.
  const rows = db.db
    .query<{ worker_sid: string | null }, [string]>(
      'SELECT w.worker_sid FROM workdesk_worker_coverage c LEFT JOIN workdesk_workers w ON w.master_sid=c.master_sid WHERE c.master_sid=?',
    )
    .all(master)
  return rows.length ? rows.flatMap(row => row.worker_sid ?? []) : null
}

export type WorkerChange = { op: 'link' | 'unlink'; worker: string } | { op: 'complete' | 'incomplete' }

export function changeWorkerRoster(db: BoardDb, master: string, change: WorkerChange): void {
  db.write('workdesk workers', ({ db: sql }) => {
    sql.exec(schema)
    switch (change.op) {
      case 'link':
        sql
          .query(
            'INSERT INTO workdesk_workers VALUES (?, ?) ON CONFLICT(worker_sid) DO UPDATE SET master_sid=excluded.master_sid',
          )
          .run(change.worker, master)
        break
      case 'unlink':
        sql.query('DELETE FROM workdesk_workers WHERE worker_sid=? AND master_sid=?').run(change.worker, master)
        break
      case 'complete':
        sql.query('INSERT OR IGNORE INTO workdesk_worker_coverage VALUES (?)').run(master)
        break
      case 'incomplete':
        sql.query('DELETE FROM workdesk_worker_coverage WHERE master_sid=?').run(master)
        break
    }
  })
}
