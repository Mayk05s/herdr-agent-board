// The board's own server's state on its page (models/server-state.ts, components/server): offered on
// that page only (its domain's login, its own page there), never a phone's pairing or a PC's page,
// whose toolbar, Settings and More stay as they were; the chip's readings, warn from 80 % and
// critical from 90 %, the fullest disk only from 80 %; the poll asks only while someone wants it and
// the page is visible, stops while hidden, asks at the open panel's interval, and no more once the
// board refuses; the panel's sections (no GPU section without one), its bars' levels and what the
// board knows of each process.
import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { SystemView } from '../../src/core/system-state.ts'
import { ApiError } from '../../web/src/api/client.ts'
import { ServerChip } from '../../web/src/components/server/ServerChip.tsx'
import { ServerBody } from '../../web/src/components/server/ServerPanel.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { serverPoll } from '../../web/src/hooks/useServerState.ts'
import {
  bytesText,
  CHIP_MS,
  chipParts,
  chipText,
  createServerPoll,
  isSystemView,
  levelOf,
  offersServer,
  PANEL_MS,
  type PollDeps,
  type ServerPoll,
  uptimeText,
} from '../../web/src/models/server-state.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { toolbarEntries } from '../../web/src/models/toolbar-menu.ts'
import { board, payload, renderInBoard } from './support/board.tsx'
import { type Element, findAll, type Node } from './support/markup.ts'

const t = translator('en')
const ru = translator('ru')
const GiB = 2 ** 30
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

const VIEW: SystemView = {
  at: 1,
  host: 'workbench',
  uptime: 3 * 86400 + 4 * 3600 + 5 * 60,
  cpu: { usage: 25.4, cores: 12, load: [1.26, 1.89, 1.96] },
  memory: {
    total: 24 * GiB,
    used: 8.16 * GiB,
    available: 15.84 * GiB,
    free: 10 * GiB,
    buffersCache: 6.5 * GiB,
    swapTotal: 16 * GiB,
    swapUsed: 0.25 * GiB,
  },
  disks: [
    { mount: '/', device: '/dev/vda3', fs: 'ext4', total: 755 * GiB, used: 227 * GiB, available: 497 * GiB },
    { mount: '/boot', device: '/dev/vda2', fs: 'ext3', total: 1 * GiB, used: 0.25 * GiB, available: 0.66 * GiB },
  ],
  top: {
    cpu: [
      {
        pid: 71,
        name: 'chrome',
        command: 'chrome --type=renderer',
        user: 'agent',
        cpu: 31.5,
        rss: 0.5 * GiB,
        label: { kind: 'browser', display: 100, name: 'Fix the login' },
      },
      {
        pid: 60,
        name: 'claude',
        command: 'claude --resume abc',
        user: 'agent',
        cpu: 10,
        rss: 1.2 * GiB,
        label: { kind: 'session', name: 'Fix the login' },
      },
    ],
    memory: [
      { pid: 1552, name: 'python3', command: 'python3 /app/server.py', user: 'root', cpu: 0, rss: 1.7 * GiB },
      {
        pid: 42,
        name: 'bun',
        command: 'bun src/entrypoints/tui.ts',
        user: 'agent',
        cpu: 2.3,
        rss: 0.16 * GiB,
        label: { kind: 'board' },
      },
      {
        pid: 50,
        name: 'herdr',
        command: 'herdr server',
        user: 'agent',
        cpu: 3.6,
        rss: 0.03 * GiB,
        label: { kind: 'herdr' },
      },
      {
        pid: 70,
        name: 'Xvnc',
        command: 'Xvnc :100',
        user: 'agent',
        cpu: 0,
        rss: 0.02 * GiB,
        label: { kind: 'vnc', display: 100, name: 'Fix the login' },
      },
      {
        pid: 72,
        name: 'ffmpeg',
        command: 'ffmpeg -f x11grab',
        user: 'agent',
        cpu: 0,
        rss: 0.01 * GiB,
        label: { kind: 'video', display: 103 },
      },
    ],
  },
}

/** A poll that holds `view` and asks nothing (the drawing reads its store). */
function holding(view: SystemView | null, error: unknown = null): ServerPoll {
  const poll = createServerPoll({
    get: () => new Promise(() => {}),
    doc: { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    now: () => 0,
  })
  poll.store.set({ view, error, gone: false })
  return poll
}

describe('where it is offered', () => {
  test('the board’s own server’s page: through its domain’s login, and its own page there; not a phone’s pairing', () => {
    const server = { server: true as const }
    expect(offersServer(true, server, () => 'login')).toBe(true)
    expect(offersServer(false, server, () => null)).toBe(true)
    expect(offersServer(true, server, () => 'pair')).toBe(false)
    expect(offersServer(true, server, () => null)).toBe(false)
  })

  test('a PC’s page, local or remote: never, and nothing is read for it', () => {
    let asked = 0
    const auth = () => {
      asked++
      return 'login' as const
    }
    for (const remote of [false, true])
      for (const p of [{}, { server: false }, null, undefined]) expect(offersServer(remote, p, auth)).toBe(false)
    expect(asked).toBe(0)
  })

  test('Settings → Server… only where offered; a PC’s menu as before', () => {
    const base = {
      t,
      theme: 'auto',
      languages: { en: 'English' },
      canEdit: true,
      dock: 'right',
      sleepers: false,
      profiles: false,
      backup: true,
      timeSettings: true,
    } as const
    const ids = (menu: ReturnType<typeof settingsMenu>) => menu.map(e => ('id' in e ? e.id : '-'))
    expect(ids(settingsMenu({ ...base }))).toEqual(ids(settingsMenu({ ...base, server: false })))
    expect(ids(settingsMenu({ ...base })).includes('server')).toBe(false)
    const on = settingsMenu({ ...base, server: true })
    expect(ids(on)).toEqual([...ids(settingsMenu(base))].flatMap(id => (id === 'timeSettings' ? [id, 'server'] : [id])))
    expect(on.find(e => 'id' in e && e.id === 'server')).toMatchObject({ label: 'Server…' })
    expect(ru('set.server')).toBe('Сервер…')
    expect(settingPicked('server')).toEqual({ kind: 'server' })
  })

  test('the toolbar has the chip only when given onServer: a PC’s toolbar is drawn as before', () => {
    const page = serverPoll()
    page.store.set({ view: VIEW, error: null, gone: false })
    try {
      const draw = (onServer?: () => void) =>
        renderInBoard(<Toolbar limitsAnchor={createRef()} onServer={onServer} />, board({ data: payload() }))
      const chips = (nodes: Node[]) => findAll(nodes, el => el.attrs.get('id') === 'server-chip')
      expect(chips(draw()).length).toBe(0)
      expect(JSON.stringify(draw())).toBe(
        JSON.stringify(renderInBoard(<Toolbar limitsAnchor={createRef()} />, board({ data: payload() }))),
      )
      expect(chips(draw(() => {})).length).toBe(1)
    } finally {
      page.store.set({ view: null, error: null, gone: false })
    }
  })

  test('More lists the chip with its own words; with no chip its entry is never listed', () => {
    const base = {
      canMutate: true,
      schedule: { count: 0, due: false },
      tasks: null,
      next: 0,
      usage: '',
      presence: null,
    }
    const entry = (server?: string) =>
      toolbarEntries({ ...base, ...(server !== undefined && { server }) }, t).find(e => e.id === 'server-chip')
    expect(entry('Server: CPU 25% · RAM 34%')).toEqual({ id: 'server-chip', label: 'Server: CPU 25% · RAM 34%' })
    expect(entry()).toEqual({ id: 'server-chip', label: 'Server' })
  })
})

describe('the chip', () => {
  test('levels: warn from 80 %, critical from 90 %', () => {
    expect([levelOf(null), levelOf(0), levelOf(79.9), levelOf(80), levelOf(89.9), levelOf(90), levelOf(100)]).toEqual([
      '',
      '',
      '',
      'warn',
      'warn',
      'crit',
      'crit',
    ])
  })

  test('CPU and RAM; the fullest disk only from 80 %', () => {
    expect(chipText(chipParts(VIEW, t))).toBe('CPU 25% · RAM 34%')
    expect(chipText(chipParts(VIEW, ru))).toBe('CPU 25% · RAM 34%')
    const full = {
      ...VIEW,
      disks: [...VIEW.disks, { mount: '/data', device: '/dev/vdb1', fs: 'xfs', total: 100, used: 92, available: 8 }],
    }
    expect(chipText(chipParts(full, t))).toBe('CPU 25% · RAM 34% · Disk /data 92%')
    const nearly = {
      ...VIEW,
      disks: [{ mount: '/', device: '/dev/vda3', fs: 'ext4', total: 100, used: 79, available: 21 }],
    }
    expect(chipParts(nearly, t).map(p => p.id)).toEqual(['cpu', 'ram'])
    // the first reading has no CPU to say yet
    expect(chipText(chipParts({ ...VIEW, cpu: { usage: null, cores: 12, load: null } }, t))).toBe('CPU — · RAM 34%')
  })

  function chip(view: SystemView | null, error: unknown = null) {
    const nodes = renderInBoard(<ServerChip onOpen={() => {}} poll={holding(view, error)} />, board())
    const button = findAll(nodes, el => el.attrs.get('id') === 'server-chip')[0]
    const figures = button
      ? findAll([button], el => el.tag === 'b').map(b => [text(b.children), b.attrs.get('data-level') ?? ''])
      : []
    return { button, figures }
  }

  test('drawn with its figures, each with its level, the chip with the worst; dimmed while it is not updated', () => {
    const calm = chip(VIEW)
    expect(calm.figures).toEqual([
      ['25%', ''],
      ['34%', ''],
    ])
    expect(calm.button?.attrs.get('data-level')).toBeUndefined()
    expect(calm.button?.attrs.get('aria-label')).toBe('Server: CPU 25% · RAM 34%')
    const busy = {
      ...VIEW,
      cpu: { usage: 93, cores: 12, load: null },
      disks: [{ ...VIEW.disks[0], used: 82, available: 18, total: 100 }],
    }
    const hot = chip(busy as SystemView)
    expect(hot.figures).toEqual([
      ['93%', 'crit'],
      ['34%', ''],
      ['82%', 'warn'],
    ])
    expect(hot.button?.attrs.get('data-level')).toBe('crit')
    expect(chip(VIEW, new Error('offline')).button?.attrs.get('class')).toBe('server-chip stale')
  })

  test('nothing until the first answer', () => {
    expect(chip(null).button).toBeUndefined()
  })
})

/** A poll on a fake page: its timers run by hand, its visibility set by hand. */
function pollWorld(answer: () => Promise<SystemView> = async () => VIEW) {
  let clock = 0
  let next = 1
  const timers = new Map<number, { at: number; run: () => void }>()
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }
  let asks = 0
  const deps: PollDeps = {
    get: () => {
      asks++
      return answer()
    },
    doc: doc as unknown as PollDeps['doc'],
    setTimeout: (run, ms) => {
      const id = next++
      timers.set(id, { at: clock + ms, run })
      return id
    },
    clearTimeout: id => timers.delete(id as number),
    now: () => clock,
  }
  const poll = createServerPoll(deps)
  /** The clock on by `ms`, every timer due on the way run, and the answers it asked for taken. */
  const pass = async (ms: number) => {
    const end = clock + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      clock = Math.max(clock, due[1].at)
      due[1].run()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    clock = end
  }
  const show = (state: DocumentVisibilityState) => {
    doc.visibilityState = state
    for (const fn of [...listeners]) fn()
  }
  return { poll, pass, show, asks: () => asks, timers: () => timers.size, listening: () => listeners.size }
}

describe('the poll', () => {
  test('nobody wants it: no timer, nothing asked, the page’s visibility not listened to', async () => {
    const w = pollWorld()
    await w.pass(60_000)
    expect([w.asks(), w.timers(), w.listening()]).toEqual([0, 0, 0])
  })

  test('the chip: at once, then every CHIP_MS while the page is visible', async () => {
    const w = pollWorld()
    w.poll.want('chip', CHIP_MS)
    await w.pass(0)
    expect(w.asks()).toBe(1)
    expect(w.poll.store.get().view).toBe(VIEW)
    await w.pass(CHIP_MS * 3)
    expect(w.asks()).toBe(4)
  })

  test('hidden: it stops; visible again: it asks at once and goes on', async () => {
    const w = pollWorld()
    w.poll.want('chip', CHIP_MS)
    await w.pass(0)
    w.show('hidden')
    expect(w.timers()).toBe(0)
    await w.pass(CHIP_MS * 10)
    expect(w.asks()).toBe(1)
    w.show('visible')
    await w.pass(0)
    expect(w.asks()).toBe(2)
    await w.pass(CHIP_MS)
    expect(w.asks()).toBe(3)
  })

  test('the panel open: asked at once and every PANEL_MS; closed, back to the chip’s; nobody, nothing', async () => {
    const w = pollWorld()
    w.poll.want('chip', CHIP_MS)
    await w.pass(0)
    await w.pass(1000)
    w.poll.want('panel', PANEL_MS)
    await w.pass(0)
    expect(w.asks()).toBe(2)
    await w.pass(PANEL_MS * 2)
    expect(w.asks()).toBe(4)
    w.poll.want('panel', null)
    await w.pass(PANEL_MS)
    expect(w.asks()).toBe(4)
    await w.pass(CHIP_MS - PANEL_MS)
    expect(w.asks()).toBe(5)
    w.poll.want('chip', null)
    await w.pass(CHIP_MS * 4)
    expect([w.asks(), w.timers(), w.listening()]).toEqual([5, 0, 0])
  })

  test('a failure is kept beside the last answer and it asks on; refused (403, 404, 401): asked no more', async () => {
    let fail: unknown = null
    const w = pollWorld(async () => {
      if (fail) throw fail
      return VIEW
    })
    w.poll.want('chip', CHIP_MS)
    await w.pass(0)
    fail = new Error('offline')
    await w.pass(CHIP_MS)
    expect(w.poll.store.get()).toEqual({ view: VIEW, error: fail, gone: false })
    fail = new ApiError(403, { error: 'local' })
    await w.pass(CHIP_MS)
    expect(w.poll.store.get().gone).toBe(true)
    const asked = w.asks()
    await w.pass(CHIP_MS * 5)
    expect([w.asks(), w.timers()]).toEqual([asked, 0])
  })

  test('GET /api/system’s answer is checked', () => {
    expect(isSystemView(VIEW)).toBe(true)
    expect(isSystemView({ ...VIEW, top: { cpu: [] } })).toBe(false)
    expect(isSystemView({ error: 'local' })).toBe(false)
  })
})

describe('the panel', () => {
  const draw = (view: SystemView | null, error: string | null = null, lang = 'en') => {
    const nodes = renderInBoard(<ServerBody view={view} error={error} />, board(), lang)
    const parts = findAll(nodes, el => el.tag === 'section').map(s => s.attrs.get('data-part'))
    // each bar: what it is of, its figure, its level (the bar's and the figure's)
    const bars = findAll(nodes, el => el.attrs.get('class') === 'server-meter').map(m => {
      const bar = findAll([m], el => el.attrs.get('class') === 'server-bar')[0]
      const pct = findAll([m], el => el.attrs.get('class') === 'server-pct')[0]
      const level = bar?.attrs.get('data-level') ?? ''
      expect(pct?.attrs.get('data-level') ?? '').toBe(level)
      return [m.attrs.get('data-of'), pct ? text(pct.children) : null, level]
    })
    const labels = findAll(nodes, el => el.attrs.get('class') === 'server-label').map(l => [
      l.attrs.get('data-kind'),
      text(l.children),
    ])
    return { all: text(nodes), parts, bars, labels, nodes }
  }

  test('CPU, memory and swap, each disk, the two top lists; no GPU section without a GPU', () => {
    const r = draw(VIEW)
    expect(r.parts).toEqual(['cpu', 'memory', 'disks', 'top-cpu', 'top-memory'])
    expect(r.bars).toEqual([
      ['CPU', '25%', ''],
      ['Memory', '34%', ''],
      ['Swap', '2%', ''],
      ['/', '31%', ''],
      ['/boot', '28%', ''],
    ])
    for (const words of [
      '12 cores',
      'load average 1.26 · 1.89 · 1.96',
      'total 24 GiB',
      'used 8.2 GiB',
      'available 15.8 GiB',
      'buffers and cache 6.5 GiB',
      '/dev/vda3 · ext4',
      'total 755 GiB',
      'used 227 GiB',
      'available 497 GiB',
      'Most CPU',
      'Most memory',
      'chrome --type=renderer',
      'root · pid 1552',
      '31.5%',
    ])
      expect([words, r.all.includes(words)]).toEqual([words, true])
  })

  test('what the board knows of each process: a session, a desktop’s browser, Xvnc and video, the board, herdr', () => {
    expect(draw(VIEW).labels).toEqual([
      ['browser', 'browser :100 · Fix the login'],
      ['session', 'Fix the login'],
      ['board', 'the board'],
      ['herdr', 'herdr'],
      ['vnc', 'desktop :100 · Fix the login'],
      ['video', 'video :103'],
    ])
    expect(draw(VIEW, null, 'ru').labels[0]).toEqual(['browser', 'браузер :100 · Fix the login'])
  })

  test('a GPU: its section with its load, memory and temperature', () => {
    const gpu = { name: 'NVIDIA L4', utilization: 91, memoryUsed: 2 * GiB, memoryTotal: 24 * GiB, temperature: 45 }
    const r = draw({ ...VIEW, gpu: [gpu] })
    expect(r.parts).toEqual(['cpu', 'memory', 'disks', 'gpu', 'top-cpu', 'top-memory'])
    expect(r.bars.slice(-2)).toEqual([
      ['NVIDIA L4: load', '91%', 'crit'],
      ['NVIDIA L4: Memory', '8%', ''],
    ])
    expect(r.all).toContain('load 91%')
    expect(r.all).toContain('memory 2 GiB of 24 GiB')
    expect(r.all).toContain('45 °C')
  })

  test('bars at their levels; no swap; the first reading', () => {
    const r = draw({
      ...VIEW,
      cpu: { usage: null, cores: 1, load: null },
      memory: { ...(VIEW.memory as NonNullable<SystemView['memory']>), used: 21.6 * GiB, swapTotal: 0, swapUsed: 0 },
      disks: [{ mount: '/', device: '/dev/vda3', fs: 'ext4', total: 100, used: 85, available: 15 }],
      top: { cpu: [], memory: VIEW.top.memory },
    })
    expect(r.bars).toEqual([
      ['CPU', '—', ''],
      ['Memory', '90%', 'crit'],
      ['/', '85%', 'warn'],
    ])
    expect(r.all).toContain('No swap')
    expect(r.all).toContain('1 core')
    expect(r.all).toContain('Measured at the next reading')
    expect(r.all).toContain('Shown from the next reading.')
  })

  test('while asked, a failure with no answer yet, and one beside the last answer', () => {
    expect(draw(null).all).toContain('Reading the server’s state…')
    expect(draw(null, 'status 500').all).toContain('Could not read the server’s state: status 500')
    const stale = draw(VIEW, 'offline')
    expect(stale.all).toContain('Not updated: offline')
    expect(stale.parts.length).toBe(5)
    // read only: not one button
    expect(findAll(draw(VIEW).nodes, (el: Element) => el.tag === 'button')).toEqual([])
  })

  test('human units and the uptime, in both languages', () => {
    expect([
      bytesText(0, t),
      bytesText(512, t),
      bytesText(1536, t),
      bytesText(512 * 2 ** 20, t),
      bytesText(23.44 * GiB, t),
    ]).toEqual(['0 B', '512 B', '1.5 KiB', '512 MiB', '23.4 GiB'])
    expect(bytesText(23.44 * GiB, ru)).toBe('23,4 ГБ')
    expect(bytesText(3.5 * 2 ** 40, t)).toBe('3.5 TiB')
    expect([uptimeText(VIEW.uptime ?? 0, t), uptimeText(3600 * 5 + 60 * 7, t), uptimeText(59 * 60, t)]).toEqual([
      '3 days 4 h',
      '5 h 7 min',
      '59 min',
    ])
    expect(uptimeText(86400 * 21 + 3600, ru)).toBe('21 день 1 ч')
  })
})
