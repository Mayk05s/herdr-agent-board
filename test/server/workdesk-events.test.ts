import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { sandbox, until } from '../support/sandbox.ts'
import { mcp } from '../support/workdesk-fixture.ts'

test('server startup makes an immediate fallback when a configured stream cannot connect', async () => {
  const box = await sandbox()
  const fake = mcp(box.dir)
  fake.write({ tasks: [] })
  const tokenFile = join(box.dir, 'test-token')
  await Bun.write(tokenFile, 'test-only-token')
  const { url } = await serveBoard(box, {
    threads: true,
    workdesk: {
      ...fake.config,
      events: { url: 'https://127.0.0.1:1/workdesk/api/board/events', tokenFile },
    },
  })
  await until(() => fake.calls('list_board_tasks').length === 1)
  const cutoff = Date.now() + 2000
  let payload: BoardPayload
  do {
    payload = await (await fetch(`${url}/api/board`)).json()
    if (payload.workdesk?.queue === 0) break
    await Bun.sleep(10)
  } while (Date.now() < cutoff)
  expect(payload.workdesk).toMatchObject({ problem: null, queue: 0 })
  await until(() => fake.calls('board_heartbeat').length === 1)
})
