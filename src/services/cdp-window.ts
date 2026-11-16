// The agent's browser windows kept on their screen (core/desktop.ts SCREEN): the display has no
// window manager, so nothing stops a window from growing past the screen, as chrome-devtools-mcp's
// resize_page grows it (Browser.setContentsSize: the page that size, the window that plus Chrome's
// bar). The agent's screenshots still show the whole page (DevTools capture the page, not the
// screen), while the owner's view, which is the screen, cuts it off on the right and at the bottom.
//
// A window past the screen is put back to the screen's bounds; one on it (the whole screen, or a
// smaller one the agent asked for) and one not "normal" (fullscreen, maximized: Chrome sizes those
// itself) are left as they are. Browser-level commands only (no session attached, nothing run in a
// page), on the agent's DevTools line when one is open, its own messages kept from the agent's
// client as the board's look does (services/cdp-peek.ts): their ids are in a range of their own.
import { pastScreen, SCREEN, type WindowBounds } from '../core/desktop.ts'
import type { CdpLine } from './cdp-peek.ts'

type Msg = Record<string, unknown>
const isRecord = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v)

/** A window put back: its bounds before, and after (null: not read). */
export interface FittedWindow {
  before: WindowBounds
  after: WindowBounds | null
}

export type FitResult = { ok: true; fitted: FittedWindow[] } | { ok: false; error: string }

/** Ids of the fit's own commands: far past any a client counts to, below the login watch's (services/login-watch.ts) and the look's. */
const BASE_ID = 1_700_000_000
const ID_TOP = 1_799_999_999
let nextId = BASE_ID
/** At most this many pages asked for their window. */
const MAX_PAGES = 32

const boundsOf = (v: unknown): WindowBounds | null =>
  isRecord(v) &&
  typeof v.left === 'number' &&
  typeof v.top === 'number' &&
  typeof v.width === 'number' &&
  typeof v.height === 'number'
    ? {
        left: v.left,
        top: v.top,
        width: v.width,
        height: v.height,
        ...(typeof v.windowState === 'string' && { windowState: v.windowState }),
      }
    : null

/** The windows of the browser on `line` that reach past the screen, put back to it: which ones, before and after. */
export async function fitWindows(line: CdpLine, timeoutMs = 5000): Promise<FitResult> {
  const pending = new Map<number, { done: (v: Msg) => void; fail: (e: Error) => void }>()
  // every answer in the fit's range is the board's, one come late too: never the agent's
  const untap = line.tap(text => {
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      return false
    }
    if (!isRecord(msg) || typeof msg.id !== 'number' || msg.id < BASE_ID || msg.id > ID_TOP) return false
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (isRecord(msg.error)) p?.fail(new Error(String(msg.error.message ?? 'cdp')))
    else p?.done(isRecord(msg.result) ? msg.result : {})
    return true
  })
  /** The fit gave up (or is done): nothing more is sent. */
  let over = false
  const call = (method: string, params: Msg = {}): Promise<Msg> =>
    new Promise((done, fail) => {
      if (over) return fail(new Error('done'))
      nextId = nextId >= ID_TOP ? BASE_ID : nextId + 1
      const id = nextId
      pending.set(id, { done, fail })
      line.send(JSON.stringify({ id, method, params }))
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error('the browser did not answer')), timeoutMs)
  })
  try {
    return await Promise.race([
      (async (): Promise<FitResult> => {
        const t = await call('Target.getTargets')
        const pages = (Array.isArray(t.targetInfos) ? t.targetInfos : [])
          .filter(isRecord)
          .filter(i => i.type === 'page' && typeof i.targetId === 'string')
          .slice(0, MAX_PAGES)
        const windows = new Map<number, WindowBounds>()
        for (const p of pages) {
          const w = await call('Browser.getWindowForTarget', { targetId: p.targetId }).catch(() => null)
          const bounds = boundsOf(w?.bounds)
          if (typeof w?.windowId === 'number' && bounds && !windows.has(w.windowId)) windows.set(w.windowId, bounds)
        }
        const fitted: FittedWindow[] = []
        for (const [windowId, before] of windows) {
          if ((before.windowState ?? 'normal') !== 'normal' || !pastScreen(before)) continue
          await call('Browser.setWindowBounds', {
            windowId,
            bounds: { left: 0, top: 0, width: SCREEN.width, height: SCREEN.height },
          })
          const after = await call('Browser.getWindowBounds', { windowId }).catch(() => null)
          fitted.push({ before, after: boundsOf(after?.bounds) })
        }
        return { ok: true, fitted }
      })(),
      late,
    ])
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    over = true
    clearTimeout(timer)
    for (const p of pending.values()) p.fail(new Error('done'))
    pending.clear()
    // an answer that comes after the fit gave up is still kept from the agent a while
    setTimeout(untap, 1500).unref?.()
  }
}
