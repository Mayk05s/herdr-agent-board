import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sandbox, until } from '../support/sandbox.ts'

const OLD = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
const UNRELATED = '01a15a8a-bd97-7701-a7f7-401e4bec3150'
const CURRENT = '01a15a8a-bd97-7701-a7f7-401e4bec3149'
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-20T08:00:00Z', type, payload })
const message = (role: string, text: string) => ({ type: 'message', role, content: [{ type: 'input_text', text }] })

// The child uses the sandbox's fake Herdr and isolated card store. Exercise the actual route handlers
// directly, so the fixture also runs where test processes cannot listen on a socket.
async function fixture() {
  const { defaultDeps } = await import('../../src/services/deps.ts')
  const { normalizeConfig } = await import('../../src/core/categories.ts')
  const { collect } = await import('../../src/services/board.ts')
  const { messageGate } = await import('../../src/core/message-gate.ts')
  const { sessionRoutes } = await import('../../src/server/routes/session.ts')
  const deps = defaultDeps(normalizeConfig({ language: 'en', wake: { on: false } }))
  const { createCodexHome } = await import('../../src/adapters/codex-home.ts')
  const { codexOpenFiles, codexProcessRollouts } = await import('../../src/adapters/codex-process.ts')
  let clock = 0
  let lsof = 0
  const pendingProbes = new Set<Promise<string[]>>()
  const flush = async () => {
    await Promise.all(pendingProbes)
  }
  deps.codex = createCodexHome(
    process.env.CODEX_HOME,
    pane => {
      const probe = codexProcessRollouts(pane, pid => {
        lsof++
        return codexOpenFiles(pid)
      }).finally(() => pendingProbes.delete(probe))
      pendingProbes.add(probe)
      return probe
    },
    () => clock,
  )
  const pane = (terminal_id: string, reported = OLD) => ({
    pane_id: 'c1',
    agent: 'codex',
    agent_status: 'idle',
    terminal_id,
    cwd: process.env.HOME,
    agent_session: { value: reported },
  })
  const processInfo = (pane_id: string, pid: string | undefined, tty: string | undefined) => ({
    result: {
      process_info: { pane_id, shell_pid: 1, tty, foreground_processes: [{ pid: Number(pid), argv: ['codex'] }] },
    },
  })
  const configure = (
    terminal: string,
    freshTerminal: string,
    reported = OLD,
    writer: 'one' | 'many' | 'none' = 'one',
  ) =>
    writeFileSync(
      process.env.FAKE_HERDR_STATE ?? '',
      JSON.stringify({
        'api snapshot': {
          result: {
            snapshot: {
              panes: [
                pane(terminal, reported),
                { ...pane('term-negative', '01a15a8a-bd97-7701-a7f7-401e4bec3151'), pane_id: 'negative' },
                { ...pane('term-claude', 'claude-sid'), pane_id: 'claude', agent: 'claude' },
                { ...pane('term-pi', '/synthetic/path with spaces Кириллица 100%.jsonl'), pane_id: 'pi', agent: 'pi' },
              ],
              tabs: [],
              workspaces: [],
            },
          },
        },
        'agent get c1': { result: { agent: pane(freshTerminal, reported) } },
        'pane process-info --pane c1': processInfo(
          'c1',
          writer === 'many' ? process.env.TEST_MULTI_WRITER : process.env.TEST_WRITER,
          writer === 'none'
            ? '/dev/ttys-mismatch'
            : writer === 'many'
              ? process.env.TEST_MULTI_TTY
              : process.env.TEST_TTY,
        ),
        'pane process-info --pane negative': processInfo('negative', process.env.TEST_WRITER, '/dev/ttys-mismatch'),
        'agent prompt c1': { result: {} },
      }),
    )
  configure('term-1', 'term-1')
  const { writeCard } = await import('../../src/adapters/cards.ts')
  writeCard(OLD, { name: 'Synthetic card', category: 'board' })
  writeCard(UNRELATED, { name: 'Unrelated card', category: 'personal' })
  writeCard(CURRENT, { name: 'Verified card', category: 'work', doing: 'Synthetic work' })
  const callCounts = () => {
    const calls = readFileSync(process.env.FAKE_HERDR_LOG ?? '', 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(row => JSON.parse(row) as string[])
    return ['c1', 'negative', 'claude', 'pi']
      .map(pane => calls.filter(a => a[1] === 'process-info' && a[3] === pane).length)
      .concat(lsof)
  }
  const timings: { counts: number[]; ms: number; list: (string | null | undefined)[][] }[] = []
  let items: Awaited<ReturnType<typeof collect>> = []
  for (let i = 0; i < 4; i++) {
    const before = callCounts()
    const started = performance.now()
    items = await collect(deps)
    const ms = performance.now() - started
    await flush()
    if (i === 0 && !items.some(item => item.codexThread === CURRENT)) items = await collect(deps)
    timings.push({
      counts: callCounts().map((n, index) => n - (before[index] ?? 0)),
      ms,
      list: items.map(item => [item.pane, item.key, item.codexThread ?? null]),
    })
    clock += 2000
  }
  const routes = sessionRoutes({
    deps,
    items: () => items,
    find: key => items.find(i => i.key === key),
    refresh() {},
    gate: messageGate(),
    answering: new Set(),
  })
  async function request(action?: string, body = {}, key = OLD) {
    const method = action ? 'POST' : 'GET'
    const url = new URL(`http://localhost/api/session/${encodeURIComponent(key)}${action ? `/${action}` : ''}`)
    const route = routes.find(r => r.method === method && r.path instanceof RegExp && r.path.test(url.pathname))
    const response = await route?.handle(new Request(url, { method }), {
      params: [key, action],
      rawBody: async () => body,
      body: async () => body,
    } as Parameters<NonNullable<typeof route>['handle']>[1])
    if (!(response instanceof Response)) throw new Error('No response')
    return { status: response.status, data: await response.json() }
  }
  const detail = await request()
  const body = {
    session: OLD,
    codexThread: CURRENT,
    codexTerminal: 'term-1',
    requestId: 'synthetic-id',
    text: 'Synthetic next turn',
  }
  const sent = await request('message', body)
  configure('term-1', 'term-2')
  const replay = await request('message', body)
  const replacedSend = await request('message', { ...body, requestId: 'synthetic-next-id' })
  items = await collect(deps)
  const replaced = await request()
  configure('term-3', 'term-3', UNRELATED)
  items = await collect(deps, { freshCodexPane: 'c1' })
  const unrelated = await request(undefined, {}, CURRENT)
  const touchedWrong = await request(undefined, {}, UNRELATED)
  configure('term-4', 'term-4', UNRELATED, 'none')
  items = await collect(deps, { freshCodexPane: 'c1' })
  const beforeAmbiguousDetail = await request(undefined, {}, UNRELATED)
  configure('term-4', 'term-4', UNRELATED, 'many')
  items = await collect(deps, { freshCodexPane: 'c1' })
  const ambiguous = await request(undefined, {}, UNRELATED)
  const ambiguousSend = await request(
    'message',
    {
      ...body,
      session: UNRELATED,
      codexThread: UNRELATED,
      codexTerminal: 'term-4',
      requestId: 'ambiguous-id',
    },
    UNRELATED,
  )
  const beforeAmbiguous = callCounts()
  items = await collect(deps)
  const ambiguousCounts = callCounts().map((n, index) => n - (beforeAmbiguous[index] ?? 0))
  const hiddenCandidate = await request(undefined, {}, CURRENT)
  // Several successful but slow sequential reads can cost more than the 2-second list interval.
  // A slow probe in a newly observed terminal must not keep the other cards off the list.
  let ready = false
  configure('slow-term', 'slow-term')
  deps.codex = createCodexHome(process.env.CODEX_HOME, async pane => {
    if (pane.pane_id !== 'c1') return []
    await Bun.sleep(2250)
    const paths = await codexProcessRollouts(pane)
    ready = true
    return paths
  })
  const started = performance.now()
  const cold = await collect(deps)
  const slowMs = performance.now() - started
  const coldReady = ready
  await until(() => ready)
  items = await collect(deps)
  const recovered = await request()
  const slowList = cold.map(item => [item.pane, item.key])

  console.log(
    JSON.stringify({
      detail,
      sent,
      replay,
      replacedSend,
      replaced,
      timings,
      unrelated,
      touchedWrong,
      ambiguous,
      ambiguousCounts,
      beforeAmbiguousDetail,
      ambiguousSend,
      hiddenCandidate,
      slowMs,
      slowList,
      coldReady,
      recovered,
    }),
  )
}

if (import.meta.main && process.env.TEST_WRITER) await fixture()
else
  test.skipIf(process.platform !== 'darwin')(
    'Codex uses the current rollout once, preserves the card and old history, and refuses a reused terminal',
    async () => {
      const box = await sandbox()
      const home = join(box.dir, 'Codex дом 100%')
      const dir = join(home, 'sessions', '2026', '10', '20')
      mkdirSync(dir, { recursive: true })
      const old = join(dir, `rollout-2026-10-20T08-00-00-${OLD}.jsonl`)
      writeFileSync(
        join(dir, `rollout-2026-10-20T08-00-00-${UNRELATED}.jsonl`),
        [
          row('session_meta', { id: UNRELATED, originator: 'codex-tui', source: 'cli', cwd: home }),
          row('response_item', message('user', 'Reported history')),
        ].join('\n'),
      )
      const next = join(dir, `rollout-2026-10-20T08-00-00-${CURRENT}.jsonl`)
      writeFileSync(
        old,
        [
          row('session_meta', { id: OLD, originator: 'codex-tui', source: 'cli', cwd: box.dir }),
          row('response_item', message('user', 'Earlier prompt')),
        ].join('\n'),
      )
      writeFileSync(
        next,
        [
          row('session_meta', { id: CURRENT, forked_from_id: OLD, originator: 'codex-tui', source: 'cli', cwd: home }),
          row('response_item', message('user', 'Synthetic question')),
          row('event_msg', { type: 'user_message', message: 'Synthetic question' }),
          row('response_item', message('assistant', 'Synthetic answer')),
          row('event_msg', { type: 'agent_message', message: 'Synthetic answer' }),
        ].join('\n'),
      )
      // Ordinary processes with a PTY and open writers, independent of Codex accounts and hooks.
      const code = [
        'import os, pty, sys',
        'master, slave = pty.openpty()',
        'os.dup2(slave, 0)',
        'files = [open(path, "a") for path in sys.argv[2:]]',
        'with open(sys.argv[1], "w") as info: print(os.ttyname(slave), file=info)',
        'os.read(master, 1)',
      ].join('\n')
      const spawnWriter = (name: string, ...files: string[]) => {
        const tty = join(box.dir, name)
        return {
          tty,
          proc: Bun.spawn(['/usr/bin/python3', '-u', '-c', code, tty, ...files], { stderr: 'pipe' }),
        }
      }
      const writer = spawnWriter('tty', next)
      const multi = spawnWriter('multi-tty', old, next)
      const ready = (tty: string) => until(() => existsSync(tty) && !!readFileSync(tty, 'utf8').trim())
      try {
        await Promise.all([ready(writer.tty), ready(multi.tty)])
        const child = Bun.spawn([process.execPath, import.meta.path], {
          env: {
            ...box.env,
            CODEX_HOME: home,
            TEST_WRITER: String(writer.proc.pid),
            TEST_TTY: readFileSync(writer.tty, 'utf8').trim(),
            TEST_MULTI_WRITER: String(multi.proc.pid),
            TEST_MULTI_TTY: readFileSync(multi.tty, 'utf8').trim(),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(stderr).toBe('')
        expect(exit).toBe(0)
        const {
          detail,
          sent,
          replay,
          replacedSend,
          replaced,
          timings,
          unrelated,
          touchedWrong,
          ambiguous,
          ambiguousCounts,
          beforeAmbiguousDetail,
          ambiguousSend,
          hiddenCandidate,
          slowMs,
          slowList,
          coldReady,
          recovered,
        } = JSON.parse(stdout)
        if (process.env.BOARD_HISTORY_TEST_TIMING) console.log(JSON.stringify({ timings, slowMs }))
        expect(timings.map((r: { counts: number[] }) => r.counts)).toEqual([
          [2, 1, 0, 0, 2],
          [0, 0, 0, 0, 0],
          [2, 1, 0, 0, 2],
          [0, 0, 0, 0, 0],
        ])
        for (const step of timings) {
          expect(step.list).toHaveLength(4)
          expect(step.list).toContainEqual(['c1', OLD, CURRENT])
          expect(step.list).toContainEqual(['claude', 'claude-sid', null])
          expect(step.list).toContainEqual(['pi', '/synthetic/path with spaces Кириллица 100%.jsonl', null])
        }
        expect(unrelated.data.item).toMatchObject({
          key: CURRENT,
          name: 'Verified card',
          category: 'work',
          doing: 'Synthetic work',
        })
        expect(unrelated.data).not.toHaveProperty('history')
        expect(touchedWrong.status).toBe(404)
        expect(ambiguous.data.item).toEqual({ ...beforeAmbiguousDetail.data.item, codexUnresolved: true })
        expect(ambiguous.data.item).toMatchObject({
          key: UNRELATED,
          session: UNRELATED,
          name: 'Unrelated card',
          category: 'personal',
        })
        expect(ambiguous.data.codexThread).toBeNull()
        expect(ambiguous.data.conversation).toEqual(beforeAmbiguousDetail.data.conversation)
        expect(ambiguous.data.conversation).toMatchObject([{ role: 'user', text: 'Reported history' }])
        expect(ambiguousSend.status).toBe(409)
        expect(ambiguousCounts).toEqual([0, 0, 0, 0, 0])
        expect(hiddenCandidate.status).toBe(404)
        expect(slowMs).toBeLessThan(1000)
        expect(coldReady).toBe(false)
        expect(slowList).toContainEqual(['c1', OLD])
        expect(slowList).toContainEqual(['claude', 'claude-sid'])
        expect(recovered.data.codexThread).toBe(CURRENT)
        expect(detail.data.item).toMatchObject({
          key: OLD,
          session: OLD,
          name: 'Synthetic card',
          category: 'board',
          codexThread: CURRENT,
        })
        expect(detail.data.codexThread).toBe(CURRENT)
        expect(detail.data.conversation.map((t: { text: string }) => t.text)).toEqual([
          'Synthetic question',
          'Synthetic answer',
        ])
        expect(detail.data.history).toMatchObject({
          session: OLD,
          conversation: [{ role: 'user', text: 'Earlier prompt' }],
        })
        expect(sent.status).toBe(200)
        expect(replay).toEqual(sent)
        expect(replacedSend.status).toBe(409)
        expect(replaced.data.conversation.map((t: { text: string }) => t.text)).toEqual(['Earlier prompt'])
        expect(box.calls().filter(a => a[0] === 'agent' && a[1] === 'prompt')).toEqual([
          ['agent', 'prompt', 'c1', 'Synthetic next turn'],
        ])
      } finally {
        writer.proc.kill()
        multi.proc.kill()
        await Promise.all([writer.proc.exited, multi.proc.exited])
      }
    },
    20_000,
  )
