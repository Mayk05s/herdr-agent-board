// The away journal on the real server (#489): without config.json's `journal` the payload is as
// before and no file is made; with it, a pane's change between two refreshes is one move, the
// payload carries the strip's part and GET /api/journal the list.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type Child, type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateDir } from '../support/sleeper-fixtures.ts'

const sid = '1a8d7619-52ab-45bb-aa45-23e71df5a5cf'
const pane = (status: string, cwd: string) => ({
  pane_id: 'p1',
  agent: 'claude',
  agent_status: status,
  cwd,
  agent_session: { value: sid },
})
let cwd = ''
const snapshot = (status: string) => ({
  'api snapshot': { result: { snapshot: { panes: [pane(status, cwd)], tabs: [], workspaces: [] } } },
})

const board = async (url: string) => (await fetch(`${url}/api/board`)).json() as Promise<Record<string, unknown>>
/** Refreshes until the payload shows the pane in `status` (a refresh asked during one runs after it). */
async function showing(proc: Child, url: string, status: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000
  for (;;) {
    proc.send('refresh')
    const b = await board(url)
    const items = (b.items ?? []) as { status?: string }[]
    if (!b.stale && items.length === 1 && items[0]?.status === status) return b
    if (Date.now() > deadline) throw new Error(`no ${status} pane: ${JSON.stringify(items)}`)
    await Bun.sleep(50)
  }
}
const journalDb = (box: Sandbox) => join(stateDir(box), 'journal.db')

test('without the key: no journal in the payload, no route, no file after refreshes', async () => {
  const box = await sandbox()
  cwd = box.dir
  box.state(snapshot('working'))
  const { url, proc } = await serveBoard(box, {})
  await showing(proc, url, 'working')
  box.state(snapshot('done'))
  const payload = await showing(proc, url, 'done')
  expect('journal' in payload).toBe(false)
  expect((await fetch(`${url}/api/journal?since=0`)).status).toBe(404)
  expect(existsSync(journalDb(box))).toBe(false)
  proc.kill()
  await proc.exited
})

test('with the key: a change between refreshes is one move, in the list and the payload', async () => {
  const box = await sandbox()
  cwd = box.dir
  box.state(snapshot('working'))
  const { url, proc } = await serveBoard(box, { journal: true })
  expect((await showing(proc, url, 'working')).journal).toEqual({ strip: null, last: null })
  expect(existsSync(journalDb(box))).toBe(true)
  box.state(snapshot('done'))
  await showing(proc, url, 'done')
  const r = await fetch(`${url}/api/journal?since=0`)
  expect(r.status).toBe(200)
  const { journal } = (await r.json()) as { journal: { rows: { key: string; kind: string }[]; rest: unknown } }
  expect(journal.rows.map(x => x.kind)).toEqual(['done'])
  expect((await fetch(`${url}/api/journal?since=x`)).status).toBe(400)
  const dismiss = await fetch(`${url}/api/journal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'dismiss' }),
  })
  expect(await dismiss.json()).toEqual({ ok: true, dismissed: false })
  proc.kill()
  await proc.exited
})
