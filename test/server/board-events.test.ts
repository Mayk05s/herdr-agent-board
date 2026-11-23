import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { logged, serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { stateDir } from '../support/sleeper-fixtures.ts'

const coordinator = '1a8d7619-52ab-45bb-aa45-23e71df5a5cc'
const replacement = '1a8d7619-52ab-45bb-aa45-23e71df5a5cd'
const worker = '1a8d7619-52ab-45bb-aa45-23e71df5a5ce'
const native = (pane: string, terminal: string, sid: string, status = 'idle') => ({
  pane_id: pane,
  terminal_id: terminal,
  terminal_title_stripped: pane,
  agent: 'codex',
  agent_status: status,
  agent_session: { value: sid, kind: 'id', agent: 'codex', source: 'herdr:codex' },
})
const workerPane = native('w1:p1', 'term-worker', worker, 'blocked')
const original = native('w1:p2', 'term-coordinator', coordinator)
const moved = native('w1:p3', 'term-moved', coordinator)
const snapshot = (...panes: ReturnType<typeof native>[]) => ({
  result: { snapshot: { panes, tabs: [], workspaces: [] } },
})

test.each([
  { change: 'SID', latest: [native('w1:p2', 'term-coordinator', replacement), moved], calls: [] },
  { change: 'terminal', latest: [native('w1:p2', 'term-new', coordinator)], calls: [] },
  { change: 'uncertain send', latest: [original], calls: [original.pane_id] },
])(
  'wake after $change stays in the feed and is never replayed into another pane',
  async ({ latest, calls }) => {
    const box = await sandbox()
    const cfg = { boardEvents: { coordinatorSid: coordinator } }
    box.state({
      'api snapshot': {
        ...snapshot(workerPane, original),
        until: ['agent get'],
        // biome-ignore lint/suspicious/noThenProperty: the fake Herdr uses this key to swap its response after a CLI call
        then: snapshot(workerPane, ...latest),
      },
      'agent get w1:p2': { result: { agent: original } },
      // Codex's empty composer: a scheduled message at a Codex session looks for a draft first (#428).
      'agent read': {
        text: '  To get started, describe a task\n\n\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[0m\n \x1b[2m? for shortcuts\x1b[0m',
      },
      'agent prompt': { error: 'synthetic lost prompt result' },
    })
    const first = await serveBoard(box, cfg)
    const promptTargets = () =>
      box
        .calls()
        .filter(argv => argv[0] === 'agent' && argv[1] === 'prompt')
        .map(argv => argv[2])
    const ambiguous = 'Board coordinator event delivery unconfirmed'
    await until(() => logged(first.proc, ambiguous))
    expect(promptTargets()).toEqual([...calls])
    first.proc.kill()
    await first.proc.exited

    // Advance only the fixture's local clock gate, so the test would catch an incorrect retry
    // immediately after the server restarts. Leave the actual persisted wake cursor intact.
    const db = new Database(join(stateDir(box), 'board-events.db'))
    try {
      db.query("UPDATE board_event_state SET value = '0' WHERE key = 'wake_at'").run()
    } finally {
      db.close()
    }
    box.state({
      'api snapshot': snapshot(workerPane, moved),
      'agent get w1:p3': { result: { agent: moved } },
      'agent prompt': { result: {} },
    })
    const next = await serveBoard(box, cfg)
    next.proc.send('refresh')
    await until(() => next.proc.messages.some(m => m && typeof m === 'object' && 'refreshed' in m))
    const abort = new AbortController()
    try {
      const stream = await fetch(`${next.url}/api/board-events?since=0`, {
        headers: { 'x-board': '1' },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2500)]),
      })
      if (!stream.body) throw new Error('feed unavailable')
      const reader = stream.body.getReader()
      const decode = new TextDecoder()
      let feed = ''
      while (!feed.includes('event: session.dialog')) {
        const chunk = await reader.read()
        if (chunk.done) break
        feed += decode.decode(chunk.value, { stream: true })
      }
      expect(feed).toContain('event: session.dialog')
    } finally {
      abort.abort()
    }
    expect(promptTargets()).toEqual([...calls])
  },
  10_000,
)
