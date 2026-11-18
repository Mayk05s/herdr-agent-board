// A result handed in for review (board-6): an agent posts `--status review` with the result and how
// to check it; the owner accepts it (done) or returns it with a remark (doing again), and the
// session that handed it in has the verdict typed in, as an answer is. It counts as waiting on the
// owner, a shared thread does not take it, and on the wire it goes as `owner` for older boards.
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { wireHead, wireSet } from '../../src/core/work-share.ts'
import {
  applyEntry,
  digestLine,
  isThreadStatus,
  type Party,
  type ThreadHead,
  type ThreadView,
} from '../../src/core/work-threads.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { dispatch, type Route } from '../../src/server/http.ts'
import { revStream, type ThreadsApp, threadsRoutes } from '../../src/server/routes/threads.ts'
import { isolatedHome } from '../support/env.ts'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const master: Party = { kind: 'session', key: '11111111-1111-4111-8111-111111111111', name: 'Board-master' }
const worker: Party = { kind: 'session', key: 'pane-w8:p2M', name: 'Board pool, тест %' }
const sessions: Record<string, Party> = { 'Board-master': master, worker }
const STATE = { port: 12422, token: '', stale: () => false }

function setUp() {
  isolatedHome()
  const told: { session: string; text: string }[] = []
  const app: ThreadsApp = {
    cfg: { threads: true },
    changed: () => {},
    async tell(session, text) {
      told.push({ session, text })
      return { ok: true }
    },
    clearAsk: () => {},
    now: () => NOW,
  }
  const routes: Route[] = threadsRoutes(app, revStream())
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://127.0.0.1:12422${path}`)
    const req = new Request(url, {
      method,
      headers: { 'content-type': 'application/json', ...(method === 'POST' && { 'x-board': '1' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const res = await dispatch(routes, req, url, decodeURIComponent(url.pathname), STATE)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const cli = async (actor: Party, args: string[], code = 0) => {
    const out: string[] = []
    const got = await threadCmd(args, {
      cfg: { threads: true, port: 12422 },
      actor,
      lane: 'board',
      findSession: async w => sessions[w] ?? null,
      out: l => out.push(l),
      err: l => out.push(l),
      now: NOW,
    })
    assert.equal(got, code, out.join('\n'))
    return out.join('\n')
  }
  const view = async (key: string) => (await call('GET', `/api/threads/${key}?full=1`)).body as unknown as ThreadView
  return { call, cli, told, view }
}

test('review is a status: the CLI takes it, the event says ready for review with the result', async () => {
  assert.equal(isThreadStatus('review'), true)
  const { cli, view } = setUp()
  await cli(master, ['new', '--to', 'worker', 'Pool screen'])
  const out = await cli(worker, [
    'post',
    'board-1',
    '--status',
    'review',
    '--summary',
    'Tasks screen built, local commit',
    '--link',
    'http://127.0.0.1:12499/#tasks',
    'Open #tasks, add a task, see it under Planned',
  ])
  assert.match(out, /ok · board-1 · review/)
  const v = await view('board-1')
  assert.equal(v.head.status, 'review')
  const review = v.entries.find(e => e.id === v.review)
  assert.equal(review?.text, 'Open #tasks, add a task, see it under Planned')
  assert.equal(
    digestLine([{ head: v.head, status: true, entries: 1, local: true }]),
    'board-1 ready for review: Tasks screen built, local commit. More: board thread changes',
  )
})

test('review counts as waiting on the owner in the payload', async () => {
  const { call, cli } = setUp()
  await cli(master, ['new', 'One'])
  await cli(master, ['new', 'Two'])
  await cli(worker, ['post', 'board-1', '--status', 'review', '--summary', 'done locally', 'check it'])
  const list = await call('GET', '/api/threads')
  assert.equal(list.status, 200)
  const { threadsLine, withThreadsDb } = await import('../../src/services/work-threads.ts')
  assert.equal(
    withThreadsDb(false, db => threadsLine(db).needsOwner),
    1,
  )
})

test('the owner accepts: done, the summary kept, the session that handed it in is told', async () => {
  const { call, cli, told, view } = setUp()
  await cli(master, ['new', '--to', 'worker', 'Pool screen'])
  await cli(worker, ['post', 'board-1', '--status', 'review', '--summary', 'built', 'open it and look'])
  const r = await call('POST', '/api/threads/board-1', { op: 'accept' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.told, true)
  const v = await view('board-1')
  assert.equal(v.head.status, 'done')
  assert.equal(v.head.summary, 'built')
  assert.equal(v.review, null)
  assert.deepEqual(told, [
    { session: worker.kind === 'session' ? worker.key : '', text: '[board thread board-1] accepted: done' },
  ])
})

test('the owner returns it with a remark: doing again, the remark in the feed and typed into the session', async () => {
  const { call, cli, told, view } = setUp()
  await cli(master, ['new', '--to', 'worker', 'Pool screen'])
  await cli(worker, ['post', 'board-1', '--status', 'review', '--summary', 'built', 'open it and look'])
  const before = await view('board-1')
  const r = await call('POST', '/api/threads/board-1', { op: 'return', text: 'Нет кнопки «Новая задача» на телефоне' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const v = await view('board-1')
  assert.equal(v.head.status, 'doing')
  const remark = v.entries.at(-1)
  assert.equal(remark?.text, 'Нет кнопки «Новая задача» на телефоне')
  assert.deepEqual(remark?.author, { kind: 'owner' })
  assert.equal(remark?.replyTo, before.review)
  assert.deepEqual(told, [
    { session: 'pane-w8:p2M', text: '[board thread board-1] returned to work: Нет кнопки «Новая задача» на телефоне' },
  ])
  // Handed in again, then accepted: the whole history stays in the feed.
  await cli(worker, ['post', 'board-1', '--status', 'review', '--summary', 'button added', 'phone width: see it'])
  assert.equal((await call('POST', '/api/threads/board-1', { op: 'accept' })).status, 200)
  const end = await view('board-1')
  assert.equal(end.head.status, 'done')
  assert.deepEqual(
    end.entries.map(e => e.set?.status ?? e.type),
    ['doing', 'review', 'doing', 'review', 'done'],
  )
})

test('accept and return are refused on a thread that is not in review, and a return needs words', async () => {
  const { call, cli } = setUp()
  await cli(master, ['new', '--to', 'worker', 'Pool screen'])
  assert.equal((await call('POST', '/api/threads/board-1', { op: 'accept' })).status, 400)
  assert.equal((await call('POST', '/api/threads/board-1', { op: 'return', text: 'x' })).status, 400)
  await cli(worker, ['post', 'board-1', '--status', 'review', '--summary', 'built', 'look'])
  assert.equal((await call('POST', '/api/threads/board-1', { op: 'return', text: '  ' })).status, 400)
})

test('a thread the owner made and nobody handed in: the verdict tells the assignee, or no one', async () => {
  const { call, told } = setUp()
  const made = await call('POST', '/api/threads', { op: 'new', lane: 'board', title: 'Owner task' })
  assert.equal(made.status, 200)
  assert.equal(made.body.key, 'board-1')
  assert.equal((await call('POST', '/api/threads/board-1', { op: 'post', status: 'review', text: 'look' })).status, 200)
  const r = await call('POST', '/api/threads/board-1', { op: 'accept' })
  assert.equal(r.status, 200)
  assert.equal(r.body.told, undefined)
  assert.deepEqual(told, [])
})

test('on the wire review goes as owner, so a board without it takes the entry', () => {
  const head = {
    id: 'x',
    key: 'board-1',
    lane: 'board',
    title: 'Pool',
    summary: 'built',
    status: 'review',
    waitingOn: '',
    proposed: null,
    assignee: null,
    parent: null,
    scope: 'local',
    createdBy: { kind: 'owner' },
    createdAt: NOW,
    updatedAt: NOW,
    doneAt: null,
    rev: 2,
  } as ThreadHead
  assert.equal(wireHead(head).status, 'owner')
  assert.equal(wireSet({ status: 'review', summary: 'built' }, 'me')?.status, 'owner')
  assert.equal(wireSet({ status: 'doing' }, 'me')?.status, 'doing')
  // Leaving review clears nothing it should keep; waitingOn goes as for any status but waiting and owner.
  const next = applyEntry(
    { ...head, status: 'owner', waitingOn: 'a question' },
    {
      id: 'e',
      thread: 'x',
      n: 3,
      seq: 3,
      at: NOW,
      author: { kind: 'owner' },
      type: 'note',
      text: '',
      set: { status: 'review' },
    },
  )
  assert.equal(next.status, 'review')
  assert.equal(next.waitingOn, '')
  assert.equal(next.doneAt, null)
})
