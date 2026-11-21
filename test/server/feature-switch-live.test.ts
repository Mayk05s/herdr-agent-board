// Settings' switches take effect on a running board without a restart (#596): the scheduler's
// watches pass and its verified-done sweep read config.json's switch on every tick, so a watch set
// while watches are off is not probed until Settings turns them on, and a held done gets no
// verifier until verified done goes on, then one on the model kept while it was off. Against the
// fake herdr, config.json followed as the real board follows it (TEST_LIVE_CONFIG).
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BoardDb, openDb } from '../../src/adapters/db.ts'
import { addWatch, getWatch, listEntries } from '../../src/adapters/schedule-store.ts'
import { threadByKey } from '../../src/adapters/work-thread-store.ts'
import type { Party, ThreadHead } from '../../src/core/work-threads.ts'
import { threadCmd } from '../../src/entrypoints/thread-cli.ts'
import { serveBoard } from '../support/board-server.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

const MIN = 60_000
const RULE = '─'.repeat(40)
const SCREEN = ['● done', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')
const calls = (box: Sandbox) => box.calls().map(a => a.join(' '))
const configFile = (box: Sandbox) => join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')

function inBox<T>(box: Sandbox, fn: () => T): T {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    return fn()
  } finally {
    process.env.APPDATA = saved.APPDATA
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA
  }
}

async function until(fn: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const post = (url: string, path: string, body: Record<string, unknown>) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })

/** config.json as the test wrote it, then the board on it, following it as it changes. */
async function boardOn(box: Sandbox, cfg: Record<string, unknown>) {
  mkdirSync(join(configFile(box), '..'), { recursive: true })
  writeFileSync(configFile(box), JSON.stringify(cfg))
  return serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
}

test('watches: a watch set while they are off is not probed; Settings turns them on and it fires, no restart', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const pane = { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }
    box.state({
      'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
      'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: 's1' } } } },
      'agent read': { text: SCREEN },
      'agent prompt': { result: {} },
    })
    const cfg = { language: 'en', wakeUrl: wake.url, scheduleTickSec: 0.2 }
    const { url } = await boardOn(box, cfg)
    const watch = inBox(box, () =>
      addWatch({
        key: 's1',
        name: 'anna',
        pane: 'p1',
        cwd: box.dir,
        text: 'CI on PR 12',
        next: Date.now() - 1000,
        by: 'agent',
        probe: { cmd: 'exit 0', everyMs: 10 * MIN, timeoutMs: 20_000 },
      }),
    ).watch
    // Ten ticks and more with watches off: the watch as it was set, nothing typed.
    await Bun.sleep(2500)
    expect(inBox(box, () => getWatch(watch.id))).toMatchObject({ id: watch.id })
    expect(inBox(box, () => getWatch(watch.id))?.lastCheck).toBeUndefined()
    expect(calls(box).some(c => c.includes('board reminder from watch'))).toBe(false)

    // On: the next pass runs its probe (whatever the probe says on this computer, it was checked).
    expect((await post(url, '/api/feature-settings', { watches: true })).status).toBe(200)
    await until(() => {
      const now = inBox(box, () => getWatch(watch.id))
      return now === null || now.lastCheck !== undefined
    })
    await until(() => calls(box).some(c => c.includes('[board reminder from watch]')))
  } finally {
    wake.down()
  }
}, 40_000)

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const worker: Party = { kind: 'session', key: S, name: 'atlas-mapper' }

async function thread(box: Sandbox, args: string[]): Promise<string> {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    const out: string[] = []
    const code = await threadCmd(args, {
      cfg: { threads: { verify: { model: 'opus' } } },
      actor: worker,
      lane: 'atlas',
      findSession: async () => null,
      out: l => out.push(l),
      err: l => out.push(l),
    })
    assert.equal(code, 0, out.join('\n'))
    return out.join('\n')
  } finally {
    process.env.APPDATA = saved.APPDATA
    process.env.LOCALAPPDATA = saved.LOCALAPPDATA
  }
}

/** herdr with the worker idle in wP:p1 and a new tab wP:t9 whose Claude comes up idle; the worker's card. */
function verifierHerdr(box: Sandbox, dir: string): void {
  const pane = {
    pane_id: 'wP:p1',
    tab_id: 'wP:t1',
    workspace_id: 'wP',
    agent: 'claude',
    agent_session: { value: S },
    agent_status: 'idle',
    cwd: dir,
    terminal_title_stripped: 'atlas-mapper',
  }
  const fresh = {
    pane_id: 'wP:p9',
    tab_id: 'wP:t9',
    workspace_id: 'wP',
    agent: 'claude',
    agent_status: 'idle',
    cwd: dir,
  }
  const workspaces = [{ workspace_id: 'wP', label: 'Atlas' }]
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces } } },
    'pane list': { result: { panes: [pane] } },
    'pane get wP:p1': { result: { pane } },
    'pane get wP:p9': { seq: [{ result: { pane: { ...fresh, agent: null } } }, { result: { pane: fresh } }] },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: S } } } },
    'workspace list': { result: { workspaces } },
    'tab create': { result: { tab: { tab_id: 'wP:t9' }, root_pane: { pane_id: 'wP:p9', terminal_id: 'term-9' } } },
    'pane run': { result: null },
    'agent list': { result: { agents: [] } },
    'agent rename': { result: null },
    'agent prompt': { result: null },
    'pane read': { text: 'Session renamed to: verify-atlas-1' },
  })
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${S}.json`), JSON.stringify({ key: S, name: 'atlas-mapper', category: 'atlas' }))
}

const headOf = (box: Sandbox, key: string): ThreadHead =>
  inBox(box, () => {
    const db = openDb() as BoardDb
    try {
      return threadByKey(db, key) as ThreadHead
    } finally {
      db.close()
    }
  })

const verifyCfg = (wakeUrl: string, verify: Record<string, unknown>) => ({
  categories: [{ id: 'atlas', title: 'Atlas', color: 'blue' }],
  wakeUrl,
  scheduleTickSec: 0.2,
  language: 'en',
  launch: { claude: ['claude-tg'] },
  threads: { verify },
})

test('verified done: kept off at start, its held done goes to the owner; Settings turns it on and a new held done gets a verifier on the kept model', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const dir = join(box.dir, 'work')
    mkdirSync(dir, { recursive: true })
    verifierHerdr(box, dir)
    // The done held while verify was on; then Settings turned it off (its model kept) while the board was down.
    await thread(box, ['new', '--doing', '--verify', 'Map the price columns'])
    assert.equal(
      await thread(box, ['done', 'atlas-1', 'all rows mapped']),
      'ok · atlas-1 · doing · done held: a verifier checks it',
    )
    const { url } = await boardOn(box, verifyCfg(wake.url, { model: 'opus', on: false }))
    await until(() => headOf(box, 'atlas-1').status === 'owner')
    expect(headOf(box, 'atlas-1').waitingOn).toBe('verification was switched off')
    await Bun.sleep(2500)
    expect(calls(box).some(c => c.startsWith('pane run wP:p9'))).toBe(false)
    expect(calls(box).some(c => c.startsWith('tab create'))).toBe(false)

    expect((await post(url, '/api/threads-settings', { verify: true })).status).toBe(200)
    await Bun.sleep(500)
    await thread(box, ['new', '--doing', '--verify', 'Second'])
    await thread(box, ['done', 'atlas-2', 'done too'])
    await until(() => calls(box).some(c => c.startsWith('pane run wP:p9')))
    const run = calls(box).find(c => c.startsWith('pane run wP:p9')) ?? ''
    expect(run).toMatch(/^pane run wP:p9 claude-tg --model opus --session-id [0-9a-f-]{36}$/)
    expect(headOf(box, 'atlas-2').verify?.run?.key).toBeTruthy()
  } finally {
    wake.down()
  }
}, 40_000)

test('watches off on a running board: a watch set after it is not probed, and the payload shows it as not checked', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const pane = { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }
    box.state({
      'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
      'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: 's1' } } } },
      'agent read': { text: SCREEN },
      'agent prompt': { result: {} },
    })
    const { url, proc } = await boardOn(box, { language: 'en', wakeUrl: wake.url, scheduleTickSec: 0.2, watches: true })
    expect((await post(url, '/api/feature-settings', { watches: false })).status).toBe(200)
    await Bun.sleep(500)
    const watch = inBox(box, () =>
      addWatch({
        key: 's1',
        name: 'anna',
        pane: 'p1',
        cwd: box.dir,
        text: 'CI on PR 12',
        next: Date.now() - 1000,
        by: 'agent',
        probe: { cmd: 'exit 0', everyMs: 10 * MIN, timeoutMs: 20_000 },
      }),
    ).watch
    await Bun.sleep(2500)
    expect(inBox(box, () => getWatch(watch.id))?.lastCheck).toBeUndefined()
    expect(calls(box).some(c => c.includes('board reminder from watch'))).toBe(false)
    proc.send('refresh')
    await Bun.sleep(300)
    const board = (await (await fetch(`${url}/api/board`)).json()) as {
      schedules: Record<string, unknown>[]
      watches?: true
    }
    expect(board.watches).toBeUndefined()
    expect(board.schedules.find(e => e.id === watch.id)).toMatchObject({ kind: 'watch', off: true })
  } finally {
    wake.down()
  }
}, 40_000)

test('verified done off on a running board: the held done goes to the owner, its verifier ends as after a verdict, none starts after', async () => {
  const box = await sandbox()
  const wake = await fakeWake()
  try {
    const dir = join(box.dir, 'work')
    mkdirSync(dir, { recursive: true })
    verifierHerdr(box, dir)
    await thread(box, ['new', '--doing', '--verify', 'Map the price columns'])
    await thread(box, ['done', 'atlas-1', 'all rows mapped'])
    const { url } = await boardOn(box, verifyCfg(wake.url, { model: 'opus' }))
    await until(() => calls(box).some(c => c.startsWith('pane run wP:p9')))
    const run = headOf(box, 'atlas-1').verify?.run
    expect(run?.key).toBeTruthy()

    expect((await post(url, '/api/threads-settings', { verify: false })).status).toBe(200)
    await until(() => headOf(box, 'atlas-1').status === 'owner')
    const h = headOf(box, 'atlas-1')
    expect(h).toMatchObject({ status: 'owner', waitingOn: 'verification was switched off', proposed: null })
    expect(h.verify?.run).toBeNull()
    // Its limit went to the archive phase, as a verdict sends it.
    expect(inBox(box, () => listEntries()).find(e => e.kind === 'verify' && e.key === run?.key)).toMatchObject({
      archive: true,
    })
    // A done held after it (a session that still had the flag) gets no verifier.
    await thread(box, ['new', '--doing', '--verify', 'Second'])
    await thread(box, ['done', 'atlas-2', 'done too'])
    await Bun.sleep(2500)
    expect(calls(box).filter(c => c.startsWith('pane run')).length).toBe(1)
    expect(headOf(box, 'atlas-2').verify?.run ?? null).toBeNull()
  } finally {
    wake.down()
  }
}, 40_000)
