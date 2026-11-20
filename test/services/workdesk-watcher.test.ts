import { expect, onTestFinished, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { type BoardDb, dbFile, openDb } from '../../src/adapters/db.ts'
import { listEntries, removeEntry } from '../../src/adapters/schedule-store.ts'
import { entriesOf, getThread } from '../../src/adapters/work-thread-store.ts'
import { workdeskStore } from '../../src/adapters/workdesk-store.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import type { Item } from '../../src/core/types.ts'
import { createWorkdeskWatcher } from '../../src/services/workdesk-watcher.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'
import { literal, mcp, rows, task, untrusted } from '../support/workdesk-fixture.ts'

function master(name: string, key: string, agent: 'claude' | 'codex', category = 'board'): Item {
  return {
    name,
    key,
    agent,
    category,
    categorySet: true,
    autoName: '',
    session: key.startsWith('pane-') ? null : key,
    pane: 'p1',
    workspace: null,
    cwd: '',
    status: 'idle',
    column: 'idle',
    attention: '',
  }
}

const testMasters = [
  master('Board-codex-master', 'pane-p1', 'codex'),
  master('Coordinator-backup', '79be4797-6712-4f60-90ce-05a38e1f48eb', 'claude', 'control'),
]

test('no config opens no Workdesk process or database; missing coordinator tools wait and log once, then heartbeat works on an empty queue', async () => {
  const fake = mcp(isolatedHome())
  const cfg = normalizeConfig({ threads: true })
  const logs: string[] = []
  const watcher = createWorkdeskWatcher({ cfg, items: () => [], onChange: () => {}, log: line => logs.push(line) })
  onTestFinished(() => watcher.stop())
  watcher.configChanged()
  expect(watcher.view()).toBeNull()
  expect(fake.calls()).toHaveLength(0)
  expect(existsSync(dbFile())).toBe(false)
  fake.write({ tasks: [], missing: true })
  cfg.workdesk = { ...fake.config, intervalSec: 1 }
  watcher.configChanged()
  await until(() => watcher.view()?.problem === 'tools')
  await until(() => fake.calls().filter(call => call.method === 'tools/list').length >= 2)
  expect(logs).toEqual(['Workdesk watcher: tools'])
  expect(fake.calls('claim_task')).toHaveLength(0)
  expect(existsSync(dbFile())).toBe(false)
  fake.write({ tasks: [] })
  await until(() => watcher.view()?.queue === 0 && watcher.view()?.problem === null)
  expect(fake.calls('board_heartbeat').map(call => call.params.arguments)).toEqual([{}])
  expect(fake.calls().every(call => call.literal === literal)).toBe(true)
})

test('parallel polls and restart route only eligible cards, resolve both masters and fallback, and keep one thread per card', async () => {
  const fake = mcp(isolatedHome())
  fake.write({
    tasks: [
      task(1),
      task(2, 'Unknown Project'),
      task(3),
      { ...task(4), status: 'doing', executor: 'Board-codex-master' },
    ],
    dropClaim: 1,
    conflict: 3,
  })
  const cfg = normalizeConfig({ threads: true, workdesk: fake.config })
  const start = () => {
    const watcher = createWorkdeskWatcher({ cfg, items: () => testMasters, onChange: () => {}, log: () => {} })
    watcher.configChanged()
    onTestFinished(() => watcher.stop())
    return watcher
  }

  const first = start()
  await until(() => first.view()?.polledAt !== null)
  expect(first.view()?.problem).toBe('claim')
  expect(rows()).toHaveLength(0)
  await first.stop()
  const next = [start(), start()]
  await until(() => next.every(watcher => !!watcher.view()?.polledAt))
  const claims = fake.calls('claim_task').map(call => call.params.arguments)
  expect(
    claims.filter(claim => JSON.stringify(claim) === '{"task_id":1,"executor":"Board-codex-master"}').length,
  ).toBeGreaterThanOrEqual(2)
  expect(claims).toContainEqual({ task_id: 2, executor: 'Coordinator-backup' })
  expect(claims).toContainEqual({ task_id: 3, executor: 'Board-codex-master' })
  expect(claims).not.toContainEqual({ task_id: 4, executor: 'Board-codex-master' })
  expect(
    rows()
      .map(row => [row.title, row.lane, JSON.parse(row.assignee).key])
      .sort(),
  ).toEqual([
    ['Test card 1', 'board', testMasters[0]?.key],
    ['Test card 2', 'control', testMasters[1]?.key],
  ])
  expect(listEntries()).toHaveLength(2)
  expect(listEntries().every(entry => !entry.text.includes(untrusted) && entry.noWake !== true)).toBe(true)
  const db = openDb()
  if (!db) throw new Error('missing db')
  try {
    const thread = rows().find(row => row.lane === 'board')
    if (!thread) throw new Error('missing Workdesk thread')
    const note = entriesOf(db, thread.id).at(-1)
    expect(note?.text).toContain('укажи stage')
    expect(JSON.parse(note?.text.split('\n\n').at(-1) ?? '')).toMatchObject({ description: untrusted })
    expect(note?.links).toEqual([{ url: task(1).url }])
  } finally {
    db.close()
  }
})

test('after a crash between thread, schedule reservation and activation, restart reuses the parked entry and a deleted thread stays deleted', () => {
  isolatedHome()
  const db = openDb()
  if (!db) throw new Error('missing db')
  const target = { key: 'pane-p1', name: 'Board-codex-master', lane: 'board' }
  const store = workdeskStore(db)
  const card = { ...task(10), executor_model: 'codex' as const, status: 'doing' as const, executor: target.name }
  store.reserve(card.id, target)
  store.handoff(card, target, Date.now())
  // A process stopped after the schedule file was written, before SQLite committed its ID.
  const interrupted: BoardDb = {
    ...db,
    write: (by, fn) =>
      db.write(by, tx => {
        fn(tx)
        throw new Error('interrupted before commit')
      }),
  }
  expect(() => workdeskStore(interrupted).release(undefined, Date.now())).toThrow('interrupted before commit')
  const parked = listEntries()[0]
  expect(parked?.next).toBeGreaterThan(Date.now())
  db.close()

  const reopened = openDb()
  if (!reopened || !parked) throw new Error('lost persistent state')
  try {
    let writes = 0
    const interruptionAfterActivation: BoardDb = {
      ...reopened,
      write: (by, fn) =>
        reopened.write(by, tx => {
          if (++writes === 2) throw new Error('interrupted after activation')
          return fn(tx)
        }),
    }
    expect(() => workdeskStore(interruptionAfterActivation).release(undefined, Date.now())).toThrow(
      'interrupted after activation',
    )
    expect(listEntries().map(entry => entry.id)).toEqual([parked.id])
    expect(listEntries()[0]?.next).toBeLessThanOrEqual(Date.now())
    removeEntry(parked.id)
    const restarted = workdeskStore(reopened)
    restarted.release(undefined, Date.now())
    expect(listEntries()).toHaveLength(0)
    const original = restarted.find(card.id)?.thread_id
    if (!original) throw new Error('missing thread')
    reopened.write('test', ({ db: sql }) => {
      sql.query('DELETE FROM thread_entries WHERE thread = ?').run(original)
      sql.query('DELETE FROM threads WHERE id = ?').run(original)
    })
    expect(restarted.reserve(card.id, target)).toBeNull()
    restarted.handoff(card, target, Date.now())
    restarted.release(undefined, Date.now())
    expect(getThread(reopened, original)).toBeNull()
    expect(rows()).toHaveLength(0)
    expect(listEntries()).toHaveLength(0)
  } finally {
    reopened.close()
  }
})

test('Tripio, Трипио and Hermes route to Tripio-master with verified executor models', async () => {
  const fake = mcp(isolatedHome())
  fake.write({
    tasks: [
      task(40, 'Tripio'),
      { ...task(41, 'Трипио'), executor_model: 'claude-opus' },
      { ...task(42, 'Hermes'), executor_model: 'codex' },
      { ...task(43, 'Hermes'), executor_model: 'claude --unsafe-custom-argument' },
      { ...task(44, 'Hermes'), executor_model: null },
    ],
  })
  const target = master('Tripio-master', 'pane-tripio', 'codex', 'tripio')
  const watcher = createWorkdeskWatcher({
    cfg: normalizeConfig({ threads: true, workdesk: fake.config }),
    items: () => [target],
    onChange: () => {},
    log: () => {},
  })
  onTestFinished(() => watcher.stop())
  watcher.configChanged()
  await until(() => !!watcher.view()?.polledAt)
  expect(watcher.view()?.problem).toBe('list')
  expect(fake.calls('claim_task').map(call => call.params.arguments)).toEqual([
    { task_id: 40, executor: 'Tripio-master' },
    { task_id: 41, executor: 'Tripio-master' },
    { task_id: 42, executor: 'Tripio-master' },
  ])
  const db = openDb()
  if (!db) throw new Error('missing db')
  try {
    expect(
      rows().map(row => {
        expect(JSON.parse(row.assignee)).toMatchObject({ key: target.key, name: target.name })
        const text = entriesOf(db, row.id).at(-1)?.text ?? ''
        const data = JSON.parse(text.split('\n\n').at(-1) ?? '')
        const launcher =
          data.executor_model === 'claude-opus'
            ? 'spawn-agent --agent claude --model opus --effort low'
            : 'spawn-agent --agent codex --effort low'
        expect(text).toContain(launcher)
        expect(text).toContain('на приёмку')
        return [data.title, data.executor_model]
      }),
    ).toEqual([
      ['Test card 40', 'codex'],
      ['Test card 41', 'claude-opus'],
      ['Test card 42', 'codex'],
    ])
  } finally {
    db.close()
  }
})
