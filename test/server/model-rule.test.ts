// The model rule on the web board's server (#429): with config.json's `models`, a session on
// another model family than expected gets `modelWrong` on its item and one herdr notification per
// start; `/model` back or the card's "This model is fine here" clears it. Without the key, items and
// herdr calls are as before.
import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Item } from '../../src/core/types.ts'
import { serveBoard } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox } from '../support/sandbox.ts'

const KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
const T0 = Date.now() - 60_000

/** A sandbox with the sessions running since `T0` in herdr panes, each on the model given. */
async function boardBox(models: Record<string, string | [string, number]>): Promise<Sandbox> {
  const box = await sandbox()
  const claude = join(box.dir, 'home', '.claude')
  mkdirSync(join(claude, 'sessions'), { recursive: true })
  writeFileSync(join(claude, 'settings.json'), '{}')
  const names: Record<string, string> = { s5: 'monitor' }
  for (const [i, s] of KEYS.entries()) registry(box, s, T0, names[s] ?? `Agent ${s}`, i)
  for (const [s, m] of Object.entries(models)) said(box, s, ...(Array.isArray(m) ? m : ([m, Date.now()] as const)))
  const panes = KEYS.map((s, i) => ({
    pane_id: `p${i + 1}`,
    agent: 'claude',
    agent_session: { value: s },
    agent_status: 'idle',
    cwd: box.dir,
  }))
  box.state({
    'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } },
    'notification show': { result: null },
  })
  mkdirSync(box.cards, { recursive: true })
  return box
}

/** Claude's registry entry of a running session (its process started at `startedAt`). */
function registry(box: Sandbox, s: string, startedAt: number, name: string, n = KEYS.indexOf(s)): void {
  const file = join(box.dir, 'home', '.claude', 'sessions', `${n + 1}.json`)
  writeFileSync(file, JSON.stringify({ sessionId: s, kind: 'interactive', pid: process.pid, name, startedAt }))
}

/**
 * What the status line last wrote for a session, at `at`: its model alone, as before its first
 * reply (no tokens, no time of its own), so the file's time says when.
 */
function said(box: Sandbox, s: string, model: string, at = Date.now()): void {
  const dir = join(box.cards, '..', 'context')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${s}.json`)
  writeFileSync(file, JSON.stringify({ model }))
  utimesSync(file, at / 1000, at / 1000)
}

/** Lines of a session's transcript, with no status line file: an assistant line on `model` at `at`, then the user's. */
function wrote(box: Sandbox, s: string, model: string, at: number, userAt?: number): void {
  const dir = join(box.dir, 'home', '.claude', 'projects', box.dir.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const line = (o: unknown) => appendFileSync(join(dir, `${s}.jsonl`), `${JSON.stringify(o)}\n`)
  const timestamp = (t: number) => new Date(t).toISOString()
  line({ type: 'assistant', timestamp: timestamp(at), message: { model, content: [{ type: 'text', text: 'Done.' }] } })
  if (userAt) line({ type: 'user', timestamp: timestamp(userAt), message: { content: 'go on' } })
}

const card = (box: Sandbox, s: string, fields: Record<string, unknown>) =>
  writeFileSync(join(box.cards, `${s}.json`), JSON.stringify({ key: s, ...fields }))

const notified = (box: Sandbox): string[][] => box.calls().filter(c => c[0] === 'notification' && c[1] === 'show')

/** The board's items after a refresh that started now. */
async function itemsOf(url: string, proc: Child): Promise<Map<string, Item>> {
  const after = Date.now()
  for (let i = 0; i < 200; i++) {
    proc.send('refresh')
    await Bun.sleep(50)
    const b = (await (await fetch(`${url}/api/board`)).json()) as {
      items: Item[]
      lastSuccessfulRefreshAt: number | null
    }
    if (b.items.length === KEYS.length && (b.lastSuccessfulRefreshAt ?? 0) > after)
      return new Map(b.items.map(i => [i.key, i]))
  }
  throw new Error('the board did not refresh')
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out: ${what}`)
}

const SONNET = 'claude-sonnet-5-5'
const MODELS = {
  expect: 'opus',
  sessions: { monitor: 'sonnet' },
  lanes: { ops: 'sonnet' },
}
const CATEGORIES = [
  { id: 'other', title: 'Other', color: 'gray' },
  { id: 'ops', title: 'Ops', color: 'teal' },
]

test('the rule on: a tag and one notification for a session on another family; the allowed ones none', async () => {
  const box = await boardBox({
    s1: 'claude-opus-5-5[1m]',
    s2: SONNET,
    s3: SONNET, // its start asked for sonnet
    s4: SONNET, // in the ops lane
    s5: SONNET, // the monitor
    s6: [SONNET, T0 - 5000], // read before this start: the model it had before a restart
    s7: SONNET,
  })
  card(box, 's3', { modelWant: 'sonnet' })
  card(box, 's4', { category: 'ops' })
  // s8 has no status line file: its transcript's model is from before this start, though the user
  // wrote since.
  wrote(box, 's8', SONNET, T0 - 5000, Date.now())
  const { url, proc } = await serveBoard(box, { language: 'en', categories: CATEGORIES, models: MODELS })
  let items = await itemsOf(url, proc)
  expect(Object.fromEntries(KEYS.map(k => [k, items.get(k)?.modelWrong ?? null]))).toEqual({
    s1: null,
    s2: { runs: SONNET, want: 'opus' },
    s3: null,
    s4: null,
    s5: null,
    s6: null,
    s7: { runs: SONNET, want: 'opus' },
    s8: null,
  })
  await waitFor(() => notified(box).length >= 2, 'two notifications')
  expect(
    notified(box)
      .map(c => [c[2], c[4]])
      .sort(),
  ).toEqual([
    ['Wrong model: Agent s2', 'Agent s2 runs on claude-sonnet-5-5, expected Opus'],
    ['Wrong model: Agent s7', 'Agent s7 runs on claude-sonnet-5-5, expected Opus'],
  ])

  // Later turns: no notification again.
  said(box, 's2', SONNET)
  await itemsOf(url, proc)
  await itemsOf(url, proc)
  expect(notified(box)).toHaveLength(2)

  // /model opus: the status line says opus, the tag goes.
  said(box, 's2', 'claude-opus-5-5')
  // The card's "This model is fine here": the family it runs now.
  const allow = async (on: boolean) => {
    const r = await fetch(`${url}/api/session/s7/card`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify({ modelOk: on }),
    })
    expect(await r.json()).toEqual({ ok: true })
  }
  await allow(true)
  items = await itemsOf(url, proc)
  expect(items.get('s2')).not.toHaveProperty('modelWrong')
  expect(items.get('s7')).not.toHaveProperty('modelWrong')
  // Taken back (`modelOk: false`): the tag again; allowed again: gone.
  await allow(false)
  items = await itemsOf(url, proc)
  expect(items.get('s7')?.modelWrong).toEqual({ runs: SONNET, want: 'opus' })
  await allow(true)
  items = await itemsOf(url, proc)
  expect(items.get('s7')).not.toHaveProperty('modelWrong')
  // Allowed for sonnet only: on haiku it warns again, in the same start without a notification.
  said(box, 's7', 'claude-haiku-4-5')
  items = await itemsOf(url, proc)
  expect(items.get('s7')?.modelWrong).toEqual({ runs: 'claude-haiku-4-5', want: 'opus' })

  // A restart that brings s2 back on sonnet: a new start, so one notification more.
  const now = Date.now()
  registry(box, 's2', now - 1000, 'Agent s2')
  said(box, 's2', SONNET, now)
  items = await itemsOf(url, proc)
  expect(items.get('s2')?.modelWrong).toEqual({ runs: SONNET, want: 'opus' })
  await waitFor(() => notified(box).length >= 3, 'a notification for the new start')
  await itemsOf(url, proc)
  expect(notified(box)).toHaveLength(3)

  // s8 answers on sonnet in this start: its transcript says so, and that is judged.
  wrote(box, 's8', SONNET, Date.now())
  items = await itemsOf(url, proc)
  expect(items.get('s8')?.modelWrong).toEqual({ runs: SONNET, want: 'opus' })
  await waitFor(() => notified(box).length >= 4, 'a notification for s8')
}, 30_000)

test('no models key: no item has modelWrong and no notification goes, whatever the models', async () => {
  const box = await boardBox({ s1: 'claude-opus-5-5', s2: SONNET, s7: 'claude-haiku-4-5' })
  card(box, 's7', { modelOk: 'sonnet' })
  const { url, proc } = await serveBoard(box, { language: 'en', categories: CATEGORIES })
  const items = await itemsOf(url, proc)
  await itemsOf(url, proc)
  expect([...items.values()].filter(i => 'modelWrong' in i)).toEqual([])
  expect(notified(box)).toEqual([])
  expect(items.get('s2')?.model).toBe(SONNET)
}, 30_000)
