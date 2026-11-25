import { expect, onTestFinished, test } from 'bun:test'
import { openDb } from '../../src/adapters/db.ts'
import { workdeskStore } from '../../src/adapters/workdesk-store.ts'
import { changeWorkerRoster, workerRoster } from '../../src/adapters/workdesk-worker-store.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import type { Item } from '../../src/core/types.ts'
import { type WorkdeskProblem, workdeskConfig } from '../../src/core/workdesk.ts'
import { type MasterObservation, topologyV1 } from '../../src/core/workdesk-topology.ts'
import { activeWorkers, observeWorkdesk } from '../../src/services/workdesk-topology.ts'
import { createWorkdeskWatcher } from '../../src/services/workdesk-watcher.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

const boardMaster = '10300acb-ab0a-4c69-a657-189cbf338c10'
const tripioMaster = '20300acb-ab0a-4c69-a657-189cbf338c10'
const worker = '30300acb-ab0a-4c69-a657-189cbf338c10'
const other = '40300acb-ab0a-4c69-a657-189cbf338c10'
const now = 1795140000000

const item = (id: string, agent: 'claude' | 'codex', fields: Partial<Item> = {}): Item => ({
  key: id,
  session: id,
  pane: `w1:p${id[0]}`,
  workspace: 'w1',
  name: id,
  autoName: '',
  cwd: '/Проект x 50%',
  status: 'idle',
  category: 'board',
  categorySet: true,
  column: 'idle',
  attention: '',
  agent,
  ...fields,
})

test('v1 enforces duplicate, ID, count, name and UTF-8 byte limits without truncating', () => {
  const mk = (n: number, fields: Partial<MasterObservation> = {}): MasterObservation => ({
    session_id: `sid:${n}`,
    name: `master ${n}`,
    task_ids: [n + 1],
    workers_active: null,
    ...fields,
  })
  expect(topologyV1('mac', now, [])).toEqual({ version: 1, device_id: 'mac', observed_at: now, masters: [] })
  expect(topologyV1('Mac', now, [])).toBeNull()
  expect(topologyV1('mac', 0, [])).toBeNull()
  expect(topologyV1('mac', now, [mk(1, { session_id: 'pane-p1' })])).toBeNull()
  expect(topologyV1('mac', now, [mk(1, { workers_active: 51 })])).toBeNull()
  expect(topologyV1('mac', now, [mk(1, { name: 'm\t' })])).toBeNull()
  expect(topologyV1('mac', now, [mk(1), mk(2, { task_ids: [2] })])).toBeNull()
  expect(topologyV1('mac', now, [mk(1), mk(2, { session_id: 'sid:1' })])).toBeNull()
  expect(topologyV1('mac', now, [mk(1), mk(2, { name: ' master 1 ' })])).toBeNull()
  expect(topologyV1('mac', now, [mk(1, { task_ids: Array.from({ length: 101 }, (_, n) => n + 1) })])).toBeNull()
  expect(
    topologyV1(
      'mac',
      now,
      Array.from({ length: 101 }, (_, n) => mk(n)),
    ),
  ).toBeNull()
  const wide = Array.from({ length: 55 }, (_, n) =>
    mk(n, {
      session_id: `s${'x'.repeat(118)}${n}`,
      name: `${'盒'.repeat(90)} ${n}`,
    }),
  )
  expect(JSON.stringify(wide).length).toBeLessThan(16_384)
  expect(Buffer.byteLength(JSON.stringify(wide))).toBeGreaterThan(16_384)
  expect(topologyV1('mac', now, wide)).toBeNull()
})

test('a complete roster counts unique active real workers, with null for incomplete evidence', () => {
  const running = item(worker, 'codex', { status: 'working' })
  const blocked = item(other, 'claude', { status: 'blocked' })
  expect(activeWorkers(null, [running])).toBeNull()
  expect(activeWorkers([], [running])).toBe(0)
  expect(activeWorkers([worker, worker, other], [running, blocked])).toBe(2)
  expect(activeWorkers([worker], [running, running])).toBeNull()
  expect(activeWorkers([worker], [item(worker, 'claude', { status: 'unknown' })])).toBeNull()
  expect(activeWorkers([worker], [item('pane-p1', 'codex', { session: null, status: 'working' })])).toBeNull()
  expect(activeWorkers([worker], [])).toBe(0)
  for (const shape of [
    { status: 'done' as const },
    { status: 'idle' as const },
    { sleeping: true },
    { pane: null },
    { fork: { of: boardMaster, at: 1 } },
  ])
    expect(activeWorkers([worker], [{ ...running, ...shape }])).toBe(0)
})

test('the snapshot joins confirmed local handoffs and the roster supports retries, coverage and reassignment', () => {
  isolatedHome()
  const codex = item(boardMaster, 'codex')
  const claude = item(tripioMaster, 'claude')
  const members = [
    codex,
    claude,
    item(worker, 'claude', { status: 'blocked' }),
    item(other, 'codex', { status: 'working' }),
  ]
  const snapshot = { items: members, observedAt: now }
  const a = { ...task(11), status: 'doing' as const, executor: 'Board-codex-master', executor_model: 'codex' as const }
  const b = {
    ...task(12),
    status: 'waiting' as const,
    executor: 'Tripio-master',
    executor_model: 'claude-opus' as const,
  }
  const db = openDb()
  if (!db) throw Error('no fixture database')
  try {
    const store = workdeskStore(db)
    const aMaster = { key: boardMaster, name: a.executor, lane: 'board' }
    const bMaster = { key: tripioMaster, name: b.executor, lane: 'tripio' }
    store.reserve(a.id, aMaster)
    expect(observeWorkdesk('mac', snapshot, [a])).toBeNull() // remote claim and durable thread are not yet joined
    store.handoff(a, aMaster, now)
    store.reserve(b.id, bMaster)
    store.handoff(b, bMaster, now)
    expect(observeWorkdesk('mac', null, [a, b])).toBeNull()
    expect(observeWorkdesk('mac', { ...snapshot, items: [codex] }, [a, b])).toBeNull()
    expect(observeWorkdesk('mac', snapshot, [{ ...a, executor: 'Other device' }])?.masters).toEqual([])
    expect(observeWorkdesk('mac', snapshot, [a, b])?.masters).toEqual([
      { session_id: boardMaster, name: a.executor, task_ids: [11], workers_active: null },
      { session_id: tripioMaster, name: b.executor, task_ids: [12], workers_active: null },
    ])
    changeWorkerRoster(db, boardMaster, { op: 'link', worker })
    changeWorkerRoster(db, boardMaster, { op: 'link', worker })
    expect(workerRoster(db, boardMaster)).toBeNull()
    changeWorkerRoster(db, boardMaster, { op: 'complete' })
    changeWorkerRoster(db, tripioMaster, { op: 'complete' })
    expect(observeWorkdesk('mac', snapshot, [a, b])?.masters.map(m => m.workers_active)).toEqual([1, 0])
    changeWorkerRoster(db, tripioMaster, { op: 'link', worker })
    changeWorkerRoster(db, boardMaster, { op: 'unlink', worker })
    expect(observeWorkdesk('mac', snapshot, [a, b])?.masters.map(m => m.workers_active)).toEqual([0, 1])
    changeWorkerRoster(db, tripioMaster, { op: 'incomplete' })
    expect(observeWorkdesk('mac', snapshot, [a, b])?.masters.map(m => m.workers_active)).toEqual([0, null])
  } finally {
    db.close()
  }
})

test('legacy tools, unknown device and incomplete observations send only presence, and rejection preserves W1', async () => {
  const fake = mcp(isolatedHome())
  const cfg = normalizeConfig({ threads: true })
  const master = item(boardMaster, 'codex', { name: 'Board-codex-master' })
  let healthy = false
  const watcher = createWorkdeskWatcher({
    cfg,
    items: () => [master],
    observation: () => (healthy ? { items: [master], observedAt: now } : null),
    onChange: () => {},
    log: () => {},
  })
  onTestFinished(() => watcher.stop())
  const check = async (setting: object, state: object, expected: object, problem: WorkdeskProblem | null = null) => {
    const prior = fake.calls('board_heartbeat').length
    fake.write(state)
    // A different interval forces a new poll with these exact settings.
    cfg.workdesk = { ...fake.config, intervalSec: 120 + prior, ...setting }
    watcher.configChanged()
    await until(() => fake.calls('board_heartbeat').length > prior && !!watcher.view()?.polledAt)
    expect(
      fake
        .calls('board_heartbeat')
        .slice(prior)
        .map(call => call.params.arguments),
    ).toEqual([expected])
    expect(watcher.view()?.problem).toBe(problem)
  }
  await check({ topology: { deviceId: 'mac' } }, { tasks: [] }, {})
  expect(workdeskConfig({ ...fake.config, topology: { deviceId: 'UNKNOWN DEVICE' } })?.topologyDeviceId).toBeUndefined()
  await check({ topology: { deviceId: 'UNKNOWN DEVICE' } }, { tasks: [], topology: true }, {})
  await check({ topology: { deviceId: 'mac' } }, { tasks: [], topology: true }, {})
  healthy = true
  await check({ topology: { deviceId: 'mac' } }, { tasks: [], topology: true, invalidList: true }, {}, 'list')
  await check(
    { topology: { deviceId: 'mac' } },
    { tasks: [task(19)], topology: true, rejectHeartbeat: true },
    {
      topology: {
        version: 1,
        device_id: 'mac',
        observed_at: now,
        masters: [{ session_id: boardMaster, name: 'Board-codex-master', task_ids: [19], workers_active: null }],
      },
    },
    'heartbeat',
  )
  expect(fake.calls('claim_task').map(call => call.params.arguments)).toEqual([
    { task_id: 19, executor: 'Board-codex-master' },
  ])
  expect(watcher.view()?.queue).toBe(0)
  expect(rows().map(row => row.title)).toEqual(['Test card 19'])
  await check({ topology: { deviceId: 'mac' }, onlyTaskId: 19 }, { tasks: [task(19)], topology: true }, {})
})
