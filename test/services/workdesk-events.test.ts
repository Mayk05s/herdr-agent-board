import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { boardEventStore, openBoardEventDb } from '../../src/adapters/board-event-store.ts'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { entriesOf } from '../../src/adapters/work-thread-store.ts'
import { workdeskDialogStore } from '../../src/adapters/workdesk-dialog-store.ts'
import { connectWorkdeskEvents, workdeskFrames } from '../../src/adapters/workdesk-events.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import type { Item } from '../../src/core/types.ts'
import type { OwnerEvent } from '../../src/core/workdesk-dialog.ts'
import { type WorkdeskEvent, workdeskEventsConfig } from '../../src/core/workdesk-events.ts'
import { createWorkdeskDialog } from '../../src/services/workdesk-dialog.ts'
import { runWorkdeskEvents, workdeskEventHandlers } from '../../src/services/workdesk-events.ts'
import { createWorkdeskWatcher } from '../../src/services/workdesk-watcher.ts'
import { isolatedHome } from '../support/env.ts'
import { until } from '../support/sandbox.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

const ASSIGNMENT = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
const SECOND = 'a1f42fcb-9183-41d0-b577-030828bf5e89'
const SID = '018f5280-4ef2-42e8-9b0f-4517daaf0d36'
const NAME = 'Board-codex-master'
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
const encoder = new TextEncoder()
const sinceOf = (url: Parameters<typeof fetch>[0]) => Number(new URL(String(url)).searchParams.get('since'))
const open = (db: BoardDb | null) => {
  if (!db) throw new Error('test database unavailable')
  return db
}
const common = (id: number, taskId = 1, assignment = ASSIGNMENT, revision = 1) => ({
  id,
  board_task_id: taskId,
  miniapp_id: 253,
  assignment_id: assignment,
  revision,
  created_at: Date.now(),
})
const frame = (event: WorkdeskEvent) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

function stream(signal: AbortSignal, events: WorkdeskEvent[], close = false) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(sink) {
        sink.enqueue(encoder.encode(': connected\n\n'))
        for (const event of events) sink.enqueue(encoder.encode(frame(event)))
        if (close) sink.close()
        else signal.addEventListener('abort', () => sink.error(signal.reason), { once: true })
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  )
}

const config = (tokenFile: string) => ({ url: 'https://workdesk.test/workdesk/api/board/events', tokenFile })

test('strict UTF-8 and fragmented SSE handles comments, metadata, gaps and malformed frames', async () => {
  const value = { ...common(4), type: 'task.reported', stage: 'Этап №2', status: 'doing' } satisfies WorkdeskEvent
  const event = encoder.encode(`: ping\n\n${frame(value)}`.replaceAll('\n', '\r\n'))
  const oneByteAtATime = new ReadableStream<Uint8Array>({
    start(sink) {
      for (const byte of event) sink.enqueue(Uint8Array.of(byte))
      sink.close()
    },
  })
  const frames = workdeskFrames(oneByteAtATime, () => {})
  expect((await frames.next()).value).toEqual(value)
  expect((await frames.next()).done).toBe(true)
  const malformed = stream(new AbortController().signal, [], true)
  const nested = new ReadableStream<Uint8Array>({
    start(sink) {
      sink.enqueue(encoder.encode(frame(value).replace('id: 4', 'id: 5')))
      sink.close()
    },
  })
  if (!malformed.body) throw new Error('missing stream')
  expect((await workdeskFrames(malformed.body, () => {}).next()).done).toBe(true)
  await expect(workdeskFrames(nested, () => {}).next()).rejects.toThrow('Invalid Workdesk SSE event')
})

test('subscribe before W1 snapshot, persist v2 notices, replay gaps and duplicates, and keep a new thread per assignment', async () => {
  const dir = isolatedHome()
  const fake = mcp(dir)
  const tokenPath = join(dir, 'token')
  await Bun.write(tokenPath, 'test-coordinator')
  const cfg = normalizeConfig({ threads: true, workdesk: fake.config, workdeskDialog: {} })
  const ownerEvent = (id: number, kind: 'choice' | 'rework', revision: number): OwnerEvent => ({
    id,
    kind,
    revision,
    created_at: id,
    board_task_id: 1,
    assignment_id: ASSIGNMENT,
    executor: NAME,
    board_status: 'doing',
  })
  const assigned: WorkdeskEvent = { ...common(3), type: 'task.assigned_board' }
  const reply: WorkdeskEvent = { ...common(9), type: 'owner.message', message_id: 21 }
  const rework: WorkdeskEvent = { ...common(13, 1, ASSIGNMENT, 2), type: 'owner.rework', message_id: 28 }
  const reassigned: WorkdeskEvent = { ...common(19, 2, SECOND), type: 'task.assigned_board' }
  const rawTask = { ...task(1), assignment_id: ASSIGNMENT, revision: 1 }
  fake.write({ tasks: [], dialog: { delivered: 0, events: [] } })
  const w1 = createWorkdeskWatcher({ cfg, items: () => [item], onChange() {}, log() {}, streamDriven: () => true })
  const dialog = createWorkdeskDialog({ cfg, items: () => [item], onChange() {}, streamDriven: () => true })
  w1.configChanged()
  dialog.configChanged()
  const controller = new AbortController()
  const calls: number[] = []
  let eventDb = open(openBoardEventDb())
  let running: Promise<void> | undefined
  const savedCursor = () => boardEventStore(eventDb).cursor('integration')
  function start(signal: AbortSignal) {
    return runWorkdeskEvents({
      signal,
      cursor: {
        read: () => savedCursor().read(),
        reset: () => savedCursor().reset(),
        commit: e => savedCursor().commit(e),
      },
      connect(since, signal) {
        return connectWorkdeskEvents(config(tokenPath), since, signal, async (url, init) => {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-coordinator')
          expect(init?.redirect).toBe('error')
          calls.push(sinceOf(url))
          if (calls.length === 1) {
            // Arrives before the initial MCP list is requested.
            expect(fake.calls('list_board_tasks')).toHaveLength(0)
            fake.write({ tasks: [rawTask], dialog: { delivered: 0, events: [] } })
            return stream(signal, [assigned], true)
          }
          if (calls.length === 2) {
            fake.write({
              tasks: [{ ...rawTask, status: 'doing', executor: NAME, revision: 2 }],
              dialog: { delivered: 0, events: [ownerEvent(21, 'choice', 1), ownerEvent(28, 'rework', 2)] },
            })
            return stream(signal, [assigned, reply, rework])
          }
          fake.write({
            tasks: [{ ...task(2), assignment_id: SECOND, revision: 1 }],
            dialog: { delivered: 0, events: [ownerEvent(21, 'choice', 1), ownerEvent(28, 'rework', 2)] },
          })
          return stream(signal, [rework, reassigned])
        })
      },
      connectionHealthy() {},
      ...workdeskEventHandlers(w1, dialog),
      minRetryMs: 10,
    })
  }
  try {
    running = start(controller.signal)
    await until(() => savedCursor().read() === rework.id)
    expect(calls).toEqual([0, 3])
    expect(rows()).toHaveLength(1)
    const [first] = rows()
    if (!first) throw new Error('missing first thread')
    controller.abort()
    await running
    eventDb.close()
    eventDb = open(openBoardEventDb())
    const restarted = new AbortController()
    try {
      running = start(restarted.signal)
      await until(() => savedCursor().read() === reassigned.id)
      expect(calls).toEqual([0, 3, 13])
      expect(rows().map(row => row.title)).toEqual(['Test card 1', 'Test card 2'])
      const [original, replacement] = rows()
      if (!replacement) throw new Error('missing replacement thread')
      expect(original?.id).toBe(first.id)
      expect(fake.calls('claim_task').map(call => (call.params.arguments as { task_id: number }).task_id)).toEqual([
        1, 2,
      ])
      const db = open(openDb())
      try {
        const notices = entriesOf(db, first.id).slice(1)
        expect(notices.some(entry => entry.text?.includes('обновление диалога'))).toBe(true)
        expect(entriesOf(db, replacement.id)).toHaveLength(2)
        expect(workdeskDialogStore(db, () => [item]).cursor()).toBe(28)
        expect(fake.calls('read_owner_messages')).toEqual([])
        expect(fake.calls('ack_owner_messages')).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      restarted.abort()
      await running
    }
  } finally {
    controller.abort()
    await running
    await Promise.all([w1.stop(), dialog.stop()])
    eventDb.close()
  }
})

test('reset establishes a fresh buffered snapshot, old server polls, and failed processing leaves the frame replayable', async () => {
  const tokenPath = join(isolatedHome(), 'token')
  await Bun.write(tokenPath, 'test-coordinator')
  let cursor = 100
  const controller = new AbortController()
  const seen: string[] = []
  const value: WorkdeskEvent = { ...common(7), type: 'task.claimed' }
  let failures = 0
  let attempts = 0
  const running = runWorkdeskEvents({
    signal: controller.signal,
    cursor: {
      read: () => cursor,
      reset: () => {
        seen.push('reset')
        cursor = 0
      },
      commit: event => {
        cursor = event.id
      },
    },
    connect(since, signal) {
      seen.push(`connect:${since}`)
      attempts++
      return connectWorkdeskEvents(config(tokenPath), since, signal, async () => {
        if (since > 7) return Response.json({ error: 'cursor_reset', reset_cursor: 0, high_water: 7 }, { status: 409 })
        if (attempts === 2) return new Response('Not Found', { status: 404 })
        return stream(signal, [value])
      })
    },
    async reconcile() {
      seen.push('snapshot')
    },
    async apply() {
      seen.push('apply')
      if (++failures === 1) throw new Error('durable write failed')
    },
    connectionHealthy() {},
    minRetryMs: 5,
    maxRetryMs: 20,
    intervalMs: 80,
  })
  try {
    await until(() => cursor === 7)
    expect(seen.slice(0, 6)).toEqual(['connect:100', 'reset', 'connect:0', 'snapshot', 'connect:0', 'snapshot'])
    expect(seen.filter(entry => entry === 'connect:0')).toHaveLength(3)
    expect(seen.filter(entry => entry === 'apply')).toHaveLength(2)
    const previousPolls = seen.filter(entry => entry === 'snapshot').length
    await until(() => seen.filter(entry => entry === 'snapshot').length > previousPolls)
  } finally {
    controller.abort()
    await running
  }
})

test('one coordinator config supplies the SSE bearer and reuses the watcher CA after rotation', async () => {
  const dir = isolatedHome()
  const configFile = join(dir, 'project-master.json')
  const caFile = join(dir, 'isolated-ca.pem')
  await Bun.write(caFile, 'synthetic CA')
  const url = 'https://workdesk.test:9443/workdesk/api/board/events'
  const active = workdeskEventsConfig({ caFile, events: { url, configFile } })
  expect(active).toEqual({ url, configFile, caFile })
  expect(workdeskEventsConfig({ caFile, events: { url, tokenFile: configFile, configFile } })).toBeNull()
  expect(workdeskEventsConfig({ events: { url, configFile, caFile: 'relative.pem' } })).toBeNull()
  if (!active) throw new Error('coordinator settings rejected')
  for (const token of ['a'.repeat(43), 'b'.repeat(43)]) {
    await Bun.write(configFile, JSON.stringify({ url: 'https://workdesk.test:9443', token, target: 'fixture' }))
    const controller = new AbortController()
    const connection = await connectWorkdeskEvents(active, 3, controller.signal, async (input, init) => {
      expect(String(input)).toBe(`${url}?since=3`)
      expect(new Headers(init?.headers).get('authorization') === `Bearer ${token}`).toBe(true)
      expect(init?.redirect).toBe('error')
      expect(init?.tls?.ca).toBe('synthetic CA')
      return stream(controller.signal, [], true)
    })
    try {
      expect((await connection.events.next()).done).toBe(true)
    } finally {
      connection.close()
    }
  }
})

test('the coordinator bearer stays local when the origin, route or JSON fails validation', async () => {
  const configFile = join(isolatedHome(), 'project-master.json')
  const url = 'https://workdesk.test:9443/workdesk/api/board/events'
  const token = 'c'.repeat(43)
  const signal = new AbortController().signal
  let calls = 0
  const fetcher = async () => {
    calls++
    throw new Error('unexpected fetch')
  }
  for (const base of [
    'http://workdesk.test:9443',
    'https://unrelated.test:9443',
    'https://workdesk.test:9444',
    'https://user@workdesk.test:9443',
  ]) {
    await Bun.write(configFile, JSON.stringify({ url: base, token }))
    await expect(connectWorkdeskEvents({ url, configFile }, 0, signal, fetcher)).rejects.toThrow(
      'Workdesk SSE origin differs from coordinator configuration',
    )
  }
  await Bun.write(configFile, JSON.stringify({ url: 'https://workdesk.test:9443', token }))
  for (const endpoint of [
    'http://workdesk.test:9443/workdesk/api/board/events',
    'https://workdesk.test:9443/mcp',
    `${url}?since=7`,
    `${url}#other`,
  ]) {
    expect(workdeskEventsConfig({ events: { url: endpoint, configFile } })).toBeNull()
    await expect(connectWorkdeskEvents({ url: endpoint, configFile }, 0, signal, fetcher)).rejects.toThrow(
      'Invalid Workdesk SSE endpoint',
    )
  }
  await Bun.write(configFile, `{"url":"https://workdesk.test:9443","token":"${token}" unexpected}`)
  const failure: unknown = await connectWorkdeskEvents({ url, configFile }, 0, signal, fetcher).catch(error => error)
  expect(String(failure)).toBe('Error: Invalid Workdesk coordinator configuration')
  expect(calls).toBe(0)
})
