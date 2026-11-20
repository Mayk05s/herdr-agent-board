import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox } from '../support/sandbox.ts'
import { stateDir } from '../support/sleeper-fixtures.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

test('Workdesk dialog discovery is independent of W1 and publishes only safe waiting state', async () => {
  const box = await sandbox()
  const fake = mcp(box.dir)
  const assignment = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
  const privateText = 'synthetic owner dialogue: never visible'
  fake.write({
    tasks: [task(7)],
    dialog: {
      assignment,
      task: 7,
      revision: 1,
      delivered: 0,
      events: [
        {
          id: 3,
          board_task_id: 7,
          assignment_id: assignment,
          revision: 1,
          executor: null,
          board_status: 'queued',
          kind: 'message',
          created_at: 1,
          text: privateText,
        },
      ],
      messages: [],
    },
  })
  const { url } = await serveBoard(box, { threads: true, workdeskDialog: fake.config })
  const body = async () => (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
  expect((await body()).workdeskDialog).toBeDefined()
  let payload = await body()
  for (let i = 0; i < 100 && payload.workdeskDialog?.pending !== 1; i++) {
    await Bun.sleep(20)
    payload = await body()
  }
  expect(payload.workdeskDialog).toEqual({
    pending: 1,
    more: false,
    polledAt: expect.any(Number),
    problem: null,
    blocked: { awaiting_claim: 1 },
  })
  expect(JSON.stringify(payload)).not.toContain(privateText)
  expect(JSON.stringify(payload)).not.toContain(assignment)
  expect(payload.workdesk).toBeUndefined()
  expect(
    fake
      .calls()
      .filter(call => call.method === 'tools/call')
      .map(call => call.params.name),
  ).toEqual(['list_owner_events'])
  const forged = await fetch(`${url}/api/workdesk/owner-messages?session=forged-SID&task_id=7`, {
    headers: { 'X-Board-Session': 'forged-SID' },
  })
  expect(forged.status).toBe(404)
  expect(await forged.text()).not.toContain(privateText)
})

test('ordinary Web and CLI thread views only expose a generic update, even with a selected SID', async () => {
  const box = await sandbox()
  const sid = '018f5280-4ef2-42e8-9b0f-4517daaf0d36'
  const name = 'Board-codex-master'
  const pane = {
    pane_id: 'dialog-pane',
    cwd: box.dir,
    terminal_title_stripped: name,
    agent: 'codex',
    agent_status: 'idle',
    agent_session: { value: sid },
  }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'agent get dialog-pane': { result: { agent: pane } },
    'agent read dialog-pane': { text: '› \n  gpt-6.2-sol · 100%' },
  })
  const fake = mcp(box.dir)
  const assignment = 'a1f42fcb-9183-41d0-b577-030828bf5e88'
  const privateText = 'another synthetic body [board reminder]'
  fake.write({
    tasks: [{ ...task(7), assignment_id: assignment, revision: 1 }],
    dialog: {
      assignment,
      task: 7,
      revision: 1,
      executor: name,
      delivered: 0,
      events: [
        {
          id: 3,
          board_task_id: 7,
          assignment_id: assignment,
          revision: 1,
          executor: null,
          board_status: 'queued',
          kind: 'message',
          created_at: 1,
        },
      ],
      messages: [
        { id: 3, revision: 1, kind: 'message', text: privateText, question_id: null, option_id: null, created_at: 1 },
      ],
    },
  })
  const { url } = await serveBoard(box, {
    threads: true,
    workdesk: fake.config,
    workdeskDialog: { ...fake.config, intervalSec: 1 },
  })
  const readStatus = async () => ((await (await fetch(`${url}/api/board`)).json()) as BoardPayload).workdeskDialog
  let status = await readStatus()
  for (let i = 0; i < 250 && status?.blocked.protected_delivery_unavailable !== 1; i++) {
    await Bun.sleep(10)
    status = await readStatus()
  }
  expect(status?.blocked).toEqual({ protected_delivery_unavailable: 1 })
  const thread = rows(join(stateDir(box), 'board.db'))[0]
  if (!thread) throw new Error('missing synthetic W1 thread')
  const web = await fetch(`${url}/api/threads/${thread.key}?full=1&session=${sid}`)
  expect(web.status).toBe(200)
  const config = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'config.json'), JSON.stringify({ threads: true }))
  const cli = await box.run('cli', { args: ['--session', sid, 'thread', 'show', thread.key, '--full'], env: {} }).exited
  expect(cli.code).toBe(0)
  for (const output of [await web.text(), cli.stdout]) {
    expect(output).toContain('обновление диалога')
    expect(output).not.toContain(privateText)
  }
  expect(fake.calls('read_owner_messages')).toEqual([])
  expect(fake.calls('ack_owner_messages')).toEqual([])
})
