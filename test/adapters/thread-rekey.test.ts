// A session known by another key once it moved to another device (#616, adapters/work-thread-store.ts
// rekeySession): the threads it created or is assigned, its watches and its cursor follow it from
// `<id>` to `@<device>:<id>`; another session's stay as they are.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/adapters/db.ts'
import {
  createThread,
  cursorOf,
  getThread,
  moveCursor,
  putWatch,
  rekeySession,
  watchesOf,
} from '../../src/adapters/work-thread-store.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const AT = `@server-1:${S}`

test("a moved session's threads, watches and cursor follow its new key; another's stay", () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-rekey-'))
  const db = openDb({ path: join(dir, 'board.db'), create: true })
  if (!db) throw new Error('no db')
  try {
    const me = { kind: 'session' as const, key: S, name: 'Atlas' }
    const ben = { kind: 'session' as const, key: 'ben-key', name: 'Ben' }
    const [mine, given, other] = db.write('test', tx => [
      createThread(tx, { lane: 'atlas', title: 'map', status: 'doing', author: me, at: 1 }).head,
      createThread(tx, { lane: 'atlas', title: 'tiles', status: 'next', author: ben, assignee: me, at: 2 }).head,
      createThread(tx, { lane: 'atlas', title: 'docs', status: 'next', author: ben, at: 3 }).head,
    ])
    db.write('test', tx => {
      putWatch(tx, { session: S, name: 'Atlas', target: 'mine', what: 'status', idle: false, wake: false }, 4)
      putWatch(tx, { session: 'ben-key', name: 'Ben', target: 'mine', what: 'all', idle: false, wake: false }, 4)
      moveCursor(tx, S, { seq: 7, at: 5, asked: 6 })
    })
    const n = db.write('test', tx => rekeySession(tx, S, AT))
    expect(n).toBe(4)
    expect(getThread(db, mine?.id ?? '')?.createdBy).toEqual({ ...me, key: AT })
    expect(getThread(db, given?.id ?? '')?.assignee).toEqual({ ...me, key: AT })
    expect(getThread(db, given?.id ?? '')?.createdBy).toEqual(ben)
    expect(getThread(db, other?.id ?? '')?.createdBy).toEqual(ben)
    expect(watchesOf(db, S)).toEqual([])
    expect(watchesOf(db, AT).map(w => [w.target, w.what])).toEqual([['mine', 'status']])
    expect(watchesOf(db, 'ben-key')).toHaveLength(1)
    expect(cursorOf(db, S)).toBeNull()
    expect(cursorOf(db, AT)).toMatchObject({ seq: 7, asked: 6 })
    // Back again, and a key to itself changes nothing.
    expect(db.write('test', tx => rekeySession(tx, AT, AT))).toBe(0)
    db.write('test', tx => rekeySession(tx, AT, S))
    expect(getThread(db, mine?.id ?? '')?.createdBy).toEqual(me)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
