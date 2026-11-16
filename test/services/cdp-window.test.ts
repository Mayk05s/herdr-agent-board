// The agent's browser windows kept on its screen (services/cdp-window.ts), on a DevTools line of
// the test's own playing Chrome: a window past the screen (resize_page's setContentsSize grew it,
// with no window manager to stop it) is put back to the screen; one on it, smaller or not, a
// window that is not "normal", and what is not a page are left as they are; the agent's client
// never sees the board's messages, even one answered late.
import { expect, test } from 'bun:test'
import { SCREEN } from '../../src/core/desktop.ts'
import type { CdpLine } from '../../src/services/cdp-peek.ts'
import { fitWindows } from '../../src/services/cdp-window.ts'

type Msg = Record<string, unknown>
interface Bounds {
  left: number
  top: number
  width: number
  height: number
  windowState?: string
}

/** Chrome as far as the fit asks it: its pages, each in a window; what the agent's client got and what was sent. */
function fakeChrome(
  pages: { id: string; type?: string; window: number | null }[],
  windows: Record<number, Bounds>,
  o: { silent?: boolean } = {},
) {
  const taps = new Set<(text: string) => boolean>()
  const agent: string[] = []
  const sent: Msg[] = []
  const emit = (msg: Msg): void => {
    const text = JSON.stringify(msg)
    let own = false
    for (const tap of taps) if (tap(text)) own = true
    if (!own) agent.push(text)
  }
  const line: CdpLine = {
    send(text) {
      const m = JSON.parse(text) as Msg
      sent.push(m)
      const params = (m.params ?? {}) as Msg
      if (o.silent) return
      queueMicrotask(() => {
        if (m.method === 'Target.getTargets')
          return emit({
            id: m.id,
            result: {
              targetInfos: [
                { targetId: 'sw', type: 'service_worker', url: 'https://x/sw.js' },
                ...pages.map(p => ({ targetId: p.id, type: p.type ?? 'page', url: `https://x/${p.id}` })),
              ],
            },
          })
        if (m.method === 'Browser.getWindowForTarget') {
          const p = pages.find(x => x.id === params.targetId)
          if (!p || p.window === null)
            return emit({ id: m.id, error: { code: -32000, message: 'No web contents in the target' } })
          return emit({ id: m.id, result: { windowId: p.window, bounds: windows[p.window] } })
        }
        if (m.method === 'Browser.setWindowBounds') {
          const b = params.bounds as Bounds
          // Chrome on Xvnc keeps a pixel off each side when asked for the whole screen
          windows[params.windowId as number] = { ...b, width: b.width - 1, height: b.height - 1, windowState: 'normal' }
          return emit({ id: m.id, result: {} })
        }
        if (m.method === 'Browser.getWindowBounds')
          return emit({ id: m.id, result: { bounds: windows[params.windowId as number] } })
      })
    },
    tap(fn) {
      taps.add(fn)
      return () => taps.delete(fn)
    },
    pass(text) {
      agent.push(text)
    },
  }
  return { line, agent, sent, windows, taps }
}

const normal = (width: number, height: number, left = 0, top = 0): Bounds => ({
  left,
  top,
  width,
  height,
  windowState: 'normal',
})

test('a window past the screen (resize_page to 1600x1100: 1600x1187) is put back to the screen; what it was and is said', async () => {
  const c = fakeChrome([{ id: 'P1', window: 7 }], { 7: normal(1600, 1187) })
  const r = await fitWindows(c.line)
  expect(r).toEqual({
    ok: true,
    fitted: [{ before: normal(1600, 1187), after: normal(SCREEN.width - 1, SCREEN.height - 1) }],
  })
  expect(c.sent.filter(m => m.method === 'Browser.setWindowBounds')).toEqual([
    {
      id: expect.any(Number),
      method: 'Browser.setWindowBounds',
      params: { windowId: 7, bounds: { left: 0, top: 0, width: SCREEN.width, height: SCREEN.height } },
    },
  ])
  // the agent's client saw none of it
  expect(c.agent).toEqual([])
})

test('windows on the screen are left as they are: the whole screen, a smaller one (the agent’s own resize), one in a corner', async () => {
  for (const b of [normal(1439, 899), normal(1440, 900), normal(800, 687), normal(400, 300, 1040, 600)]) {
    const c = fakeChrome([{ id: 'P1', window: 7 }], { 7: b })
    expect(await fitWindows(c.line)).toEqual({ ok: true, fitted: [] })
    expect(c.sent.map(m => m.method)).toEqual(['Target.getTargets', 'Browser.getWindowForTarget'])
  }
})

test('past any side: wider, taller, moved off to the left or the top', async () => {
  for (const b of [
    normal(1441, 900),
    normal(1440, 901),
    normal(1440, 900, -5, 0),
    normal(1000, 600, 0, -1),
    normal(900, 600, 600, 0),
  ]) {
    const c = fakeChrome([{ id: 'P1', window: 7 }], { 7: b })
    const r = await fitWindows(c.line)
    expect(r.ok && r.fitted.map(f => f.before)).toEqual([b])
  }
})

test('several tabs in one window: fitted once; another window (an isolated context’s) on its own; what is not a page is not asked', async () => {
  const c = fakeChrome(
    [
      { id: 'P1', window: 7 },
      { id: 'P2', window: 7 },
      { id: 'P3', window: 9 },
      { id: 'UI', type: 'browser_ui', window: 7 },
    ],
    { 7: normal(1600, 1187), 9: normal(1439, 899) },
  )
  const r = await fitWindows(c.line)
  expect(r.ok && r.fitted.map(f => f.before)).toEqual([normal(1600, 1187)])
  expect(c.sent.filter(m => m.method === 'Browser.getWindowForTarget').map(m => (m.params as Msg).targetId)).toEqual([
    'P1',
    'P2',
    'P3',
  ])
  expect(c.sent.filter(m => m.method === 'Browser.setWindowBounds')).toHaveLength(1)
})

test('a window not "normal" (fullscreen, maximized: Chrome sizes it to the screen) is not touched; a page with no window is skipped', async () => {
  const c = fakeChrome(
    [
      { id: 'P1', window: 7 },
      { id: 'GONE', window: null },
    ],
    { 7: { left: 0, top: 0, width: 1600, height: 1000, windowState: 'fullscreen' } },
  )
  expect(await fitWindows(c.line)).toEqual({ ok: true, fitted: [] })
})

test('a browser that does not answer: said once the time is up; its late answer still never reaches the agent', async () => {
  const c = fakeChrome([{ id: 'P1', window: 7 }], { 7: normal(1600, 1187) }, { silent: true })
  expect(await fitWindows(c.line, 30)).toEqual({ ok: false, error: 'the browser did not answer' })
  const id = c.sent[0]?.id
  for (const tap of c.taps) tap(JSON.stringify({ id, result: { targetInfos: [] } }))
  // what the tap kept from the agent is not handed on either
  expect(c.agent).toEqual([])
})

test('the agent’s own messages pass by the fit’s tap untouched', async () => {
  const c = fakeChrome([{ id: 'P1', window: 7 }], { 7: normal(1600, 1187) })
  const done = fitWindows(c.line)
  const kept = [...c.taps].map(tap => tap(JSON.stringify({ id: 12, result: {} })))
  const event = [...c.taps].map(tap => tap(JSON.stringify({ method: 'Target.targetInfoChanged', params: {} })))
  expect([...kept, ...event].every(k => k === false)).toBe(true)
  await done
})
