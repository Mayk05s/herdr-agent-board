// `board browser-mcp`: the agent's browser as an MCP server (stdio), which the board's install
// puts in each Claude profile on the board's server (core/desktop.ts BROWSER_MCP). It knows its
// session by its pane (HERDR_PANE_ID, else its Claude's own environment) and runs
// chrome-devtools-mcp (pinned, adapters/desktop-files.ts) pointed at the board's DevTools route
// for that pane (routes/desktop.ts /api/browser/cdp, a WebSocket to the session's Chrome, whose
// DevTools listen on no port), with the board's local key in its headers: in a config file of the
// board's user's alone (0600 in a 0700 folder, gone when it ends), never on a command line, which
// every account on the server can read. Before a tool call goes on, the board starts the
// session's desktop (services/desktop.ts), so what keeps it from starting is the call's answer.
//
// Between Claude and chrome-devtools-mcp it relays JSON-RPC line by line, and before a tool call
// that acts goes on it asks the board who has the browser. While the owner has it for what the
// agent asked, the call fails at once: the agent ends its turn and the board wakes it when the
// browser is handed back (services/desktop.ts). While the owner has it otherwise (or the board does
// not say), the call waits, up to HOLD_MS, then answers that the owner has the browser. A call that
// only looks (READS: a screenshot of what shows, the page's snapshot, its pages, the console and
// the network) goes on whoever has it (a board that does not answer holds it as any call), so the
// agent can answer the owner about the screen. A
// JSON-RPC batch waits or fails as a whole, unless all of it only looks. Four tools of its own join
// the list: browser_profile (a named profile, for logins that last), browser_ask_owner (the card
// under "needs you": sign in to X for me), browser_fill_login (a login from the owner's vault typed
// into the focused field once the owner approves, core/login-fill.ts; where the board has no vault
// the board says so) and browser_close (done with it for now: it stops, its sign-ins and tabs kept,
// and the next call starts it again; chrome-devtools-mcp connects to it again by itself, as it does
// to a browser restarted). And two that read the page compactly (services/browser-read.ts:
// read_page, list_interactive), through chrome-devtools-mcp by calls of the wrapper's own, which
// only look; take_snapshot's and wait_for's descriptions point to them.
//
// The browser's window stays on its screen (core/desktop.ts PAGE_MAX): a resize_page or an emulate
// viewport larger than what shows of the page there is refused before anything is done (the window
// would grow past the screen, or the page be cut off in it, where the owner's view does not reach,
// while the agent's screenshots still show it whole), and once a resize_page that went on is
// answered, the board puts back a window that went past the screen all the same
// (services/cdp-window.ts), and the agent is told the size that fits.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_KEY_HEADER } from '../adapters/local-key.ts'
import { HOLD_MS, PAGE_MAX, SCREEN } from '../core/desktop.ts'
import { type ChildCall, READ_TOOL_NAMES, READ_TOOLS, readTool, STEER, steered } from './browser-read.ts'

type Msg = Record<string, unknown>
const isRecord = (v: unknown): v is Msg => !!v && typeof v === 'object' && !Array.isArray(v)

/** The tools the wrapper answers itself. */
export const OWN_TOOLS = [
  {
    name: 'browser_profile',
    description:
      'Opens your browser with a named profile, whose sign-ins stay for later sessions (a new name makes a new one; "github", "client-x"). With no name, a profile of this session only, gone when it ends. Your browser restarts: open pages close. When another session has that profile open, you get a copy of it, thrown away afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'letters, digits, ".", "_" and "-"; empty: this session only' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_ask_owner',
    description:
      'Asks the owner to act in your browser for you: sign in, a password or a key, a captcha, 2FA. Your card goes under "needs you" with your browser on it; the owner takes it over from the board and hands it back. After asking, end your turn: do not poll and do not call browser tools to wait. The board wakes you with a message when the owner hands your browser back. While the owner has it, tools that act in it fail at once; looking works (read_page, list_interactive, take_screenshot of what shows, take_snapshot, list_pages, the console and the network), so you can answer what the owner asks meanwhile. Never type the owner\'s secrets yourself.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'what you need, e.g. "Sign in to GitHub as acme-bot"' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_fill_login',
    description:
      "Types a login from the owner's password vault into your browser, on the board's own server: the username, the password and/or the current 2FA (TOTP) code, in the order you list them, with Tab between them (and Return after, with submit). First click the field where typing starts (the username field; the code field for totp alone), then call this once. The board reads which page has the focus itself and asks the owner on your card; they approve with their vault's master password or decline. You never get a value: only whether it was typed. After asking, end your turn: do not poll and do not call browser tools to wait. The board wakes you with a message: ok (typed), declined, expired, no match (no login for the site), or why it did not go through. Never ask the owner for the password in the chat.",
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: { type: 'string', enum: ['username', 'password', 'totp'] },
          description: 'what to type, in order, each at most once; default ["username", "password"]',
        },
        submit: { type: 'boolean', description: 'press Return after the last one (default false)' },
        username: { type: 'string', description: 'the login to use when the vault has several for the site' },
        site: {
          type: 'string',
          description: 'the site you mean (a domain); the page with the focus must be on it. Default: that page',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_close',
    description:
      'Closes your browser once you are done with it for now: its window and its display stop, which frees the server’s memory. Its sign-ins and open tabs are kept: the next browser tool call opens it again by itself (a few seconds), with them; page ids change then, list_pages shows them. Call it when your task no longer needs the browser. Left unused for 15 minutes (no call, the owner not watching it), the board closes it the same way. Not while the owner has it or your ask to them stands.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
] as const

export const OWNER_HAS_IT =
  'The owner has the browser now (they took it over from the board). Try again later, or ask what they need; nothing was done.'
/** A call that acts while the owner has the browser for what the agent asked: at once, no wait. */
export const OWNER_DOING_ASK =
  'The owner has your browser now, for what you asked: nothing was done. End your turn; the board wakes you with a message when they hand it back. Meanwhile you can look: read_page, list_interactive, take_screenshot (of what shows), take_snapshot, list_pages, and the console and network reads work.'
/** What the agent is told once its browser is closed (browser_close). */
export const CLOSED =
  'Your browser is closed: its window and display stopped. Its sign-ins and open tabs are kept; the next browser tool call opens it again with them (a few seconds; page ids change, list_pages shows them).'
/** What the agent is told once a login fill is asked (browser_fill_login). */
export const FILL_ASKED =
  'Asked: your card is under "needs you" with the login fill; the owner approves it on the board. End your turn now: do not poll and do not call browser tools to wait (the focus must stay where it is). The board wakes you with a message saying whether it was typed.'
/** What the agent is told once it asked the owner (browser_ask_owner). */
export const ASKED =
  'Asked: your card is under "needs you" with your browser on it. End your turn now: do not poll and do not call browser tools to wait. The board wakes you with a message when the owner hands your browser back; then check the page and go on. If the owner writes to you meanwhile, answer them: you can look at the browser then (read_page, list_interactive, take_screenshot, take_snapshot, list_pages, the console and the network), not act in it.'

/**
 * The calls that only look, which go on while the owner has the browser: nothing in them moves the
 * page under the owner's hands. A screenshot only of what shows (an element's scrolls it into view,
 * a full page's lays the page out beyond the window); not wait_for (it waits), nor select_page (it
 * may bring a tab to the front), nor evaluate_script (a script may do anything), nor any tool not
 * named here.
 */
export const READS: ReadonlySet<string> = new Set([
  'take_screenshot',
  'take_snapshot',
  'list_pages',
  'list_console_messages',
  'get_console_message',
  'list_network_requests',
  'get_network_request',
  'get_css_styles',
])

/** A tools/call's params that only look (READS, a screenshot without `uid` or `fullPage`). */
export function onlyLooks(params: unknown): boolean {
  if (!isRecord(params) || typeof params.name !== 'string' || !READS.has(params.name)) return false
  if (params.name !== 'take_screenshot') return true
  const args = isRecord(params.arguments) ? params.arguments : {}
  return !args.uid && !args.fullPage
}
export const BOARD_SILENT =
  'The board does not answer who has the browser (it may be restarting): nothing was done. Try again in a moment.'

const PAGE = `${PAGE_MAX.width}x${PAGE_MAX.height}`
const SCREEN_SIZE = `${SCREEN.width}x${SCREEN.height}`
/** To see more of a page than shows: a screenshot of the whole page, which needs no larger window. */
const WHOLE_PAGE = 'To see a whole long page, take_screenshot with fullPage: true.'

/** What resize_page and emulate are told on top of their descriptions: the page's largest size on the screen. */
export const WINDOW_STEER: Readonly<Record<string, string>> = {
  resize_page: ` The browser's window never gets larger than its screen (${SCREEN_SIZE}, which the owner watches): the page is at most ${PAGE} (Chrome's own bar takes the rest), a larger size is refused. ${WHOLE_PAGE}`,
  emulate: ` A viewport is at most ${PAGE}, what shows of the page on the browser's screen (which the owner watches): a larger one is refused, and nothing of the call is set then.`,
}

/** The page size a call asks for: resize_page's width and height, emulate's viewport ('<w>x<h>…'); null for none. */
export function pageAsked(params: unknown): { what: 'page' | 'viewport'; width: number; height: number } | null {
  if (!isRecord(params)) return null
  const args = isRecord(params.arguments) ? params.arguments : {}
  if (params.name === 'resize_page' && typeof args.width === 'number' && typeof args.height === 'number')
    return { what: 'page', width: args.width, height: args.height }
  if (params.name !== 'emulate' || typeof args.viewport !== 'string') return null
  // one chrome-devtools-mcp cannot read goes on: it says why
  const m = /^\s*(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)/.exec(args.viewport)
  return m ? { what: 'viewport', width: Number(m[1]), height: Number(m[2]) } : null
}

/** A call that asks for a page larger than what shows on the screen: what it is told (nothing was done); null when it fits. */
export function tooLarge(params: unknown): string | null {
  const a = pageAsked(params)
  if (!a || (a.width <= PAGE_MAX.width && a.height <= PAGE_MAX.height)) return null
  const asked = `${a.width}x${a.height}`
  return a.what === 'page'
    ? `A page of ${asked} does not fit the browser's screen: nothing was done. The screen is ${SCREEN_SIZE} and the window never gets larger (the owner watches the screen; past it, they would not see the page's right and bottom); under Chrome's own bar the page is at most ${PAGE}. Ask for at most that. ${WHOLE_PAGE}`
    : `A viewport of ${asked} does not fit the browser's screen: nothing was done (none of this call's settings). What shows of the page there is at most ${PAGE} (the screen is ${SCREEN_SIZE}, Chrome's own bar above the page), and the owner watches the screen: a larger viewport is cut off for them. Call emulate again with a viewport of at most ${PAGE}, or none.`
}

/** resize_page's page went on, and its window past the screen all the same: put back by the board; what the agent is told. */
export function putBack(asked: { width: number; height: number }, before: { width: number; height: number }): string {
  const barW = before.width - asked.width
  const barH = before.height - asked.height
  const fits = barW >= 0 && barH >= 0 ? `${SCREEN.width - barW}x${SCREEN.height - barH}` : PAGE
  return `A page of ${asked.width}x${asked.height} made the browser's window ${before.width}x${before.height}, larger than its screen (${SCREEN_SIZE}, which the owner watches): the window was put back to the screen, so the page is not that size. A page of at most ${fits} fits here. ${WHOLE_PAGE}`
}

export interface RelayOptions {
  /** POST /api/browser/<op> on the board with this pane: its answer, or null when the board does not answer. */
  board(op: 'call' | 'start' | 'profile' | 'ask' | 'close' | 'login' | 'fit', body: Msg): Promise<Msg | null>
  toChild(line: string): void
  toClient(line: string): void
  holdMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long a call of the wrapper's own to chrome-devtools-mcp waits for its answer (read_page's). */
  childMs?: number
}

export interface Relay {
  fromClient(line: string): void
  fromChild(line: string): void
  /** Calls held now (the owner has the browser). */
  held(): number
  /** Every call answered or passed on (tests wait for it). */
  idle(): Promise<void>
}

const idKey = (id: unknown): string => JSON.stringify(id ?? null)
const result = (id: unknown, text: string, isError = false): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }], ...(isError && { isError: true }) },
  })

/** The JSON-RPC relay between Claude (client) and chrome-devtools-mcp (child). */
export function createRelay(o: RelayOptions): Relay {
  const holdMs = o.holdMs ?? HOLD_MS
  const pollMs = o.pollMs ?? 1000
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms))
  const now = o.now ?? Date.now
  const lists = new Set<string>()
  const holding = new Map<string, { cancelled: boolean }>()
  const busy = new Set<Promise<void>>()
  /** The wrapper's own calls to chrome-devtools-mcp (read_page's), by id: their answers never reach Claude. */
  const mine = new Map<string, (msg: Msg) => void>()
  let mineSeq = 0
  /** The resize_page calls passed on, by id, with the size asked: once answered, the board fits the window. */
  const resizing = new Map<string, { width: number; height: number }>()
  const track = (p: Promise<void>): void => {
    busy.add(p)
    void p.finally(() => busy.delete(p))
  }

  /**
   * Resolves true once the board says the agent has the browser (a call that only `looks`: either
   * has it); false when the hold timed out (`late` answers with why) or was cancelled, or at once
   * (`late` says so) while the owner has it for what the agent asked. A board that does not answer,
   * or answers anything else, holds the call as the owner does: nothing goes on that the board did
   * not let go.
   */
  async function agentHasIt(id: unknown, late: (text: string) => void, looks = false): Promise<boolean> {
    const key = idKey(id)
    const mark = { cancelled: false }
    const deadline = now() + holdMs
    try {
      for (;;) {
        const r = await o.board('call', {})
        if (mark.cancelled) return false
        if (r?.control === 'agent' || (looks && r?.control === 'owner')) return true
        if (r?.control === 'owner' && r.asks === true) {
          late(OWNER_DOING_ASK)
          return false
        }
        if (!holding.has(key)) holding.set(key, mark)
        if (now() >= deadline) {
          late(r?.control === 'owner' ? OWNER_HAS_IT : BOARD_SILENT)
          return false
        }
        await sleep(pollMs)
        if (mark.cancelled) return false
      }
    } finally {
      if (holding.get(key) === mark) holding.delete(key)
    }
  }

  /** The session's browser up before a call goes on (the board starts it on the first); false: answered why not. */
  async function started(late: (text: string) => void): Promise<boolean> {
    const r = await o.board('start', {})
    if (r?.ok === true) return true
    late(r ? `No browser: ${String(r.error ?? 'it did not start')}` : 'The board does not answer: no browser now.')
    return false
  }

  /** A tool call of the wrapper's own to chrome-devtools-mcp: its answer's text, and whether it failed. */
  const childCall: ChildCall = (name, args) =>
    new Promise(resolve => {
      const id = `board-read-${++mineSeq}`
      const key = idKey(id)
      const timer = setTimeout(() => {
        mine.delete(key)
        resolve({ text: 'The browser did not answer in time: nothing read.', isError: true })
      }, o.childMs ?? 120_000)
      mine.set(key, msg => {
        clearTimeout(timer)
        const r = isRecord(msg.result) ? msg.result : null
        const content = Array.isArray(r?.content) ? (r.content as unknown[]) : []
        const text = content
          .map(c => (isRecord(c) && typeof c.text === 'string' ? c.text : ''))
          .filter(Boolean)
          .join('\n')
        if (r) return resolve({ text, isError: r.isError === true })
        const err = isRecord(msg.error) && typeof msg.error.message === 'string' ? msg.error.message : 'no answer'
        resolve({ text: err, isError: true })
      })
      o.toChild(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))
    })

  /**
   * resize_page answered: the board puts back a window past the screen (services/cdp-window.ts).
   * One was: the agent is told so and the size that fits; none, or no word from the board: the
   * answer as chrome-devtools-mcp gave it.
   */
  async function fitAfter(line: string, id: unknown, asked: { width: number; height: number }): Promise<void> {
    const r = await o.board('fit', {})
    const first = r?.ok === true && Array.isArray(r.fitted) ? r.fitted.find(isRecord) : undefined
    const before = first && isRecord(first.before) ? first.before : null
    if (!before || typeof before.width !== 'number' || typeof before.height !== 'number') return o.toClient(line)
    o.toClient(result(id, putBack(asked, { width: before.width, height: before.height }), true))
  }

  /** read_page or list_interactive: they only look, so they go on whoever has the browser, once it is up. */
  async function read(msg: Msg, params: Msg): Promise<void> {
    const id = msg.id
    const late = (text: string) => o.toClient(result(id, text, true))
    if (!(await agentHasIt(id, late, true)) || !(await started(late))) return
    const args = isRecord(params.arguments) ? params.arguments : {}
    const r = await readTool(String(params.name), args, childCall)
    o.toClient(result(id, r.text, r.isError))
  }

  async function own(msg: Msg, params: Msg): Promise<void> {
    const id = msg.id
    const args = isRecord(params.arguments) ? params.arguments : {}
    if (params.name === 'browser_profile') {
      if (!(await agentHasIt(id, text => o.toClient(result(id, text, true))))) return
      const name = typeof args.name === 'string' ? args.name : ''
      const r = await o.board('profile', { name: name || null })
      if (!r) return o.toClient(result(id, 'The board does not answer: no browser now.', true))
      if (r.ok !== true) return o.toClient(result(id, String(r.error ?? 'not done'), true))
      const text = !r.profile
        ? 'Your browser has this session’s own profile now (gone when the session ends).'
        : r.copy
          ? `Your browser has a copy of the profile "${r.profile}" (another session has it open): what you change in it is thrown away afterwards.`
          : `Your browser has the profile "${r.profile}" now; its sign-ins stay for later sessions.`
      return o.toClient(result(id, text))
    }
    // closed under the owner's hands never: it waits, or fails, as any call that acts
    if (params.name === 'browser_close') {
      if (!(await agentHasIt(id, text => o.toClient(result(id, text, true))))) return
      const r = await o.board('close', {})
      if (!r) return o.toClient(result(id, 'The board does not answer: your browser was not closed.', true))
      if (r.ok !== true) return o.toClient(result(id, String(r.error ?? 'not closed'), true))
      return o.toClient(
        result(
          id,
          r.closed ? CLOSED : 'Your browser was not open: nothing to close. The next browser tool call opens it.',
        ),
      )
    }
    // typed in under the owner's hands never: it waits, or fails, as any call that acts
    if (params.name === 'browser_fill_login') {
      if (!(await agentHasIt(id, text => o.toClient(result(id, text, true))))) return
      const r = await o.board('login', {
        ...(args.fields !== undefined && { fields: args.fields }),
        submit: args.submit === true,
        ...(typeof args.username === 'string' && { username: args.username }),
        ...(typeof args.site === 'string' && { site: args.site }),
        wake: true,
      })
      if (!r) return o.toClient(result(id, 'The board does not answer: nothing was asked.', true))
      if (r.ok !== true) return o.toClient(result(id, String(r.error ?? 'not asked'), true))
      return o.toClient(result(id, FILL_ASKED))
    }
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return o.toClient(result(id, 'text: what you need the owner to do', true))
    const r = await o.board('ask', { text })
    if (!r) return o.toClient(result(id, 'The board does not answer: the owner was not asked.', true))
    if (r.ok !== true) return o.toClient(result(id, String(r.error ?? 'not asked'), true))
    o.toClient(result(id, ASKED))
  }

  return {
    fromClient(line) {
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return o.toChild(line)
      }
      // a batch with a call in it waits as a whole; answered as a batch when its hold ends; one
      // that only looks goes on as such a call does
      if (Array.isArray(msg)) {
        const calls = msg.filter(m => isRecord(m) && m.method === 'tools/call') as Msg[]
        if (!calls.length) return o.toChild(line)
        const ids = msg.filter(m => isRecord(m) && m.method !== undefined && m.id !== undefined).map(m => (m as Msg).id)
        const late = (text: string) => o.toClient(JSON.stringify(ids.map(i => JSON.parse(result(i, text, true)))))
        const large = calls.map(c => tooLarge(c.params)).find(t => t !== null)
        if (large) return late(large)
        const looks = calls.every(c => onlyLooks(c.params))
        return track(
          agentHasIt(calls[0]?.id, late, looks).then(async go => {
            if (go && (await started(late))) o.toChild(line)
          }),
        )
      }
      if (!isRecord(msg)) return o.toChild(line)
      const params = isRecord(msg.params) ? msg.params : {}
      if (msg.method === 'tools/list' && msg.id !== undefined) lists.add(idKey(msg.id))
      if (msg.method === 'notifications/cancelled') {
        const held = holding.get(idKey(params.requestId))
        if (held) {
          held.cancelled = true
          return
        }
      }
      if (msg.method !== 'tools/call') return o.toChild(line)
      if (OWN_TOOLS.some(t => t.name === params.name)) return track(own(msg, params))
      if (typeof params.name === 'string' && READ_TOOL_NAMES.has(params.name)) return track(read(msg, params))
      const late = (text: string) => o.toClient(result(msg.id, text, true))
      // a page larger than the screen shows: refused before anything is done
      const large = tooLarge(params)
      if (large) return late(large)
      const resize = params.name === 'resize_page' ? pageAsked(params) : null
      // Looking goes on whoever has the browser; acting waits for the agent's turn at it.
      track(
        agentHasIt(msg.id, late, onlyLooks(params)).then(async go => {
          if (!go || !(await started(late))) return
          if (resize && msg.id !== undefined) resizing.set(idKey(msg.id), resize)
          o.toChild(line)
        }),
      )
    },
    fromChild(line) {
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return o.toClient(line)
      }
      const key = isRecord(msg) ? idKey(msg.id) : ''
      const answer = isRecord(msg) && msg.method === undefined ? mine.get(key) : undefined
      if (answer && isRecord(msg)) {
        mine.delete(key)
        return answer(msg)
      }
      const resized = isRecord(msg) && msg.method === undefined ? resizing.get(key) : undefined
      if (resized && isRecord(msg)) {
        resizing.delete(key)
        return track(fitAfter(line, msg.id, resized))
      }
      if (isRecord(msg) && lists.has(key) && isRecord(msg.result) && Array.isArray(msg.result.tools)) {
        lists.delete(key)
        const tools = steered(msg.result.tools, { ...STEER, ...WINDOW_STEER })
        msg.result.tools = msg.result.nextCursor ? tools : [...tools, ...READ_TOOLS, ...OWN_TOOLS]
        return o.toClient(JSON.stringify(msg))
      }
      o.toClient(line)
    },
    held: () => holding.size,
    async idle() {
      while (busy.size) await Promise.all([...busy])
    },
  }
}

/** The session's pane: HERDR_PANE_ID, else its parent's (Claude's) own environment, where herdr set it. */
export function paneOf(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid): string | null {
  if (env.HERDR_PANE_ID) return env.HERDR_PANE_ID
  try {
    const parent = readFileSync(`/proc/${ppid}/environ`, 'utf8').split('\0')
    const line = parent.find(l => l.startsWith('HERDR_PANE_ID='))
    return line ? line.slice('HERDR_PANE_ID='.length) || null : null
  } catch {
    return null
  }
}

/** Lines of a byte stream, each without its newline, as they come. */
export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of stream) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split('\n')
    rest = parts.pop() ?? ''
    for (const p of parts) if (p.trim()) yield p.replace(/\r$/, '')
  }
  rest += decoder.decode()
  if (rest.trim()) yield rest
}

/**
 * chrome-devtools-mcp's command line and config file: the board's DevTools route for `pane`, the
 * key in the file's headers (the command line has the file's path only), no usage statistics or
 * CrUX, and no page ids (one agent to a browser).
 */
export function devtoolsMcp(o: { origin: string; pane: string; key: string | null; bin: string; config: string }): {
  argv: string[]
  config: Record<string, string>
} {
  const ws = `${o.origin.replace(/^http/, 'ws')}/api/browser/cdp?pane=${encodeURIComponent(o.pane)}`
  return {
    argv: [
      process.execPath,
      o.bin,
      '--config',
      o.config,
      '--no-usage-statistics',
      '--no-performance-crux',
      '--no-page-id-routing',
    ],
    config: { wsEndpoint: ws, ...(o.key && { wsHeaders: JSON.stringify({ [LOCAL_KEY_HEADER]: o.key }) }) },
  }
}

export interface WrapperOptions {
  pane: string
  /** The board's address: http://127.0.0.1:<port>. */
  origin: string
  /** fetch with the board's local key (adapters/local-key.ts localFetch). */
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** The board's local key (adapters/local-key.ts), for chrome-devtools-mcp's WebSocket; null: none. */
  key: string | null
  /** A folder of the board's user's for chrome-devtools-mcp's config file (made 0700). */
  runDir: string
  /** chrome-devtools-mcp's program. */
  bin: string
  holdMs?: number
}

/** Runs the wrapper on this process's stdin and stdout until Claude closes stdin; its exit code. */
export async function runWrapper(w: WrapperOptions): Promise<number> {
  const ask = async (op: string, body: Msg, ms: number): Promise<Msg | null> => {
    try {
      const res = await w.fetch(`${w.origin}/api/browser/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, pane: w.pane }),
        signal: AbortSignal.timeout(ms),
      })
      const v: unknown = await res.json()
      return isRecord(v) ? v : null
    } catch {
      return null
    }
  }
  mkdirSync(w.runDir, { recursive: true, mode: 0o700 })
  const config = join(w.runDir, `devtools-mcp-${process.pid}.json`)
  const m = devtoolsMcp({ origin: w.origin, pane: w.pane, key: w.key, bin: w.bin, config })
  rmSync(config, { force: true })
  writeFileSync(config, JSON.stringify(m.config), { mode: 0o600, flag: 'wx' })
  try {
    const child = Bun.spawn(m.argv, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: {
        ...process.env,
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        // its own config only, never one found in the user's folders
        CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: '1',
      },
    })
    const out = (line: string): void => {
      process.stdout.write(`${line}\n`)
    }
    const relay = createRelay({
      board: (op, body) => ask(op, body, op === 'call' ? 5000 : op === 'fit' ? 10_000 : 90_000),
      toChild: line => {
        try {
          child.stdin.write(`${line}\n`)
          void child.stdin.flush()
        } catch {}
      },
      toClient: out,
      ...(w.holdMs !== undefined && { holdMs: w.holdMs }),
    })
    const fromChild = (async () => {
      for await (const line of linesOf(child.stdout)) relay.fromChild(line)
    })()
    const fromClient = (async () => {
      for await (const line of linesOf(Bun.stdin.stream() as ReadableStream<Uint8Array>)) relay.fromClient(line)
    })()
    // Claude closed stdin (what is under way is not waited for), or chrome-devtools-mcp ended
    const first = await Promise.race([
      fromClient.then(() => 'client' as const),
      child.exited.then(() => 'child' as const),
    ])
    if (first === 'client') {
      try {
        await child.stdin.end()
      } catch {}
      if ((await Promise.race([child.exited, Bun.sleep(3000).then(() => null)])) === null) child.kill()
    }
    await fromChild.catch(() => {})
    return first === 'client' ? 0 : 1
  } finally {
    rmSync(config, { force: true })
  }
}
