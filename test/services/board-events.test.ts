import { expect, test } from 'bun:test'
import { boardEventStore, openBoardEventDb } from '../../src/adapters/board-event-store.ts'
import type { HerdrPane, HerdrSnapshot } from '../../src/adapters/herdr.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import type { Item } from '../../src/core/types.ts'
import type { WorkdeskEvent } from '../../src/core/workdesk-events.ts'
import { dispatch } from '../../src/server/http.ts'
import { boardEventRoutes } from '../../src/server/routes/board-events.ts'
import { createBoardEvents, sessionObservations } from '../../src/services/board-events.ts'
import type { Deps } from '../../src/services/deps.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'

const coordinator = '725b4602-d3d6-43ee-b7fc-b26fc0a3e7e5'
const worker = '71a1f5bf-3102-7e90-bef9-9662c3db0a7c'
const other = '71a1f7ef-1bb4-7141-b631-47d57cd8da5f'
const assignment = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
const report = (id: number, revision = 1): WorkdeskEvent => ({
  id,
  type: 'task.reported',
  status: 'done',
  stage: 'Сдача',
  board_task_id: 22,
  miniapp_id: 253,
  assignment_id: assignment,
  revision,
  created_at: 1_700_000_000_000 + id,
})
const live = (sid: string, pane: string, status = 'idle'): HerdrPane => ({
  pane_id: pane,
  terminal_id: `term-${pane}`,
  agent: 'codex',
  agent_status: status,
  agent_session: { value: sid },
})
const snapshot = (...panes: HerdrPane[]): HerdrSnapshot => ({ panes, tabs: [], workspaces: [] })
function item(sid: string, pane: string, options: Partial<Item> = {}): Item {
  return {
    name: 'Coordinator',
    key: sid,
    session: sid,
    pane,
    cwd: 'Проект с пробелами %',
    workspace: null,
    category: 'board',
    categorySet: true,
    autoName: '',
    status: 'idle',
    column: 'idle',
    attention: '',
    agent: 'codex',
    ...options,
  }
}
const decoder = new TextDecoder()

test('only native unambiguous current SIDs produce transitions; no dialog replay on restart', async () => {
  isolatedHome()
  const deps = { cfg: normalizeConfig({ boardEvents: true }), log() {} } as unknown as Deps
  const start = () => createBoardEvents(deps)
  const svc = start()
  const at = Date.now()
  const items = [item(worker, 'p1'), item(other, 'p2', { attention: 'ask' })]
  const ambiguous = snapshot(live(worker, 'p1'), live(worker, 'p3'), live('pane-p2', 'p2'))
  expect(sessionObservations(ambiguous, items)).toEqual([])
  svc.observe(snapshot(live(worker, 'p1'), live(other, 'p2')), items, at)
  svc.observe(snapshot(live(worker, 'p1', 'blocked'), live(other, 'p2')), items, at + 10)
  svc.observe(snapshot(live(worker, 'p1', 'unknown'), live(other, 'p2')), items, at + 20)
  await svc.stop()
  const reopened = start()
  try {
    reopened.observe(snapshot(live(worker, 'p1', 'blocked'), live(other, 'p2')), items, at + 30)
    reopened.observe(snapshot(live(worker, 'p1'), live(other, 'p2')), items, at + 40)
    reopened.observe(snapshot({ pane_id: 'p1', terminal_id: 'term-p1' }, live(other, 'p2')), items.slice(1), at + 50)
    expect(
      reopened
        .store()
        .read(0)
        .map(e => [e.type, e.session_id]),
    ).toEqual([
      ['session.owner', other],
      ['session.dialog', worker],
      ['session.free', worker],
      ['session.exited', worker],
    ])
    expect(
      reopened
        .store()
        .pendingWake(at + 50)
        .map(e => e.type),
    ).toEqual(['session.dialog'])
  } finally {
    await reopened.stop()
  }
})

test('only the configured current coordinator receives decision events, with crash-safe dedup and rate limiting', async () => {
  isolatedHome()
  const cfg = normalizeConfig({ boardEvents: { coordinatorSid: coordinator } })
  const deps = { cfg, log() {} } as unknown as Deps
  const prompts: { sid: string; message: string }[] = []
  const start = () =>
    createBoardEvents(deps, async (_deps, target, message) => {
      prompts.push({ sid: target.session ?? '', message })
      return { ok: true }
    })
  const ordinary = item(worker, 'p1')
  const exact = item(coordinator, 'p2')
  const similar = item(other, 'p3')
  const at = Date.now()
  const svc = start()
  svc.observe(snapshot(live(worker, 'p1'), live(other, 'p3')), [ordinary, similar], at)
  svc.observe(snapshot(live(worker, 'p1', 'working'), live(other, 'p3')), [ordinary, similar], at + 1)
  svc.observe(snapshot(live(worker, 'p1'), live(other, 'p3')), [ordinary, similar], at + 2)
  svc.observe(snapshot(live(worker, 'p1', 'blocked'), live(other, 'p3')), [ordinary, similar], at + 3)
  await Bun.sleep(0)
  expect(prompts).toHaveLength(0)

  svc.observe(
    snapshot(live(worker, 'p1', 'blocked'), live(coordinator, 'p2'), live(coordinator, 'p3')),
    [ordinary, exact],
    at + 4,
  )
  await Bun.sleep(0)
  expect(prompts).toHaveLength(0)
  svc.observe(
    snapshot(live(worker, 'p1', 'blocked'), live(coordinator, 'p2'), live(other, 'p3')),
    [ordinary, exact, similar],
    at + 5,
  )
  await until(() => prompts.length === 1)
  expect(prompts).toEqual([{ sid: coordinator, message: `[События Борды] #2 session.dialog ${worker}` }])
  await svc.stop()

  const restarted = start()
  try {
    restarted.source('workdesk').commit(report(17))
    restarted.source('workdesk').reset()
    restarted.source('workdesk').commit(report(17))
    restarted.source('workdesk').commit(report(18, 2))
    const show = () => snapshot(live(worker, 'p1', 'blocked'), live(coordinator, 'p2'), live(other, 'p3'))
    restarted.observe(show(), [ordinary, exact, similar], at + 6)
    await Bun.sleep(0)
    expect(prompts).toHaveLength(1)
    restarted.observe(show(), [ordinary, exact, similar], at + 60_005)
    await until(() => prompts.length === 2)
    expect(prompts[1]).toMatchObject({
      sid: coordinator,
      message: '[События Борды] #4 task.submitted Workdesk #22, #5 task.submitted Workdesk #22',
    })
    expect(
      restarted
        .store()
        .read(0)
        .filter(e => e.type === 'task.submitted')
        .map(e => e.source_event_id),
    ).toEqual([17, 18])
  } finally {
    await restarted.stop()
  }
})

test('90 minutes are measured from the authoritative stage timestamp once per generation and health errors are throttled', () => {
  isolatedHome()
  const db = openBoardEventDb()
  if (!db) throw new Error('missing event DB')
  try {
    const store = boardEventStore(db)
    const at = Date.now()
    const stage = { taskId: 22, assignmentId: assignment, revision: 1, stage: '2/4 SSE', startedAt: at }
    const due = at + 90 * 60_000
    store.stages([stage])
    expect(store.nextStageAt()).toBe(due)
    store.expireStages(due - 1)
    expect(store.read(0)).toEqual([])
    store.expireStages(due)
    store.stages([stage])
    store.expireStages(due + 1)
    expect(store.nextStageAt()).toBeNull()
    store.stages([])
    store.stages([stage])
    store.expireStages(due + 2)
    store.stages([{ ...stage, revision: 2, startedAt: at + 100 }])
    store.expireStages(due + 100)
    store.stages([{ ...stage, revision: 2, stage: '3/4 события', startedAt: at + 200 }])
    store.expireStages(due + 200)
    store.health('workdesk.events', false, due + 201)
    store.health('workdesk.events', false, due + 203)
    store.health('workdesk.events', true, due + 204)
    store.health('workdesk.events', false, due + 205)
    expect(store.read(0).map(e => [e.type, e.stage_started_at])).toEqual([
      ['task.stage_overdue', at],
      ['task.stage_overdue', at + 100],
      ['task.stage_overdue', at + 200],
      ['service.unavailable', undefined],
      ['service.recovered', undefined],
    ])
  } finally {
    db.close()
  }
})

test('local coordinator API uses event IDs for live delivery, restart replay, and explicit ACK', async () => {
  isolatedHome()
  const deps = { cfg: normalizeConfig({ boardEvents: true }), log() {} } as unknown as Deps
  const at = Date.now()
  const service = createBoardEvents(deps)
  const headers = { 'x-board': '1' }
  const address = 'http://127.0.0.1/api/board-events'
  const route = (svc: typeof service, resource = '', init: RequestInit = {}) => {
    const url = new URL(address + resource)
    return dispatch(boardEventRoutes(svc), new Request(url, init), url, url.pathname, {
      port: 80,
      token: 'test',
      stale: () => false,
    })
  }
  expect((await route(service)).status).toBe(403)
  expect((await route(service, '', { headers: { ...headers, origin: 'https://example.com' } })).status).toBe(403)
  expect((await route(service, '?since=1&since=2', { headers })).status).toBe(400)
  const response = await route(service, '', { headers })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing event stream')
  try {
    expect(decoder.decode((await reader.read()).value)).toBe(': connected\n\n')
    const arrived = reader.read()
    service.observe(snapshot(live(worker, 'p1', 'blocked')), [item(worker, 'p1')], at)
    expect(decoder.decode((await arrived).value)).toContain('id: 1\nevent: session.dialog\n')
    const ack = await route(service, '/ack', { method: 'POST', headers, body: '{"through":1}' })
    expect(await ack.json()).toEqual({ ok: true })
    expect((await route(service, '/ack', { method: 'POST', headers, body: '{"through":10}' })).status).toBe(400)
  } finally {
    await reader.cancel()
    await service.stop()
  }
  const next = createBoardEvents(deps)
  try {
    next.observe(snapshot(live(worker, 'p1')), [item(worker, 'p1')], at + 1)
    const response = await route(next, '', { headers: { ...headers, 'Last-Event-ID': '1' } })
    const replay = response.body?.getReader()
    if (!replay) throw new Error('missing replay')
    try {
      await replay.read()
      expect(decoder.decode((await replay.read()).value)).toContain('id: 2\nevent: session.free\n')
    } finally {
      await replay.cancel()
    }
    const reset = await route(next, '?since=42', { headers })
    expect(reset.status).toBe(409)
    expect(await reset.json()).toEqual({ error: 'cursor_reset', high_water: 2, reset_cursor: 0 })
  } finally {
    await next.stop()
  }
})
