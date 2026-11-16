// The calls to the web board's port that came with the team, the threads and the calendar (the
// board command's `team` and `thread`, a reminder's and a team message's click, who holds the port)
// on the board's own server: its port there takes nothing without the board's local key
// (server/app.ts), so each sends it, as the board command's older calls do (adapters/local-key.ts
// localFetch). On a PC each goes as it went: no key, even with one on file, and the same headers.
// The board here is a stand-in on a port of the test's own that answers as the board does, and
// 403 { error: 'key' } without the key when it is on its server.
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureLocalKey, LOCAL_KEY_HEADER, localFetch } from '../../src/adapters/local-key.ts'
import { ROOT } from '../../src/adapters/paths.ts'
import { reminderClick, teamClick } from '../../src/services/web-open.ts'
import { isolatedHome } from '../support/env.ts'
import { board, socketIn, writeConfig } from '../support/own-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(60_000)

const P = 'A'.repeat(43)
const THREAD = `${P}/general`
const SESSION = '11111111-1111-4111-8111-111111111111'
const KEY = 'k'.repeat(43)

type Asked = { method: string; path: string; key: string; xBoard: string; type: string }

/**
 * The web board on a port of the test's own: what it was asked (the key sent, '' for none), and
 * the answers the callers read. `key`: the board on its own server, which refuses a call without
 * it; null: on a PC, any call taken. `team: false`: a board that does not run the team.
 */
function boardStub(key: string | null) {
  const asked: Asked[] = []
  const stub = { team: true }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      const h = req.headers
      asked.push({
        method: req.method,
        path,
        key: h.get(LOCAL_KEY_HEADER) ?? '',
        xBoard: h.get('x-board') ?? '',
        type: h.get('content-type') ?? '',
      })
      if (key !== null && h.get(LOCAL_KEY_HEADER) !== key) return Response.json({ error: 'key' }, { status: 403 })
      if (path === '/api/team')
        return Response.json(
          stub.team
            ? {
                hub: 'ws://hub.example.com:7443',
                state: 'online',
                me: { name: 'me', fingerprint: 'ab12' },
                roster: [{ peer: P, name: 'anna', fingerprint: 'cd34', online: true }],
              }
            : {},
        )
      if (path === '/api/team/threads')
        return Response.json({ threads: [{ key: THREAD, scope: P, id: 'general', lastAt: Date.now() }], drafts: [] })
      if (path === '/api/team/unread') return Response.json({ threads: { [THREAD]: 2 } })
      if (path.startsWith('/api/threads/')) return Response.json({ out: 'sent' })
      if (path === '/api/hello') return Response.json({ board: 'agent-board', version: '9.9.9' })
      if (path === '/api/process') return Response.json({ board: 'agent-board', root: ROOT })
      return Response.json({ ok: true })
    },
  })
  return { port: Number(server.port), asked, stub, stop: () => void server.stop(true) }
}

const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')

/** The board's local key in the sandbox's state folder, as the board makes it. */
function keyOnFile(box: Sandbox): void {
  mkdirSync(stateOf(box), { recursive: true })
  writeFileSync(join(stateOf(box), 'local-key'), `${KEY}\n`, { mode: 0o600 })
}

/** A thread `atlas-1` in the sandbox's database, shared with anna: a session's entry in it goes out through the board. */
async function sharedThread(box: Sandbox): Promise<void> {
  const made = await board(box, ['--session', SESSION, 'thread', 'new', '--lane', 'atlas', 'Import mapping'])
  expect(made.stdout).toBe('ok · atlas-1 · next\n')
  const before = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    const { withThreadsDb } = await import('../../src/services/work-threads.ts')
    const { shareThread } = await import('../../src/services/work-share.ts')
    const { findThread } = await import('../../src/adapters/work-thread-store.ts')
    withThreadsDb(true, db => {
      if (!db) throw new Error('no db')
      const h = findThread(db, 'atlas-1', null)
      shareThread(
        { db, cfg: { agents: true, gapSec: 60, share: true }, actor: { kind: 'owner' }, now: Date.now(), me: '' },
        h,
        {
          kind: 'peer',
          peer: P,
          topic: `${P}/${h.id}`,
        },
      )
    })
  } finally {
    if (before === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = before
  }
}

/** Each `board` command that asks the web board's port, run as an agent runs it, and what it printed. */
async function runAll(box: Sandbox, stub: ReturnType<typeof boardStub>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const run = async (name: string, args: string[]) => {
    const r = await board(box, args)
    out[name] = `${r.code} ${r.stdout}${r.stderr}`
  }
  await run('roster', ['team', 'roster'])
  await run('draft', ['team', 'draft', 'anna', 'is it green?'])
  await run('inbox', ['team', 'inbox'])
  await run('drafts', ['team', 'drafts'])
  await run('listen', ['--session', SESSION, 'team', 'listen'])
  await sharedThread(box)
  await run('post', ['--session', SESSION, 'thread', 'post', 'atlas-1', 'on it', '--json'])
  stub.stub.team = false
  await run('down', ['team', 'roster'])
  stub.stub.team = true
  await run('doctor', ['doctor'])
  return out
}

/**
 * What the commands asked, in order, and whether the call says X-Board and its content type
 * (team-agents-cli.ts call() does on a GET too; the others on a POST only).
 */
const ASKED: [string, string, boolean][] = [
  ['GET', '/api/team', false], // roster
  ['GET', '/api/team', false], // draft
  ['POST', '/api/team/draft', true],
  ['GET', '/api/team', false], // inbox
  ['GET', '/api/team/threads', true],
  ['GET', '/api/team/unread', true],
  ['GET', '/api/team', false], // drafts
  ['GET', '/api/team/threads', true],
  ['GET', '/api/team', false], // listen
  ['POST', '/api/team/listen', true],
  ['POST', '/api/threads/<id>', true], // the shared thread's entry
  ['GET', '/api/team', false], // a board without the team: who holds the port
  ['GET', '/api/hello', false],
  ['GET', '/api/process', false],
  ['GET', '/api/hello', false], // doctor: who holds the port
  ['GET', '/api/process', false],
]

/** What the stand-in was asked, as ASKED says it, with the key each sent. */
function expectAsked(asked: Asked[], key: string): void {
  expect(
    asked.map(a => [
      a.method,
      a.path.startsWith('/api/threads/') ? '/api/threads/<id>' : a.path,
      a.xBoard,
      a.type,
      a.key,
    ]),
  ).toEqual(ASKED.map(([method, path, own]) => [method, path, own ? '1' : '', own ? 'application/json' : '', key]))
}

/** What each command printed, as the board answered it. */
function expectAnswered(out: Record<string, string>): void {
  expect(out.roster).toContain('● anna  cd34  online')
  expect(out.draft).toContain('ok · draft for anna is in the Team panel')
  expect(out.inbox).toContain('with anna · general · 2 unread')
  expect(out.drafts).toBe('0 no drafts wait for the owner\n')
  expect(out.listen).toBe(
    '0 ok · this session is the listener: it hears of new threads and of threads no session here handles\n',
  )
  expect(JSON.parse((out.post ?? '').slice(2))).toMatchObject({ ok: true, out: 'sent' })
  // the port's holder said who it is: this install's board, which does not run the team
  expect(out.down).toBe('1 board: the board does not run the team: restart it\n')
  expect(out.doctor).not.toContain('not an agent board')
}

describe("the board's own server: the key on every call", () => {
  test("board team roster | draft | inbox | drafts | listen, a shared thread's post, who holds the port, doctor", async () => {
    const box = await sandbox()
    keyOnFile(box)
    const stub = boardStub(KEY)
    try {
      writeConfig(box, {
        serverMode: { domain: 'board.example.com', socket: socketIn(box.dir) },
        port: stub.port,
        team: { hub: 'ws://hub.example.com:7443', name: 'me' },
        threads: true,
      })
      const out = await runAll(box, stub)
      expectAnswered(out)
      // the call's own headers kept, the key beside them
      expectAsked(stub.asked, KEY)
    } finally {
      stub.stop()
    }
  })

  test("a reminder's and a team message's click: the key, the board answers", async () => {
    isolatedHome()
    const key = ensureLocalKey()
    const stub = boardStub(key)
    const raised: string[] = []
    const window = { open: async () => {}, raise: async () => !!raised.push('raise'), launch: () => {} }
    try {
      const cfg = { port: stub.port, serverMode: { domain: 'board.example.com', socket: '/srv/board/board.sock' } }
      expect(await reminderClick('open', 'a'.repeat(16), cfg, { window })).toEqual({
        ok: true,
        url: `http://127.0.0.1:${stub.port}/`,
      })
      expect(await teamClick(THREAD, cfg, { window })).toEqual({ ok: true, url: `http://127.0.0.1:${stub.port}/` })
      expect(stub.asked.map(a => [a.method, a.path, a.key])).toEqual([
        ['POST', '/api/calendar-reminders', key],
        ['POST', '/api/team/focus', key],
      ])
      expect(raised).toEqual(['raise', 'raise'])
    } finally {
      stub.stop()
    }
  })

  test('who holds the port: the board says who it is with the key', async () => {
    isolatedHome()
    const key = ensureLocalKey()
    const stub = boardStub(key)
    try {
      const { serverSays } = await import('../../src/adapters/port-owner.ts')
      const cfg = { serverMode: { domain: 'board.example.com', socket: '/srv/board/board.sock' } }
      expect(await serverSays(stub.port, localFetch(cfg))).toEqual({ version: '9.9.9', root: ROOT })
      expect(stub.asked.map(a => a.key)).toEqual([key, key])
    } finally {
      stub.stop()
    }
  })
})

describe('a PC (no serverMode): the calls as they went', () => {
  test('no key, even with one on file; the same headers; the same answers', async () => {
    const box = await sandbox()
    keyOnFile(box)
    const stub = boardStub(null)
    try {
      writeConfig(box, { port: stub.port, team: { hub: 'ws://hub.example.com:7443', name: 'me' }, threads: true })
      const out = await runAll(box, stub)
      expectAnswered(out)
      expectAsked(stub.asked, '')
    } finally {
      stub.stop()
    }
  })

  test("a reminder's and a team message's click: fetch with what it was given, no key", async () => {
    isolatedHome()
    ensureLocalKey()
    const calls: { url: unknown; init: RequestInit | undefined }[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init })
      return Response.json({ ok: true })
    }) as typeof fetch
    const window = { open: async () => {}, raise: async () => true, launch: () => {} }
    try {
      for (const cfg of [{ port: 4242 }, { port: 4242, serverMode: null }]) {
        await reminderClick('snooze', 'a'.repeat(16), cfg, { window })
        await teamClick(THREAD, cfg, { window })
      }
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls.map(c => c.url)).toEqual([
      'http://127.0.0.1:4242/api/calendar-reminders',
      'http://127.0.0.1:4242/api/team/focus',
      'http://127.0.0.1:4242/api/calendar-reminders',
      'http://127.0.0.1:4242/api/team/focus',
    ])
    for (const c of calls) {
      // the headers as a plain object, as before: nothing added
      expect(c.init?.headers).toEqual({ 'content-type': 'application/json', 'x-board': '1' })
      expect(c.init?.method).toBe('POST')
    }
  })

  test('who holds the port: asked with fetch itself', async () => {
    isolatedHome()
    ensureLocalKey()
    const stub = boardStub(null)
    try {
      const { serverSays } = await import('../../src/adapters/port-owner.ts')
      expect(await serverSays(stub.port)).toEqual({ version: '9.9.9', root: ROOT })
      expect(await serverSays(stub.port, localFetch({}))).toEqual({ version: '9.9.9', root: ROOT })
      expect(stub.asked.map(a => a.key)).toEqual(['', '', '', ''])
    } finally {
      stub.stop()
    }
  })
})
