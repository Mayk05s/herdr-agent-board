// The board's own server's state (GET /api/system, server/routes/system.ts, services/system-state.ts)
// for the head's chip and Settings → Server…: on the board's own server only, through its domain's
// login as Settings → Backup… is (core/remote.ts ownServerSettings), in either spelling; a phone, a
// desk, an allowed Tailscale user and a PC's tunnel are refused it as they are Backup…. A board on a
// PC has no such route at all: its own page answers the path as any unknown one, and its tunnel
// refuses it before any route, as it refuses Backup….
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { sharedSandbox } from '../support/board-server.ts'
import { startOwnServer, viaSocket } from '../support/own-server.ts'
import type { Child, Sandbox } from '../support/sandbox.ts'
import { routeTable, seedAccess, startTunnelBoard, stateFolder, viaCaddy } from '../support/tunnel-board.ts'

const TOKEN = 'f'.repeat(43)
const COOKIE = `${LOGIN_COOKIE}=${TOKEN}`

const answer = async (res: Response | Promise<Response>): Promise<[number, unknown]> => {
  const r = await res
  return [r.status, await r.json()]
}

/** /api/system as a caller could spell it (raw, decoded). */
const SPELLINGS: [string, string][] = [
  ['/api/system', '/api/system'],
  ['/api/%73ystem', '/api/system'],
  ['/api/syst%65m', '/api/system'],
]
/** Not the route itself: a path under it, or one that leaves it. */
const UNDER: [string, string][] = [
  ['/api/system/', '/api/system/'],
  ['/api/system/x', '/api/system/x'],
  ['/api/system%2F..%2Faccess', '/api/system/../access'],
]

describe('remoteRefusal', () => {
  test("the board's own server's login: /api/system by, in every spelling; a path under it refused", async () => {
    for (const [raw, path] of SPELLINGS)
      expect([raw, remoteRefusal(raw, path, { ownServer: true })]).toEqual([raw, null])
    for (const [raw, path] of UNDER) {
      const res = remoteRefusal(raw, path, { ownServer: true })
      expect([raw, res?.status, await res?.json()]).toEqual([raw, 403, { error: 'local' }])
    }
  })

  test("a phone (the owner's too), a desk, an allowed Tailscale user, a PC's tunnel: refused as Backup… is", async () => {
    for (const options of [
      undefined,
      {},
      // a PC's tunnel: the owner's login
      { ownServer: false, teamOwner: true, owner: true },
      // the owner's own phone through Tailscale
      { desk: false, teamOwner: true, owner: true },
      { desk: true },
      // a Tailscale user remote.allow lets in
      { desk: false, teamOwner: false, owner: false },
    ])
      for (const [raw, path] of SPELLINGS) {
        const res = remoteRefusal(raw, path, options)
        expect([raw, options, res?.status, await res?.json()]).toEqual([raw, options, 403, { error: 'local' }])
      }
  })
})

describe("the board's own server: its state through the domain's login", () => {
  const shared = sharedSandbox()
  let box: Sandbox
  let url = ''
  let proc: Child
  let me: ReturnType<typeof viaSocket>
  let stranger: ReturnType<typeof viaSocket>

  beforeAll(async () => {
    box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    let socket = ''
    ;({ url, socket, proc } = await startOwnServer(box, {}, { TEST_ROUTE_TABLE: '1' }))
    me = viaSocket(socket, COOKIE)
    stranger = viaSocket(socket)
  }, 30_000)

  test('the route is in the table', () => {
    expect(routeTable(proc).map(r => r.path)).toContain('/api/system')
  })

  test('without a login: 401', async () => {
    expect(await answer(stranger.get('/api/system'))).toEqual([401, { error: 'login' }])
  })

  test('signed in: the state now, in either spelling, kept a moment', async () => {
    const [status, view] = (await answer(me.get('/api/system'))) as [number, Record<string, unknown>]
    expect(status).toBe(200)
    expect(Object.keys(view).sort()).toEqual(
      ['at', 'cpu', 'disks', 'host', 'memory', 'top', 'uptime', ...('gpu' in view ? ['gpu'] : [])].sort(),
    )
    expect(typeof view.host).toBe('string')
    const top = view.top as { cpu: unknown[]; memory: unknown[] }
    expect([Array.isArray(top.cpu), Array.isArray(top.memory)]).toEqual([true, true])
    if (process.platform === 'linux') {
      const cpu = view.cpu as { cores: number; usage: number | null }
      expect(cpu.cores).toBeGreaterThan(0)
      expect(typeof cpu.usage).toBe('number')
      expect((view.memory as { total: number }).total).toBeGreaterThan(0)
      expect((view.disks as unknown[]).length).toBeGreaterThan(0)
      expect(top.memory.length).toBeGreaterThan(0)
    }
    const [again, kept] = (await answer(me.get('/api/%73ystem'))) as [number, { at: number }]
    expect([again, kept.at]).toEqual([200, view.at as number])
  })

  test('read only: a POST is no route; a path under it is refused', async () => {
    expect((await me.post('/api/system', {})).status).toBe(405)
    expect(await answer(me.get('/api/system/x'))).toEqual([403, { error: 'local' }])
  })

  test("on 127.0.0.1 only with the board's local key", async () => {
    const key = readFileSync(join(stateFolder(box), 'local-key'), 'utf8').trim()
    expect((await fetch(`${url}/api/system`)).status).toBe(403)
    expect((await fetch(`${url}/api/system`, { headers: { 'x-board-key': key } })).status).toBe(200)
  })
})

describe('a board on a PC (no serverMode)', () => {
  const shared = sharedSandbox()
  let url = ''
  let tunnel = ''
  let proc: Child

  beforeAll(async () => {
    const box = await shared()
    await seedAccess(box, { logins: [{ token: TOKEN }] })
    ;({ url, tunnel, proc } = await startTunnelBoard(box, {}, { TEST_ROUTE_TABLE: '1' }))
  }, 30_000)

  test('no such route: its own page answers it as any unknown path', async () => {
    expect(routeTable(proc).some(r => r.path.includes('system'))).toBe(false)
    expect(await answer(fetch(`${url}/api/system`))).toEqual(await answer(fetch(`${url}/api/no-such-route`)))
    expect(await answer(fetch(`${url}/api/system`))).toEqual([404, { error: 'not found' }])
  })

  test('through its tunnel, signed in: refused before any route, as Backup… is there', async () => {
    const mine = viaCaddy(tunnel, COOKIE)
    expect((await mine.get('/api/board')).status).toBe(200)
    for (const [raw] of SPELLINGS)
      expect([raw, ...(await answer(mine.get(raw)))]).toEqual([raw, 403, { error: 'local' }])
  })
})
