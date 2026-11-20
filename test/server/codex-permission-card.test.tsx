import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { sandbox } from '../support/sandbox.ts'

const SID = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
const SECOND = '01a15a8a-bd97-7701-a7f7-401e4bec3148'
const THIRD = '01a15a8a-bd97-7701-a7f7-401e4bec3149'
const WORKING = '01a15a8a-bd97-7701-a7f7-401e4bec3150'
const OTHER = '01a15a8a-bd97-7701-a7f7-401e4bec3151'
const NO_REASON = '01a15a8a-bd97-7701-a7f7-401e4bec3152'
const REASON = 'Check the staged changes before review, including'
const REASON_WRAPPED = 'the cache files with spaces.'
const COMMAND = 'git status --short -- "a b"'
const INLINE = 'node -e "synthetic script body; more script"'
const RAW_WRAPPER = '// @exec: {"yield_time_ms": 1000}'
const SECOND_REASON = 'Inspect the generated manifest.'
const FIRST = readFileSync(new URL('../support/screens/codex-permission-3.txt', import.meta.url), 'utf8')
  .replace('Allow running pwd outside the sandbox?', `${REASON}\n    ${REASON_WRAPPED}`)
  .replace('  $ pwd', `  $ ${COMMAND}`)
const COMMAND_FIELD = FIRST.replace(`  Reason: ${REASON}\n    ${REASON_WRAPPED}`, `  Reason: ${SECOND_REASON}`).replace(
  `  $ ${COMMAND}`,
  "  Command:\n    /bin/zsh -lc 'printf synthetic_script_body'",
)

async function fixture() {
  const { normalizeConfig } = await import('../../src/core/categories.ts')
  const { defaultDeps } = await import('../../src/services/deps.ts')
  const { createLaunches } = await import('../../src/services/launch/launches.ts')
  const { createBoardState } = await import('../../src/server/board-state.ts')
  const { sessionRoutes } = await import('../../src/server/routes/session.ts')
  const { dispatch } = await import('../../src/server/http.ts')
  const { messageGate } = await import('../../src/core/message-gate.ts')
  const dirs = join(process.env.CODEX_HOME ?? '', 'sessions', '2026', '10', '20')
  mkdirSync(dirs, { recursive: true })
  for (const sid of [SID, SECOND, THIRD, WORKING, OTHER, NO_REASON]) {
    writeFileSync(
      join(dirs, `rollout-2026-10-20T08-00-00-${sid}.jsonl`),
      JSON.stringify({
        type: 'response_item',
        payload:
          sid === OTHER
            ? {
                type: 'function_call',
                name: 'other_confirmation',
                call_id: 'synthetic',
                arguments: '{"command":"git diff"}',
              }
            : { type: 'custom_tool_call', name: 'exec', call_id: 'synthetic', input: RAW_WRAPPER },
      }),
    )
  }
  const pane = (pane_id: string, id: string, agent = 'codex', agent_status = 'blocked') => ({
    pane_id,
    agent,
    agent_status,
    cwd: process.env.HOME,
    agent_session: { value: id },
  })
  const configure = (seq: number) =>
    writeFileSync(
      process.env.FAKE_HERDR_STATE ?? '',
      JSON.stringify({
        'api snapshot': {
          result: {
            snapshot: {
              panes: [
                pane('p1', SID),
                pane('p2', SECOND),
                pane('p3', THIRD),
                pane('p4', WORKING, 'codex', 'working'),
                pane('p5', OTHER),
                pane('p6', NO_REASON),
                pane('claude', 'claude', 'claude'),
                pane('pi', '/synthetic/путь 100%.jsonl', 'pi'),
              ],
              workspaces: [],
              tabs: [],
            },
          },
        },
        'agent get p1': { result: { agent: { ...pane('p1', SID), terminal_id: 'term-1', state_change_seq: seq } } },
        'agent get p2': { result: { agent: { ...pane('p2', SECOND), terminal_id: 'term-2', state_change_seq: seq } } },
        'agent read p1': { text: FIRST },
        'agent read p2': { text: COMMAND_FIELD },
        'agent read p3': { text: `Reason: A line outside an approval\n${RAW_WRAPPER}` },
        'agent read p5': { text: 'A different confirmation' },
        'agent read p6': {
          text: FIRST.replace(`  Reason: ${REASON}\n    ${REASON_WRAPPED}\n`, '').replace(COMMAND, INLINE),
        },
      }),
    )
  const calls = () =>
    readFileSync(process.env.FAKE_HERDR_LOG ?? '', 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as string[])
  configure(7)
  const deps = defaultDeps(normalizeConfig({ language: 'en', wake: { on: false } }))
  const launches = createLaunches({ deps })
  const board = createBoardState({ deps, launches, version: () => 'synthetic', push() {} })
  await board.refresh()
  const boardReads = calls()
    .filter(a => a[1] === 'read')
    .map(a => a[2])
    .sort()
  const routes = sessionRoutes({
    deps,
    launches,
    find: board.find,
    items: board.items,
    refresh() {},
    gate: messageGate(),
    answering: new Set(),
  })
  const request = (
    key: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
    stale = false,
  ) => {
    const path = `/api/session/${key}${body ? '/permit' : ''}`
    const url = new URL(`http://localhost:12422${path}`)
    const req = new Request(url, body ? { method: 'POST', headers, body: JSON.stringify(body) } : undefined)
    return dispatch(routes, req, url, path, { port: 12422, token: 'synthetic', stale: () => stale })
  }
  const detail = await (await request(SID)).json()
  const readOnly = await (await request(SECOND)).json()
  const body = { session: SID, option: 1, fingerprint: detail.dialog.fingerprint }
  const missingHeader = await request(SID, body)
  const foreignOrigin = await request(SID, body, { 'X-Board': '1', Origin: 'http://foreign.example' })
  const stale = await request(SID, body, { 'X-Board': '1' }, true)
  configure(8)
  const changed = await request(SID, body, { 'X-Board': '1' })
  configure(7)
  const persistent = await request(SID, { ...body, option: 2 }, { 'X-Board': '1' })
  console.log(
    JSON.stringify({
      payload: JSON.parse(board.payload()),
      boardReads,
      dialog: detail.dialog,
      commandFieldDialog: readOnly.dialog,
      guards: [missingHeader.status, foreignOrigin.status, stale.status, changed.status, persistent.status],
      changed: await changed.json(),
      keys: calls().filter(a => a[1] === 'send-keys' || a[1] === 'prompt'),
    }),
  )
}

if (import.meta.main && process.env.SYNTHETIC_PERMISSION_CARD) await fixture()
else
  test('blocked Codex cards use the live approval preview while detail and decisions keep their guards', async () => {
    const box = await sandbox()
    const proc = Bun.spawn([process.execPath, import.meta.path], {
      env: { ...box.env, SYNTHETIC_PERMISSION_CARD: '1', CODEX_HOME: join(box.dir, 'codex') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    const result = JSON.parse(stdout)
    const { items } = result.payload as BoardPayload
    expect(result.boardReads).toEqual(['p1', 'p2', 'p3', 'p5', 'p6'])
    expect(items.find(i => i.key === WORKING)?.tool?.detail).toBe(RAW_WRAPPER)
    expect(items.find(i => i.key === SID)).toMatchObject({
      attention: 'decision',
      question: `${REASON} ${REASON_WRAPPED} · $ ${COMMAND}`,
    })
    expect(items.find(i => i.key === SECOND)).toMatchObject({
      attention: 'decision',
      question: `${SECOND_REASON} · $ /bin/zsh -lc …`,
    })
    expect(items.find(i => i.key === THIRD)).toMatchObject({
      attention: 'decision',
      question: 'needs a decision',
    })
    expect(items.find(i => i.key === OTHER)?.question).toMatch(/^Permission: .*git diff$/)
    expect(items.find(i => i.key === NO_REASON)?.question).toBe('needs a decision · $ node -e …')
    const { bothCards } = await import('../web/support/board-scene.tsx')
    const { react } = bothCards({ items }, SID)
    expect(react).toContain(`${REASON} ${REASON_WRAPPED} · $ git status --short -- "a b"`)
    expect(bothCards({ items }, NO_REASON).react).not.toContain('synthetic script body')
    expect(react).not.toContain('@exec')
    expect(result.dialog).toMatchObject({
      kind: 'permission',
      body: ['  Environment: local', `  Reason: ${REASON}`, `    ${REASON_WRAPPED}`, `  $ ${COMMAND}`],
      options: [
        { n: 1, label: 'Yes, proceed (y)' },
        { n: 3, label: 'No, cancel (esc)' },
      ],
    })
    expect(result.dialog.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(result.commandFieldDialog).toBeNull()
    expect(result.guards).toEqual([403, 403, 409, 409, 409])
    expect(result.changed.error).toMatch(/another dialog/)
    expect(result.keys).toEqual([])
  }, 15_000)
