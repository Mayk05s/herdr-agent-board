// The board command's side of decisions (#487): `board ask` with options while config.json turns
// them on, its refusals, `board decisions`, `board thread ask`'s flags, and with the key absent
// `board ask` and `board thread ask` exactly as on main.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addWatch, listWatches } from '../../src/adapters/schedule-store.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

/** `fn` with this process pointed at the sandbox's config and state folders. */
function inBox<T>(box: Sandbox, fn: () => T): T {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

setDefaultTimeout(30_000)

const SID = '11111111-2222-3333-4444-555555555555'
const S = ['--session', SID]

function config(box: Sandbox, extra: Record<string, unknown> = {}): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}
/** The board command as session `self` runs it (SID's own, unless another is named). */
function cli(box: Sandbox, args: string[], self = SID): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const env = { ...box.env, CLAUDE_CODE_SESSION_ID: self }
    const proc = spawn(process.execPath, [join(root, 'src/entrypoints/cli.ts'), ...args], { cwd: root, env })
    let out = ''
    proc.stdout.on('data', c => {
      out += c
    })
    proc.stderr.on('data', c => {
      out += c
    })
    proc.on('close', code => resolve({ code, out: out.trim() }))
  })
}
const cardOf = (box: Sandbox): Record<string, unknown> =>
  existsSync(join(box.cards, `${SID}.json`)) ? JSON.parse(readFileSync(join(box.cards, `${SID}.json`), 'utf8')) : {}
const scheduled = (box: Sandbox): Record<string, unknown>[] => {
  const dir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(n => /^[0-9a-f]{6}\.json$/.test(n))
    .map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>)
}

test('decisions absent: board ask takes every word as the question, as on main, and says so where the flags were given (#596)', async () => {
  const box = await sandbox()
  config(box)
  const r = await cli(box, ['ask', 'Merge now?', '--option', 'yes', '--option', 'no', ...S])
  assert.equal(r.code, 0, r.out)
  assert.equal(
    r.out,
    'ok · category: not set · asks the user: Merge now? --option yes --option no · note: decisions are off in config.json, so --option is part of the question and no default will answer it',
  )
  assert.equal(cardOf(box).ask, 'Merge now? --option yes --option no')
  assert.equal(cardOf(box).decision, undefined)
  const plain = await cli(box, ['ask', 'which branch?', ...S])
  assert.equal(plain.out, 'ok · category: not set · asks the user: which branch?')
  // Decisions switched off by Settings ("on": false): the same, every flag named.
  config(box, { decisions: { defaults: false, on: false } })
  const all = await cli(box, [
    'ask',
    'Q',
    '--option',
    'a',
    '--option',
    'b',
    '--recommend',
    '1',
    '--default-after',
    '2h',
    ...S,
  ])
  assert.equal(
    all.out,
    'ok · category: not set · asks the user: Q --option a --option b --recommend 1 --default-after 2h · note: decisions are off in config.json, so --option, --recommend, --default-after are part of the question and no default will answer it',
  )
  assert.deepEqual(scheduled(box), [])
  assert.equal((await cli(box, ['decisions', ...S])).code, 1)
})

test('decisions on: options, a recommendation and a default; the line says the decision and when it goes', async () => {
  const box = await sandbox()
  config(box, { decisions: true })
  const r = await cli(box, [
    'ask',
    'Merge now?',
    '--option',
    'Merge now',
    '--option',
    'Wait',
    '--recommend',
    '1',
    '--default-after',
    '2h',
    ...S,
  ])
  assert.equal(r.code, 0, r.out)
  const id = /decision ([0-9a-f]{8})/.exec(r.out)?.[1]
  assert.ok(id, r.out)
  assert.equal(r.out, `ok · category: not set · asks the user: Merge now? · decision ${id} · default in 2 h`)
  const card = cardOf(box)
  assert.equal(card.ask, 'Merge now?')
  assert.deepEqual((card.decision as Record<string, unknown>).options, ['Merge now', 'Wait'])
  const [entry] = scheduled(box)
  assert.equal(entry?.decision, id)
  assert.equal(entry?.text, 'no answer in 2 h: go with your recommendation "Merge now"')

  const list = await cli(box, ['decisions'])
  assert.equal(list.code, 0, list.out)
  assert.match(
    list.out,
    /Merge now\? · 1\. Merge now \(recommended\) \/ 2\. Wait · asked just now · default in (2 h|1 h 59 min)/,
  )
  const json = JSON.parse((await cli(box, ['decisions', '--json'])).out) as { items: { id: string }[] }
  assert.deepEqual(
    json.items.map(d => d.id),
    [id],
  )

  // board done: withdrawn with its ask, the default taken back.
  assert.equal((await cli(box, ['done', 'merged', ...S])).code, 0)
  assert.deepEqual(scheduled(box), [])
  const done = await cli(box, ['decisions', '--done'])
  assert.match(done.out, new RegExp(`^${id} · .* · Merge now\\? · - · withdrawn \\(cleared\\)`))
  assert.equal((await cli(box, ['decisions'])).out, 'nothing waits on the owner')
})

test('decisions on: a refusal is one line and writes nothing; defaults off refuse --default-after', async () => {
  const box = await sandbox()
  config(box, { decisions: true })
  const one = await cli(box, ['ask', 'q', '--option', 'only', ...S])
  assert.equal(one.code, 1)
  assert.match(one.out, /give 2 to 4 options, not 1/)
  const noRec = await cli(box, ['ask', 'q', '--option', 'a', '--option', 'b', '--default-after', '1h', ...S])
  assert.equal(noRec.code, 1)
  assert.match(noRec.out, /--default-after needs --recommend/)
  assert.equal(cardOf(box).ask, undefined)

  const off = await sandbox()
  config(off, { decisions: { defaults: false } })
  const r = await cli(off, [
    'ask',
    'q',
    '--option',
    'a',
    '--option',
    'b',
    '--recommend',
    '1',
    '--default-after',
    '1h',
    ...S,
  ])
  assert.equal(r.code, 1)
  assert.match(r.out, /defaults are off on this board: ask without --default-after/)
  const ok = await cli(off, ['ask', 'q', '--option', 'a', '--option', 'b', '--recommend', '1', ...S])
  assert.equal(ok.code, 0, ok.out)
  assert.deepEqual(scheduled(off), [])
})

test('board thread ask: the flags with decisions on; with them absent refused as on main', async () => {
  const box = await sandbox()
  config(box, { threads: true })
  const made = await cli(box, ['thread', 'new', '--lane', 'atlas', 'Release', ...S])
  assert.equal(made.code, 0, made.out)
  const key = /atlas-\d+/.exec(made.out)?.[0] as string
  const off = await cli(box, ['thread', 'ask', key, 'Ship it?', '--option', 'yes', '--option', 'no', ...S])
  assert.equal(off.code, 1)
  assert.match(off.out, /board thread ask does not take --option/)
  // A flag with no value: main's line, not decisions' "needs a value".
  const bare = await cli(box, ['thread', 'ask', key, 'Ship it?', '--option', ...S])
  assert.equal(bare.code, 1)
  assert.match(bare.out, /board thread ask does not take --option \(put -- before text that starts with --\)/)
  assert.doesNotMatch(bare.out, /needs a value/)

  config(box, { threads: true, decisions: true })
  const on = await cli(box, [
    'thread',
    'ask',
    key,
    'Ship it?',
    '--option',
    'yes',
    '--option',
    'no',
    '--recommend',
    '2',
    ...S,
  ])
  assert.equal(on.code, 0, on.out)
  assert.match(on.out, /decision [0-9a-f]{8}/)
  const card = cardOf(box)
  assert.equal(card.ask, 'Ship it?')
  // The thread, and the question's own entry: an old button is never the answer to a later question.
  const th = (card.decision as { thread: { id: string; key: string; ask: string } }).thread
  assert.equal(th.key, key)
  assert.match(th.id, /^[0-9a-f-]{36}$/)
  assert.match(th.ask, /^[0-9a-f-]{36}$/)
})

test('with watches on too (#486): board doing and board done end the watch and withdraw the decision, both', async () => {
  for (const cmd of ['doing', 'done'] as const) {
    const box = await sandbox()
    config(box, { decisions: true, watches: true })
    // The session waits on CI with a watch (as board wait --probe leaves it; its probe is never run here).
    const watch = inBox(box, () =>
      addWatch({
        key: SID,
        name: 'anna',
        text: 'CI on PR 12',
        next: Date.now() + 600_000,
        by: 'agent',
        probe: { cmd: 'gh pr checks 12', everyMs: 600_000, timeoutMs: 20_000 },
      }),
    ).watch.id
    const asked = await cli(box, [
      'ask',
      'Merge now?',
      '--option',
      'yes',
      '--option',
      'no',
      '--recommend',
      '1',
      '--default-after',
      '2h',
      ...S,
    ])
    assert.equal(asked.code, 0, asked.out)
    const id = /decision ([0-9a-f]{8})/.exec(asked.out)?.[1] as string
    assert.equal(scheduled(box).filter(e => e.decision === id).length, 1)
    const r = await cli(box, cmd === 'doing' ? ['doing', 'merging', ...S] : ['done', 'merged', ...S])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, new RegExp(`watch ${watch} ended`))
    assert.equal(cardOf(box).ask, undefined)
    assert.equal(cardOf(box).decision, undefined)
    assert.deepEqual(
      scheduled(box).filter(e => e.decision === id),
      [],
    )
    const done = await cli(box, ['decisions', '--done'])
    assert.match(done.out, new RegExp(`^${id} · .* · withdrawn \\(cleared\\)`))
    assert.deepEqual(
      inBox(box, () => listWatches()),
      [],
    )
  }
})

test('board ask --help names the flags', async () => {
  const box = await sandbox()
  config(box)
  const r = await cli(box, ['ask', '--help'])
  assert.match(
    r.out,
    /usage: board ask <question> \[--option "<label>"\]\.\.\. \[--recommend <n>\] \[--default-after <30m\|2h>\]/,
  )
})

test("--session for another session's card: options and a default refused in one line, nothing written; a plain ask goes", async () => {
  const box = await sandbox()
  config(box, { decisions: true })
  const BEN = '99999999-8888-7777-6666-555555555555'
  const withOptions = await cli(box, ['ask', 'Merge now?', '--option', 'yes', '--option', 'no', ...S], BEN)
  assert.equal(withOptions.code, 1)
  assert.match(withOptions.out, /--option and --default-after are for the session's own question/)
  assert.equal(withOptions.out.split('\n').length, 1)
  assert.deepEqual(cardOf(box), {})
  assert.deepEqual(scheduled(box), [])
  const plain = await cli(box, ['ask', 'which branch?', ...S], BEN)
  assert.equal(plain.code, 0, plain.out)
  assert.equal(cardOf(box).ask, 'which branch?')
  assert.deepEqual((cardOf(box).decision as { options: string[] }).options, [])
  assert.deepEqual(scheduled(box), [])
  // Its own card through --session: as without it.
  const own = await cli(box, ['ask', 'Merge now?', '--option', 'yes', '--option', 'no', ...S])
  assert.equal(own.code, 0, own.out)
})

test('board thread ask --session for another session: options and a default refused, nothing written in the thread', async () => {
  const box = await sandbox()
  config(box, { threads: true, decisions: true })
  const BEN = '99999999-8888-7777-6666-555555555555'
  const made = await cli(box, ['thread', 'new', '--lane', 'atlas', 'Release', ...S])
  const key = /atlas-\d+/.exec(made.out)?.[0] as string
  const r = await cli(box, ['thread', 'ask', key, 'Ship it?', '--option', 'yes', '--option', 'no', ...S], BEN)
  assert.equal(r.code, 1)
  assert.match(r.out, /--option and --default-after are for the session's own question/)
  assert.equal(cardOf(box).ask, undefined)
  const shown = await cli(box, ['thread', 'show', key, ...S])
  assert.doesNotMatch(shown.out, /Ship it\?/)
})
