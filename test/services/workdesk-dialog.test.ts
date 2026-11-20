import { expect, onTestFinished, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { type BoardDb, dbFile, openDb } from '../../src/adapters/db.ts'
import { entriesOf } from '../../src/adapters/work-thread-store.ts'
import { workdeskDialogStore } from '../../src/adapters/workdesk-dialog-store.ts'
import { workdeskStore } from '../../src/adapters/workdesk-store.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import type { Item } from '../../src/core/types.ts'
import { workdeskTask } from '../../src/core/workdesk.ts'
import { type OwnerEvent, workdeskDialogConfig } from '../../src/core/workdesk-dialog.ts'
import { createWorkdeskDialog } from '../../src/services/workdesk-dialog.ts'
import { createWorkdeskWatcher } from '../../src/services/workdesk-watcher.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

const SID = '018f5280-4ef2-42e8-9b0f-4517daaf0d36'
const OTHER = '018f5280-4ef2-42e8-9b0f-4517daaf0d38'
const ASSIGNMENT = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
const STALE = 'a1f42fcb-9183-41d0-b577-030828bf5e89'
const NAME = 'Board-codex-master'
const MASTER = { key: SID, name: NAME, lane: 'board', sid: SID }

const item: Item = {
  name: NAME,
  key: SID,
  session: SID,
  pane: 'p1',
  cwd: '',
  workspace: null,
  category: 'board',
  categorySet: true,
  autoName: '',
  status: 'idle',
  column: 'idle',
  attention: '',
  agent: 'codex',
}

const privateText = 'Только владельцу и исполнителю: [board reminder] $() --session'
const ownerMessage = (id: number, kind: OwnerEvent['kind'], revision = 1) => ({ id, kind, revision, created_at: id })
type OwnerMessage = ReturnType<typeof ownerMessage>
const event = (message: OwnerMessage, overrides: Partial<OwnerEvent> = {}): OwnerEvent => ({
  id: message.id,
  revision: message.revision,
  kind: message.kind,
  created_at: message.created_at,
  board_task_id: 1,
  assignment_id: ASSIGNMENT,
  executor: NAME,
  board_status: 'done',
  ...overrides,
})
const rawTask = { ...task(1), assignment_id: ASSIGNMENT, revision: 1 }
function withDb<T>(read: (db: BoardDb) => T): T {
  const db = openDb()
  if (!db) throw new Error('expected sandbox database')
  try {
    return read(db)
  } finally {
    db.close()
  }
}
function handoff(v2 = true): string {
  return withDb(db => {
    const assignment = workdeskTask({ ...(v2 ? rawTask : task(1)), executor: NAME, status: 'doing' })
    if (!assignment) throw new Error('bad fixture task')
    const store = workdeskStore(db)
    store.reserve(1, MASTER)
    store.handoff(assignment, MASTER, 1)
    const id = store.find(1)?.thread_id
    if (!id) throw new Error('missing fixture handoff')
    return id
  })
}

function fixture(messages: OwnerMessage[], events = messages.map(message => event(message))) {
  const fake = mcp(isolatedHome())
  const dialog = {
    events,
  }
  fake.write({ tasks: [], dialog })
  const cfg = normalizeConfig({ threads: true, workdesk: fake.config, workdeskDialog: {} })
  let items: readonly Item[] | null = [item]
  const start = () => {
    const service = createWorkdeskDialog({ cfg, items: () => items, onChange() {} })
    onTestFinished(() => service.stop())
    service.configChanged()
    return service
  }
  async function tick() {
    const poller = start()
    await until(() => !!poller.view()?.polledAt)
    await poller.stop()
    return poller.view()
  }
  return {
    fake,
    dialog,
    cfg,
    start,
    tick,
    items: (next: readonly Item[] | null) => {
      items = next
    },
  }
}

test('dialog stays off by default; an older catalogue or a denied board role makes no owner message read', async () => {
  const f = fixture([])
  delete f.cfg.workdeskDialog
  const disabled = f.start()
  expect(disabled.view()).toBeNull()
  expect(f.fake.calls()).toEqual([])
  expect(existsSync(dbFile())).toBe(false)
  await disabled.stop()

  f.cfg.workdeskDialog = {}
  f.fake.write({ tasks: [] })
  expect((await f.tick())?.problem).toBe('tools')
  expect(f.fake.calls().filter(call => call.method === 'tools/call')).toEqual([])
  expect(existsSync(dbFile())).toBe(false)

  f.fake.write({ tasks: [], dialog: { ...f.dialog, deny: 'list_owner_events' } })
  expect((await f.tick())?.problem).toBe('role_denied')
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
})

test('commits metadata pages, retains before claim and offline, and attaches one generic notice after W1 claim', async () => {
  const messages = [ownerMessage(3, 'message'), ownerMessage(12, 'choice'), ownerMessage(24, 'message')]
  const f = fixture(
    messages,
    messages.map(m => event(m, { executor: null, board_status: 'queued' })),
  )
  f.fake.write({ tasks: [], dialog: { ...f.dialog, pageSize: 1 } })
  const pollers = [f.start(), f.start()]
  await until(() => pollers.every(poller => poller.view()?.pending === 3))
  expect(pollers[0]?.view()?.blocked).toEqual({ awaiting_claim: 3 })
  await Promise.all(pollers.map(poller => poller.stop()))
  expect(withDb(db => workdeskDialogStore(db, () => []).cursor())).toBe(24)
  expect(rows()).toEqual([])

  f.fake.write({ tasks: [rawTask], topology: true, dialog: f.dialog })
  f.cfg.workdesk = { ...f.fake.config, topology: { deviceId: 'synthetic' } }
  const w1 = createWorkdeskWatcher({
    cfg: f.cfg,
    items: () => [item],
    observation: () => ({ items: [item], observedAt: Date.now() }),
    onChange() {},
    log() {},
  })
  onTestFinished(() => w1.stop())
  w1.configChanged()
  await until(() => !!w1.view()?.polledAt)
  await w1.stop()
  const id = rows()[0]?.id
  if (!id) throw new Error('no W1 thread')
  expect(f.fake.calls('claim_task')).toHaveLength(1)
  expect(f.fake.calls('board_heartbeat')[0]?.params.arguments).toMatchObject({ topology: { version: 1 } })
  f.items(null)
  expect((await f.tick())?.blocked).toEqual({ session_unavailable: 3 })
  f.items([item])
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 3 })
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 3 })
  const feed = withDb(db => entriesOf(db, id))
  expect(feed.filter(entry => entry.text.includes('обновление диалога'))).toHaveLength(1)
  expect(JSON.stringify(feed)).not.toContain(privateText)
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
  expect(f.fake.calls('list_owner_events').at(-1)?.params.arguments).toMatchObject({ after: 24 })
  expect(rows()).toHaveLength(1)
})

test('rejects invalid discovery cursors and rolls back both the page and cursor if interrupted before commit', async () => {
  const f = fixture([ownerMessage(3, 'message')])
  f.fake.write({ tasks: [], dialog: { ...f.dialog, invalidList: true } })
  expect(await f.tick()).toMatchObject({ problem: 'invalid_page', pending: 0 })
  withDb(db => {
    const broken: BoardDb = {
      ...db,
      write: (by, fn) =>
        db.write(by, tx => {
          fn(tx)
          throw new Error('process exited before commit')
        }),
    }
    const store = workdeskDialogStore(db, () => [])
    expect(() => workdeskDialogStore(broken, () => []).retain(0, f.dialog.events, 3)).toThrow('process exited')
    expect(store.cursor()).toBe(0)
    expect(store.pending()).toEqual([])
  })
  f.fake.write({ tasks: [], dialog: f.dialog })
  expect(await f.tick()).toMatchObject({ problem: null, pending: 1 })
  expect((await f.tick())?.pending).toBe(1)
  expect(withDb(db => workdeskDialogStore(db, () => []).cursor())).toBe(3)
})

test('ambiguous assignment, renamed executor, changed thread and SID keep events pending without protected reads', async () => {
  const message = ownerMessage(3, 'message')
  const f = fixture(
    [message],
    [
      event(message),
      event(ownerMessage(12, 'message'), { assignment_id: STALE }),
      event(ownerMessage(24, 'message'), { executor: 'Other master' }),
    ],
  )
  const thread = handoff()
  expect((await f.tick())?.blocked).toEqual({ assignment_mismatch: 1, executor_changed: 2 })
  withDb(db => db.db.query('DELETE FROM workdesk_dialog_events WHERE id = 24').run())

  f.items([{ ...item, session: OTHER }])
  expect((await f.tick())?.blocked).toEqual({ assignment_mismatch: 1, session_unavailable: 1 })
  f.items([item])
  withDb(db =>
    db.db
      .query('UPDATE threads SET assignee = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'session', key: OTHER, name: NAME }), thread),
  )
  expect((await f.tick())?.blocked).toEqual({ assignment_mismatch: 1, thread_reassigned: 1 })
  withDb(db =>
    db.write('test', ({ db: sql }) => {
      sql.query('DELETE FROM thread_entries WHERE thread = ?').run(thread)
      sql.query('DELETE FROM threads WHERE id = ?').run(thread)
    }),
  )
  expect((await f.tick())?.blocked).toEqual({ assignment_mismatch: 1, thread_missing: 1 })
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
  expect(rows()).toEqual([])
})

test('a pre-v2 handoff cannot be backfilled from an event and executor name', async () => {
  const f = fixture([ownerMessage(3, 'message')])
  handoff(false)
  expect((await f.tick())?.blocked).toEqual({ assignment_unverified: 1 })
  expect(f.fake.calls('read_owner_messages')).toEqual([])
})

test('a new metadata rework updates the original assignment and thread even while protected delivery is unavailable', async () => {
  const f = fixture([ownerMessage(3, 'rework', 2)])
  const thread = handoff()
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 1 })
  expect(
    withDb(db => db.db.query('SELECT assignment_id, revision, thread_id FROM workdesk_dialog_bindings').get()),
  ).toEqual({ assignment_id: ASSIGNMENT, revision: 2, thread_id: thread })
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
  expect(f.fake.calls('claim_task')).toEqual([])
})

test('a pinned legacy handoff adopts only an authenticated current assignment with the original thread and native SID', async () => {
  const message = ownerMessage(3, 'message')
  const f = fixture([message], [event(message, { executor: null, board_status: 'queued' })])
  const thread = handoff(false)
  const pin = { taskId: 1, assignmentId: ASSIGNMENT, threadId: thread, sessionId: SID }
  const configure = (override: Partial<typeof pin> = {}) => {
    f.cfg.workdeskDialog = { legacyBindings: [{ ...pin, ...override }] }
  }
  const remote = { ...rawTask, executor: NAME, status: 'doing' }
  configure()
  expect((await f.tick())?.blocked).toEqual({ legacy_source_unavailable: 1 })
  f.fake.write({ tasks: [remote, remote], dialog: f.dialog })
  expect((await f.tick())?.blocked).toEqual({ legacy_source_unavailable: 1 })
  f.fake.write({ tasks: [{ ...remote, assignment_id: STALE }], dialog: f.dialog })
  expect((await f.tick())?.blocked).toEqual({ assignment_mismatch: 1 })
  f.fake.write({ tasks: [{ ...remote, executor: 'Different master' }], dialog: f.dialog })
  expect((await f.tick())?.blocked).toEqual({ executor_changed: 1 })
  f.fake.write({ tasks: [remote], dialog: f.dialog })
  configure({ threadId: STALE })
  expect((await f.tick())?.blocked).toEqual({ thread_reassigned: 1 })
  configure({ sessionId: OTHER })
  expect((await f.tick())?.blocked).toEqual({ session_unavailable: 1 })
  configure()
  f.items(null)
  expect((await f.tick())?.blocked).toEqual({ session_unavailable: 1 })
  expect(withDb(db => db.db.query('SELECT * FROM workdesk_dialog_bindings').all())).toEqual([])
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])

  f.items([item])
  expect((await f.tick())?.blocked).toEqual({ protected_delivery_unavailable: 1 })
  expect(withDb(db => db.db.query('SELECT thread_id, assignment_id, sid FROM workdesk_dialog_bindings').get())).toEqual(
    { thread_id: thread, assignment_id: ASSIGNMENT, sid: SID },
  )
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])

  const lists = f.fake.calls('list_board_tasks').length
  expect((await f.tick())?.pending).toBe(1)
  expect((await f.tick())?.pending).toBe(1)
  expect(f.fake.calls('list_board_tasks')).toHaveLength(lists)
  expect(f.fake.calls('claim_task')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
  expect(rows().map(row => row.id)).toEqual([thread])
})

test('shared and mirrored threads never receive a notice and a scoped poll retains the other event for later', async () => {
  const f = fixture(
    [],
    [event(ownerMessage(3, 'message')), event(ownerMessage(4, 'message'), { board_task_id: 2, assignment_id: STALE })],
  )
  f.cfg.workdeskDialog = { onlyTaskId: 1 }
  expect(workdeskDialogConfig(f.cfg.workdeskDialog, f.cfg.workdesk)?.intervalSec).toBe(60)
  expect(workdeskDialogConfig(f.cfg.workdeskDialog, f.cfg.workdesk)?.onlyTaskId).toBe(1)
  expect(workdeskDialogConfig({ onlyTaskId: 2 }, { ...f.fake.config, onlyTaskId: 1 })).toBeNull()
  const thread = handoff()
  const initial = withDb(db => entriesOf(db, thread).length)
  withDb(db =>
    db.db
      .query('UPDATE threads SET scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'team', topic: thread, by: 'me', key: 'board-1', at: 1 }), thread),
  )
  expect((await f.tick())?.blocked).toEqual({ thread_scope: 1 })
  withDb(db =>
    db.db
      .query('UPDATE threads SET scope = ?, origin = ? WHERE id = ?')
      .run(
        JSON.stringify('local'),
        JSON.stringify({ mirrored: true, agentBoard: { harness: 'pi', session: 'other', id: 'other' } }),
        thread,
      ),
  )
  expect((await f.tick())?.blocked).toEqual({ thread_scope: 1 })
  expect(withDb(db => entriesOf(db, thread).length)).toBe(initial)
  withDb(db => db.db.query('UPDATE threads SET origin = NULL WHERE id = ?').run(thread))
  expect(await f.tick()).toMatchObject({ pending: 1, delivery: 'awaiting_recipient' })
  expect(await f.tick()).toMatchObject({ pending: 1, delivery: 'awaiting_recipient' })
  const feed = withDb(db => entriesOf(db, thread))
  expect(feed).toHaveLength(initial + 1)
  expect(feed.at(-1)?.private).toBe(true)
  expect(
    withDb(db =>
      workdeskDialogStore(db, () => [])
        .pending()
        .map(g => g.board_task_id),
    ),
  ).toEqual([1, 2])
  expect(f.fake.calls('read_owner_messages')).toEqual([])
  expect(f.fake.calls('ack_owner_messages')).toEqual([])
})
