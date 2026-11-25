// Settings' feature switches (#596): editFeatures (watches, decisions and their defaults, the away
// journal) and editThreads' case files and verified done into config.json under its lock, each
// section's other fields and every other key kept, shapes written by hand read right; off keeps a
// section's own fields under "on": false and the readers take that as off; POST /api/feature-settings
// on the computer only; the payload's new fields there only while each is on; and a running board
// following each switch in its payload.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile, editFeatures, editThreads } from '../../src/adapters/config-file.ts'
import { decisionsConfig } from '../../src/core/decisions.ts'
import { journalConfig } from '../../src/core/journal.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { watchesConfig } from '../../src/core/watches.ts'
import { threadsConfig, verifyConfig, verifyKeptOff } from '../../src/core/work-threads.ts'
import { dispatch } from '../../src/server/http.ts'
import { featureSettingsRoute } from '../../src/server/routes/settings.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { threadsPayload } from '../../src/services/work-threads.ts'
import { serveBoard } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { sandbox } from '../support/sandbox.ts'

const STATE = { port: 12422, token: '', stale: () => false }
const config = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
function writeConfig(raw: Record<string, unknown>): void {
  mkdirSync(join(configFile(), '..'), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(raw))
}
function fresh(raw: Record<string, unknown>): void {
  isolatedHome()
  // biome-ignore lint/correctness/useHookAtTopLevel: a language setter, not a React hook
  useLanguage('en')
  writeConfig(raw)
}

async function until(fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

test('watches and the journal: on is true, off takes the key out; every other key as it was', () => {
  const others = { language: 'en', todos: true, threads: { agents: false }, team: { hub: 'h', name: 'anna' } }
  fresh(others)
  expect(editFeatures({ watches: true })).toEqual({ ok: true })
  expect(config().watches).toBe(true)
  expect(editFeatures({ journal: true })).toEqual({ ok: true })
  expect(config().journal).toBe(true)
  expect(editFeatures({ watches: false, journal: false })).toEqual({ ok: true })
  expect(config()).toEqual(others)
})

test("the journal's returnMinutes stays: off is { returnMinutes, on: false }, read as off; on brings it back", () => {
  fresh({ journal: { returnMinutes: 30 } })
  expect(journalConfig(config().journal)).toEqual({ returnMinutes: 30 })
  expect(editFeatures({ journal: false }).ok).toBe(true)
  expect(config().journal).toEqual({ returnMinutes: 30, on: false })
  expect(journalConfig(config().journal)).toBeNull()
  expect(editFeatures({ journal: true }).ok).toBe(true)
  expect(config().journal).toEqual({ returnMinutes: 30 })
  expect(journalConfig(config().journal)).toEqual({ returnMinutes: 30 })
})

test('decisions: on and off, and defaults allowed or not, the section kept; defaults refused while off', () => {
  fresh({ language: 'en' })
  expect(editFeatures({ decisions: true }).ok).toBe(true)
  expect(config().decisions).toBe(true)
  expect(editFeatures({ decisionsDefaults: false }).ok).toBe(true)
  expect(config().decisions).toEqual({ defaults: false })
  expect(decisionsConfig(config().decisions)).toEqual({ defaults: false })
  // Off keeps "no defaults" aside; on brings it back.
  expect(editFeatures({ decisions: false }).ok).toBe(true)
  expect(config().decisions).toEqual({ defaults: false, on: false })
  expect(decisionsConfig(config().decisions)).toBeNull()
  // While off: defaults refused in words, the file as it was.
  const before = readFileSync(configFile(), 'utf8')
  expect(editFeatures({ decisionsDefaults: true })).toEqual({
    ok: false,
    error: 'Decisions are off (config.json: "decisions")',
  })
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
  expect(editFeatures({ decisions: true }).ok).toBe(true)
  expect(config().decisions).toEqual({ defaults: false })
  expect(editFeatures({ decisionsDefaults: true }).ok).toBe(true)
  expect(config().decisions).toBe(true)
  // Both in one: decisions on, then no defaults.
  writeConfig({})
  expect(editFeatures({ decisions: true, decisionsDefaults: false }).ok).toBe(true)
  expect(config().decisions).toEqual({ defaults: false })
  // A hand-written section's other fields stay through both switches.
  writeConfig({ decisions: { defaults: true, future: 1 } })
  expect(editFeatures({ decisionsDefaults: false }).ok).toBe(true)
  expect(config().decisions).toEqual({ defaults: false, future: 1 })
  expect(editFeatures({ decisions: false }).ok).toBe(true)
  expect(config().decisions).toEqual({ defaults: false, future: 1, on: false })
})

test('a switch already in the state asked changes nothing, and touches no other section', () => {
  const hand = {
    watches: { note: 'mine' },
    decisions: true,
    journal: { returnMinutes: 45 },
    threads: { verify: true, cases: true, events: { gapSec: 5 } },
  }
  fresh(hand)
  expect(editFeatures({ watches: true, decisions: true, journal: true }).ok).toBe(true)
  expect(config()).toEqual(hand)
  // Turning one off leaves the others exactly as written.
  expect(editFeatures({ decisions: false }).ok).toBe(true)
  const { decisions: _gone, ...rest } = hand
  expect(config()).toEqual(rest)
  // A watches section of fields of its own keeps them while off.
  expect(editFeatures({ watches: false }).ok).toBe(true)
  expect(config().watches).toEqual({ note: 'mine', on: false })
  expect(watchesConfig(config().watches)).toBeNull()
  expect(config().threads).toEqual(hand.threads)
})

test('a switch already in the state asked leaves the value exactly as written: {}, false, a value that reads as off', () => {
  fresh({ watches: {}, journal: false, decisions: 'yes' })
  expect(editFeatures({ watches: true, journal: false, decisions: false }).ok).toBe(true)
  expect(config()).toEqual({ watches: {}, journal: false, decisions: 'yes' })
  writeConfig({ decisions: {} })
  expect(editFeatures({ decisionsDefaults: true }).ok).toBe(true)
  expect(config().decisions).toEqual({})
})

test('anything that is not a switch: refused in words, nothing written', () => {
  fresh({ language: 'en', watches: true })
  const before = readFileSync(configFile(), 'utf8')
  for (const body of [
    {},
    null,
    'x',
    { watches: 'yes' },
    { journal: 1 },
    { watches: true, decisions: 'no' },
    { other: true },
  ])
    expect(editFeatures(body)).toEqual({ ok: false, error: 'Not a setting of watches, decisions or the away journal' })
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
})

test('the readers: "on": false is off; every shape without it reads as before', () => {
  expect(watchesConfig(true)).toEqual({ on: true })
  expect(watchesConfig({})).toEqual({ on: true })
  expect(watchesConfig({ on: true })).toEqual({ on: true })
  expect(watchesConfig({ on: false })).toBeNull()
  expect(watchesConfig(false)).toBeNull()
  expect(decisionsConfig({ defaults: false })).toEqual({ defaults: false })
  expect(decisionsConfig({ on: false })).toBeNull()
  expect(journalConfig({})).toEqual({ returnMinutes: 15 })
  expect(journalConfig({ on: false, returnMinutes: 30 })).toBeNull()
  expect(verifyConfig(true)).toMatchObject({ model: null, lanes: [] })
  expect(verifyConfig({ model: 'opus', on: false })).toBeNull()
  expect(threadsConfig({ verify: { model: 'opus', on: false } })?.verify).toBeNull()
  expect(threadsConfig({ verify: { model: 'opus' } })?.verify).toMatchObject({ model: 'opus' })
})

test('case files: on and off under threads, agents, share and the rest kept; refused while threads are off', () => {
  fresh({ threads: { agents: false, share: false, events: { gapSec: 30 } } })
  expect(editThreads({ cases: true })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ agents: false, share: false, events: { gapSec: 30 }, cases: true })
  expect(editThreads({ cases: false })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ agents: false, share: false, events: { gapSec: 30 } })
  // "threads": true becomes an object for it, and back.
  writeConfig({ threads: true })
  expect(editThreads({ cases: true }).ok).toBe(true)
  expect(config().threads).toEqual({ cases: true })
  expect(editThreads({ cases: false }).ok).toBe(true)
  expect(config().threads).toBe(true)
  // Off: refused, the file as it was.
  writeConfig({ language: 'en' })
  const before = readFileSync(configFile(), 'utf8')
  for (const body of [{ cases: true }, { verify: true }, { verify: false }])
    expect(editThreads(body)).toEqual({ ok: false, error: 'Threads are off (config.json: "threads")' })
  for (const body of [{ cases: 'yes' }, { verify: 1 }])
    expect(editThreads(body)).toEqual({ ok: false, error: 'Not a threads setting' })
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
})

test('verified done: off keeps model, lanes and brief under "on": false; on brings them back; on with none set is true', () => {
  const verify = { model: 'opus', lanes: ['atlas'], brief: { atlas: 'checks/atlas.md', '*': 'checks/all.md' }, max: 1 }
  fresh({ threads: { agents: false, cases: true, verify } })
  expect(threadsConfig(config().threads)?.verify).toMatchObject({ model: 'opus', lanes: ['atlas'], max: 1 })
  expect(editThreads({ verify: false }).ok).toBe(true)
  expect(config().threads).toEqual({ agents: false, cases: true, verify: { ...verify, on: false } })
  expect(threadsConfig(config().threads)?.verify).toBeNull()
  // A switch of something else while verify is off keeps its settings aside as they are.
  expect(editThreads({ cases: false }).ok).toBe(true)
  expect(editThreads({ mode: 'agents' }).ok).toBe(true)
  expect(config().threads).toEqual({ verify: { ...verify, on: false } })
  expect(editThreads({ verify: true }).ok).toBe(true)
  expect(config().threads).toEqual({ verify })
  expect(threadsConfig(config().threads)?.verify).toMatchObject({ model: 'opus', lanes: ['atlas'], max: 1 })
  // "verify": true written by hand: off takes it out (nothing to keep), on with nothing set is true.
  writeConfig({ threads: { verify: true } })
  expect(editThreads({ cases: true }).ok).toBe(true)
  expect(config().threads).toEqual({ verify: true, cases: true })
  expect(editThreads({ verify: false }).ok).toBe(true)
  expect(config().threads).toEqual({ cases: true })
  expect(editThreads({ verify: true }).ok).toBe(true)
  expect(config().threads).toEqual({ cases: true, verify: true })
  expect(threadsConfig(config().threads)?.verify).toMatchObject({ model: null, lanes: [], brief: null })
})

test('threads off and on again keeps agents, share: false, cases and verify\'s fields (#597); every reader takes "on": false as off', () => {
  const section = { agents: false, share: false, cases: true, verify: { model: 'opus', lanes: ['atlas'] } }
  fresh({ threads: section })
  expect(editThreads({ mode: 'none' })).toEqual({ ok: true, on: false })
  expect(config().threads).toEqual({ ...section, on: false })
  expect(threadsConfig(config().threads)).toBeNull()
  expect(threadsPayload({ threads: config().threads })).toBeNull()
  expect(verifyKeptOff(config().threads)).toBe(true)
  // Off: sharing, case files and verify are refused, the file as it was.
  const before = readFileSync(configFile(), 'utf8')
  for (const body of [{ share: true }, { cases: false }, { verify: true }])
    expect(editThreads(body)).toEqual({ ok: false, error: 'Threads are off (config.json: "threads")' })
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
  // Off again changes nothing.
  expect(editThreads({ mode: 'none' }).ok).toBe(true)
  expect(config().threads).toEqual({ ...section, on: false })
  // On, with either mode: the section back, still kept off the hub.
  expect(editThreads({ mode: 'agents' })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ share: false, cases: true, verify: section.verify })
  expect(threadsConfig(config().threads)).toMatchObject({ agents: true, share: false, cases: true })
  expect(threadsConfig(config().threads)?.verify).toMatchObject({ model: 'opus', lanes: ['atlas'] })
  expect(editThreads({ mode: 'none' }).ok).toBe(true)
  expect(editThreads({ mode: 'mine' }).ok).toBe(true)
  expect(config().threads).toEqual({ share: false, cases: true, verify: section.verify, agents: false })
})

test("the payload's threads line: cases and verify only while on; every other shape as before", () => {
  isolatedHome()
  expect(JSON.stringify(threadsPayload({ threads: true }))).toBe('{"rev":0,"needsOwner":0}')
  expect(JSON.stringify(threadsPayload({ threads: { events: { gapSec: 5 } } }))).toBe('{"rev":0,"needsOwner":0}')
  expect(JSON.stringify(threadsPayload({ threads: { verify: { model: 'x', on: false } } }))).toBe(
    '{"rev":0,"needsOwner":0}',
  )
  expect(threadsPayload({ threads: { cases: true, verify: true } })).toEqual({
    rev: 0,
    needsOwner: 0,
    cases: true,
    verify: true,
  })
  expect(threadsPayload({ threads: { agents: false, verify: { model: 'opus' } } })).toEqual({
    rev: 0,
    needsOwner: 0,
    agents: false,
    verify: true,
  })
})

test('the route stays on the computer: every remote listener refuses it, the owner’s own login too; X-Board needed', async () => {
  for (const owner of [false, true])
    expect(
      remoteRefusal('/api/feature-settings', '/api/feature-settings', { desk: false, teamOwner: owner, owner })?.status,
    ).toBe(403)
  fresh({ language: 'en' })
  const post = async (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) => {
    const url = new URL('http://127.0.0.1:12422/api/feature-settings')
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const res = await dispatch([featureSettingsRoute()], req, url, url.pathname, STATE)
    return { status: res.status, body: await res.json() }
  }
  expect((await post({ watches: true }, {})).status).toBe(403)
  expect('watches' in config()).toBe(false)
  expect(await post({ watches: true })).toEqual({ status: 200, body: { ok: true } })
  expect(config().watches).toBe(true)
  expect((await post({ watches: 'on' })).status).toBe(400)
})

test('a running board: each switch from Settings shows in its payload at once, and goes again; untouched, the payload has none of it', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const wake = await fakeWake()
  try {
    const cfg = { language: 'en', wakeUrl: wake.url, threads: true }
    const file = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg))
    const { url, proc } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
    const board = async (): Promise<Record<string, unknown>> => {
      proc.send('refresh')
      await Bun.sleep(50)
      return (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    }
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
      })
    // Nothing switched: none of the new fields, the threads line as main sends it.
    const untouched = await board()
    for (const key of ['watches', 'decisions', 'journal']) expect(key in untouched).toBe(false)
    expect(untouched.threads).toEqual({ rev: 0, needsOwner: 0 })

    expect((await post('/api/feature-settings', { watches: true, decisions: true, journal: true })).status).toBe(200)
    await until(async () => {
      const b = await board()
      return b.watches === true && !!b.decisions && !!b.journal
    })
    expect(((await board()).decisions as { defaults: boolean }).defaults).toBe(true)
    expect((await post('/api/feature-settings', { decisionsDefaults: false })).status).toBe(200)
    await until(async () => ((await board()).decisions as { defaults: boolean } | undefined)?.defaults === false)

    expect((await post('/api/threads-settings', { cases: true, verify: true })).status).toBe(200)
    await until(
      async () => JSON.stringify((await board()).threads) === '{"rev":0,"needsOwner":0,"cases":true,"verify":true}',
    )

    expect((await post('/api/feature-settings', { watches: false, decisions: false, journal: false })).status).toBe(200)
    expect((await post('/api/threads-settings', { cases: false, verify: false })).status).toBe(200)
    await until(async () => {
      const b = await board()
      return (
        !('watches' in b) &&
        !('decisions' in b) &&
        !('journal' in b) &&
        JSON.stringify(b.threads) === '{"rev":0,"needsOwner":0}'
      )
    })
    // config.json as it began (the profiles the board found on start aside), but for "no defaults"
    // kept aside while decisions are off.
    const { profiles: _found, ...after } = JSON.parse(readFileSync(file, 'utf8'))
    expect(after).toEqual({ ...cfg, decisions: { defaults: false, on: false } })
  } finally {
    wake.down()
  }
}, 30_000)
