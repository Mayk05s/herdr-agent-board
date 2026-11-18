// The server chip (components/server/ServerChip.tsx) drawn in a real DOM (jsdom) at a width: on a
// phone (PHONE_QUERY) it is hidden and wants nothing (the head has no room; Settings → Server… is
// there), on an iPad or a computer it is shown and wants the state every CHIP_MS; gone, it lets go.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { SystemView } from '../../src/core/system-state.ts'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'matchMedia'] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import('react-dom/client').createRoot
let ServerChip: typeof import('../../web/src/components/server/ServerChip.tsx').ServerChip
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let model: typeof import('../../web/src/models/server-state.ts')
let PHONE_QUERY = ''

const VIEW: SystemView = {
  at: 1,
  host: 'workbench',
  uptime: 100,
  cpu: { usage: 25, cores: 12, load: [1, 1, 1] },
  memory: { total: 100, used: 34, available: 66, free: 10, buffersCache: 50, swapTotal: 0, swapUsed: 0 },
  disks: [],
  top: { cpu: [], memory: [] },
}

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ServerChip } = await import('../../web/src/components/server/ServerChip.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  model = await import('../../web/src/models/server-state.ts')
  ;({ PHONE_QUERY } = await import('../../web/src/models/panel-motion.ts'))
})

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

/** The chip at a width (a phone's matches PHONE_QUERY), on a poll that records what is wanted. */
async function chipAt(phone: boolean) {
  g.matchMedia = (query: string) => ({
    matches: phone && query === PHONE_QUERY,
    addEventListener() {},
    removeEventListener() {},
  })
  const poll = model.createServerPoll({
    get: () => new Promise(() => {}),
    doc: { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    now: () => 0,
  })
  poll.store.set({ view: VIEW, error: null, gone: false })
  const wanted: [string, number | null][] = []
  const want = poll.want
  poll.want = (who, ms) => {
    wanted.push([who, ms])
    want(who, ms)
  }
  const root = createRoot(dom.window.document.getElementById('root') as unknown as HTMLElement)
  await act(async () =>
    root.render(
      <I18nProvider lang="en">
        <ServerChip onOpen={() => {}} poll={poll} />
      </I18nProvider>,
    ),
  )
  const button = () => dom.window.document.getElementById('server-chip')
  return { button, wanted, unmount: () => act(async () => root.unmount()) }
}

describe('the chip at a width', () => {
  test('a phone: hidden, and it wants nothing', async () => {
    const c = await chipAt(true)
    expect(c.button()?.hidden).toBe(true)
    expect(c.wanted.filter(([, ms]) => ms !== null)).toEqual([])
    await c.unmount()
  })

  test('an iPad or a computer: shown, it wants the state every CHIP_MS; gone, it lets go', async () => {
    const c = await chipAt(false)
    expect(c.button()?.hidden).toBe(false)
    expect(c.button()?.textContent).toBe('CPU 25%RAM 34%')
    expect(c.wanted).toEqual([['chip', model.CHIP_MS]])
    await c.unmount()
    expect(c.wanted.at(-1)).toEqual(['chip', null])
  })
})
