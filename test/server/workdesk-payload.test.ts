import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'
import {
  asleepInFile,
  boardOnPath,
  herdrAsleep,
  paneCalls,
  projectDir,
  SID,
  stateDir,
  transcript,
  twoProfiles,
} from '../support/sleeper-fixtures.ts'
import { mcp, rows, task } from '../support/workdesk-fixture.ts'

test('server reports the queue and a scoped Workdesk assignment wakes its sleeping Claude master through the scheduler', async () => {
  const box = await sandbox()
  const cwd = projectDir(box)
  const { own, list } = twoProfiles(box)
  transcript(own, cwd)
  asleepInFile(box, { cwd, profileDir: own, profile: 'default' })
  herdrAsleep(box, cwd)
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, `${SID}.json`),
    JSON.stringify({ key: SID, name: 'Report', category: 'other', profileDir: own }),
  )
  const fake = mcp(box.dir)
  fake.write({ tasks: [task(21), task(22)] })
  const { url } = await serveBoard(
    box,
    {
      threads: true,
      profiles: list,
      wake: false,
      scheduleTickSec: 0.2,
      workdesk: { ...fake.config, intervalSec: 1, onlyTaskId: 21, masters: { Board: 'Report' } },
    },
    boardOnPath(box),
  )
  async function payload(): Promise<BoardPayload> {
    return (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
  }
  expect((await payload()).workdesk).toBeDefined()
  await until(
    () =>
      box.calls().some(call => call[0] === 'agent' && call[1] === 'prompt' && String(call[3]).includes('Test card 21')),
    18_000,
  )
  expect((await payload()).workdesk).toMatchObject({ queue: 0, polledAt: expect.any(Number), problem: null })
  expect(fake.calls('claim_task').map(call => call.params.arguments)).toEqual([{ task_id: 21, executor: 'Report' }])
  expect(rows(join(stateDir(box), 'board.db')).map(row => row.title)).toEqual(['Test card 21'])
  expect(paneCalls(box).filter(call => call[1] === 'run')).toHaveLength(1)
}, 20_000)

test('a running Codex master receives the Workdesk thread in its own pane', async () => {
  const box = await sandbox()
  const session = '018f5280-4ef2-42e8-9b0f-4517daaf0d36'
  const pane = {
    pane_id: 'codex-pane',
    cwd: box.dir,
    terminal_title_stripped: 'Board-codex-master',
    agent: 'codex',
    agent_status: 'idle',
    agent_session: { value: session },
  }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'agent get codex-pane': { result: { agent: pane } },
    'agent read codex-pane': { text: '› \n  gpt-6.2-sol · 100%' },
    'agent prompt codex-pane': { result: {} },
  })
  const fake = mcp(box.dir)
  fake.write({ tasks: [{ ...task(31), key: 'BOARD-1' }] })
  const { url } = await serveBoard(box, {
    threads: true,
    scheduleTickSec: 0.2,
    workdesk: { ...fake.config, intervalSec: 1 },
  })
  const payload = (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
  expect(payload.workdesk).toBeDefined()
  const prompts = () => box.calls().filter(call => call[0] === 'agent' && call[1] === 'prompt')
  await until(() => prompts().length > 0)
  const threads = rows(join(stateDir(box), 'board.db'))
  expect(threads).toHaveLength(1)
  const thread = threads[0]
  expect(JSON.parse(thread?.assignee ?? '')).toMatchObject({
    kind: 'session',
    key: session,
    name: 'Board-codex-master',
  })
  expect(prompts()).toEqual([
    [
      'agent',
      'prompt',
      'codex-pane',
      `[board reminder] BOARD-1 Test card 31. Открой поручение: board thread show ${thread?.key} --full`,
    ],
  ])
  expect(paneCalls(box).filter(call => call[1] === 'run')).toHaveLength(0)
}, 20_000)
