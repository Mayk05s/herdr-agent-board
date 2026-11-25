import { expect, test } from 'bun:test'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { mcp } from '../support/workdesk-fixture.ts'

test('the configured web board publishes a fresh empty topology using its actual collection', async () => {
  const box = await sandbox()
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  const fake = mcp(box.dir)
  fake.write({ tasks: [], topology: true })
  const { url } = await serveBoard(box, {
    threads: true,
    workdesk: { ...fake.config, intervalSec: 1, topology: { deviceId: 'mac' } },
  })
  const snapshots = () =>
    fake
      .calls('board_heartbeat')
      .map(call => call.params.arguments)
      .filter(arg => !!arg && typeof arg === 'object' && 'topology' in arg)
  await until(() => snapshots().length > 0, 5500)
  expect(snapshots()[0]).toEqual({
    topology: { version: 1, device_id: 'mac', observed_at: expect.any(Number), masters: [] },
  })
  const deadline = Date.now() + 2000
  let board: BoardPayload
  do {
    board = (await (await fetch(`${url}/api/board`)).json()) as BoardPayload
    if (typeof board.workdesk?.polledAt === 'number') break
    await Bun.sleep(25)
  } while (Date.now() < deadline)
  expect(board.workdesk).toMatchObject({ queue: 0, problem: null })
}, 15_000)
