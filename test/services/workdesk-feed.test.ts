import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { entriesOf, getThread } from '../../src/adapters/work-thread-store.ts'
import { workdeskStore } from '../../src/adapters/workdesk-store.ts'
import { normalizeConfig } from '../../src/core/categories.ts'
import { threadsConfig } from '../../src/core/work-threads.ts'
import { workdeskTask } from '../../src/core/workdesk.ts'
import { askOwner, postEntry, type ThreadsCtx } from '../../src/services/work-threads.ts'
import { cardOf, chatText, feedFile, feedOnce, readFeed } from '../../src/services/workdesk-feed.ts'
import { isolatedHome } from '../support/env.ts'
import { mcp, task } from '../support/workdesk-fixture.ts'

const SID = '018f5280-4ef2-42e8-9b0f-4517daaf0d36'
const ASSIGNMENT = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
const NAME = 'Board-codex-master'
const MASTER = { key: SID, name: NAME, lane: 'board', sid: SID }
const EXECUTOR = { kind: 'session', key: 'pane-7', name: 'Board feed Тест %' } as const
const live = (status = 'doing', summary = '') => ({
  ...task(1),
  assignment_id: ASSIGNMENT,
  revision: 1,
  executor: NAME,
  status,
  summary,
})

function withDb<T>(fn: (db: BoardDb) => T): T {
  const db = openDb()
  if (!db) throw new Error('expected sandbox database')
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function setup(feed: object = { messages: [] }, extra: Record<string, unknown> = { feed: true }) {
  const fake = mcp(isolatedHome())
  fake.write({ tasks: [live()], feed })
  const cfg = normalizeConfig({ threads: true, workdesk: { ...fake.config, ...extra } })
  const thread = withDb(db => {
    const store = workdeskStore(db)
    const assignment = workdeskTask(live())
    if (!assignment) throw new Error('bad fixture')
    store.reserve(1, MASTER)
    store.handoff(assignment, MASTER, 1)
    const id = store.find(1)?.thread_id
    if (!id) throw new Error('no handoff')
    return id
  })
  const ctx = (db: BoardDb, actor: ThreadsCtx['actor'] = EXECUTOR): ThreadsCtx => ({
    db,
    cfg: threadsConfig(true) as NonNullable<ReturnType<typeof threadsConfig>>,
    actor,
    now: Date.now(),
    schedule: { list: () => [], add: f => ({ ...f, id: 'x' }) as never, takeBack: () => true },
  })
  const post = (fn: (c: ThreadsCtx, head: NonNullable<ReturnType<typeof getThread>>) => void) =>
    withDb(db => {
      const head = getThread(db, thread)
      if (!head) throw new Error('no thread')
      fn(ctx(db), head)
    })
  const tick = () => feedOnce({ cfg, log: () => {} }, new AbortController().signal)
  const head = () => withDb(db => getThread(db, thread))
  const entries = () => withDb(db => entriesOf(db, thread))
  return { fake, cfg, thread, post, tick, head, entries }
}

test('off unless workdesk.feed is set: no Workdesk call, no state file', async () => {
  const f = setup({ messages: [] }, {})
  f.post((c, h) => postEntry(c, h, { text: 'not for the chat' }))
  await f.tick()
  expect(f.fake.calls()).toEqual([])
  expect(existsSync(feedFile())).toBe(false)
})

test('a session note goes to the chat once, with the thread, the entry and its author; the past stays', async () => {
  const f = setup()
  f.post((c, h) => postEntry(c, h, { text: 'before the feed' }))
  await f.tick()
  expect(f.fake.calls('post_board_thread_message')).toEqual([])
  f.post((c, h) => postEntry(c, h, { text: 'Сделано: 50% готово', status: 'doing' }))
  f.post((c, h) => postEntry(c, h, { text: 'private', private: true }))
  f.post((c, h) => postEntry(c, h, { status: 'waiting', waitingOn: 'CI' }))
  await f.tick()
  await f.tick()
  const sent = f.fake.calls('post_board_thread_message').map(c => c.params.arguments)
  const last = f.entries().find(e => e.text === 'Сделано: 50% готово')
  expect(sent).toEqual([
    {
      task_id: 1,
      assignment_id: ASSIGNMENT,
      revision: 1,
      executor: NAME,
      thread_uuid: f.thread,
      entry_uuid: last?.id,
      author: 'Board feed Тест %',
      text: 'Сделано: 50% готово',
    },
  ])
})

test('a question in the thread puts the card under "Ждёт меня"; the owner answer comes back and is acknowledged', async () => {
  const f = setup()
  await f.tick()
  f.post((c, h) => askOwner(c, h, 'Какой цвет?'))
  await f.tick()
  expect(f.fake.calls('report_task').map(c => c.params.arguments)).toEqual([
    { task_id: 1, assignment_id: ASSIGNMENT, revision: 1, status: 'waiting', summary: 'Нужно от вас: Какой цвет?' },
  ])
  expect(f.fake.calls('post_board_thread_message')).toEqual([])
  expect(f.head()?.status).toBe('owner')

  f.fake.write({ tasks: [live('doing')], feed: { messages: [{ id: 41, kind: 'message', text: 'Синий' }] } })
  await f.tick()
  await f.tick()
  const answers = f.entries().filter(e => e.type === 'answer')
  expect(answers.map(e => [e.author.kind, e.text])).toEqual([['owner', 'Синий']])
  expect(answers[0]?.replyTo).toBeDefined()
  expect(f.head()?.status).toBe('doing')
  expect(f.fake.calls('ack_owner_messages').map(c => c.params.arguments)).toEqual([
    { task_id: 1, assignment_id: ASSIGNMENT, executor: NAME, through: 41 },
  ])
  expect(readFeed().tasks['1']?.read).toBe(41)
  // The owner's words are not sent back to the chat.
  expect(f.fake.calls('post_board_thread_message')).toEqual([])
})

test('an owner message with no question open is an answer all the same; Workdesk waiting puts the thread with the owner', async () => {
  const f = setup({ messages: [{ id: 5, kind: 'message', text: 'Ещё одно' }] })
  await f.tick()
  expect(
    f
      .entries()
      .filter(e => e.type === 'answer')
      .map(e => e.text),
  ).toEqual(['Ещё одно'])
  f.fake.write({ tasks: [live('waiting', 'Нужно от вас: проверь')], feed: { messages: [], delivered: 5 } })
  await f.tick()
  expect(f.head()?.status).toBe('owner')
  expect(f.head()?.waitingOn).toBe('Нужно от вас: проверь')
})

test('accepted in Workdesk closes the thread, awaiting acceptance leaves it open', async () => {
  const f = setup()
  await f.tick()
  f.fake.write({ tasks: [], feed: { messages: [], taskStatus: 'working' } })
  await f.tick()
  expect(f.head()?.status).toBe('doing')
  f.fake.write({ tasks: [], feed: { messages: [], taskStatus: 'done' } })
  await f.tick()
  expect(f.head()?.status).toBe('done')
  expect(f.head()?.summary).toBe('Принято в Workdesk')
  expect(f.fake.calls('get_codex_review').at(-1)?.params.arguments).toEqual({ task_id: 1, source: 'miniapp' })
  const before = f.fake.calls().length
  await f.tick()
  expect(f.fake.calls().length).toBe(before)
})

test('a refused post is passed by, not retried forever', async () => {
  const f = setup({ messages: [], deny: 'post_board_thread_message' })
  await f.tick()
  f.post((c, h) => postEntry(c, h, { text: 'one' }))
  await f.tick()
  await f.tick()
  expect(f.fake.calls('post_board_thread_message').length).toBe(1)
})

test('chatText and cardOf', () => {
  const base = { id: 'e', thread: 't', n: 2, seq: 2, at: 1, type: 'note' as const, text: 'hi' }
  expect(chatText({ ...base, author: { kind: 'owner' } })).toBeNull()
  expect(chatText({ ...base, author: EXECUTOR, private: true })).toBeNull()
  expect(chatText({ ...base, author: EXECUTOR, text: '', set: { summary: 'итог' } })).toBe('итог')
  expect(
    chatText({
      ...base,
      author: EXECUTOR,
      files: [{ name: 'report.md', size: 1, ref: 'x' }],
      links: [{ url: 'http://a' }],
    }),
  ).toBe('hi\n📎 report.md\nhttp://a')
  expect(cardOf('https://h/workdesk/#tasks/-257')).toEqual({ task_id: 257, source: 'miniapp' })
  expect(cardOf('https://h/workdesk/#tasks/26')).toEqual({ task_id: 26, source: 'workdesk' })
  expect(cardOf('https://h/workdesk/#tasks/BOARD-9')).toBeNull()
})

test('a task handed to another executor keeps its thread: the feed speaks as the new one', async () => {
  const f = setup()
  await f.tick()
  f.fake.write({
    tasks: [{ ...live(), executor: 'Board-feed' }],
    feed: { messages: [{ id: 3, kind: 'message', text: 'Привет' }] },
  })
  f.post((c, h) => postEntry(c, h, { text: 'после передачи' }))
  await f.tick()
  const executorOf = (name: string) =>
    f.fake.calls(name).map(c => (c.params.arguments as { executor?: string }).executor)
  expect(executorOf('post_board_thread_message')).toEqual(['Board-feed'])
  expect(executorOf('read_owner_messages').at(-1)).toBe('Board-feed')
  expect(
    f
      .entries()
      .filter(e => e.type === 'answer')
      .map(e => e.text),
  ).toEqual(['Привет'])
})
