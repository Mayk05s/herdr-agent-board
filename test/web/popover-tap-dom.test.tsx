// The usage popover on a real DOM (jsdom, #432): a finger's press outside it closes it and spends
// the click that follows, so the card under the finger does not open too; a mouse's click acts as
// before. Events are invented; pointerdown is a plain Event with the pointer's fields set on it.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createRef } from 'react'
import type { Root } from 'react-dom/client'
import type { BoardAction } from '../../web/src/state/board-ui.ts'
import { board, payload } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let LimitsPop: typeof import('../../web/src/components/LimitsPop.tsx').LimitsPop
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext

const dom = new JSDOM(
  '<!doctype html><html><body><button id="limits"></button><div class="card" id="card"></div><div id="root"></div></body></html>',
  {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  },
)
const g = globalThis as Record<string, unknown>
const win = dom.window as unknown as Record<string, unknown> & typeof globalThis
const NAMES = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'matchMedia',
  'addEventListener',
  'removeEventListener',
  'innerWidth',
  'innerHeight',
  'IS_REACT_ACT_ENVIRONMENT',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const set = (name: string, value: unknown) =>
  Object.defineProperty(g, name, { value, configurable: true, writable: true })

beforeAll(async () => {
  for (const k of NAMES) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'])
    set(k, win[k])
  // The component listens on the window: jsdom's, where the events go.
  set('addEventListener', dom.window.addEventListener.bind(dom.window))
  set('removeEventListener', dom.window.removeEventListener.bind(dom.window))
  set('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
  set('innerWidth', 390)
  set('innerHeight', 844)
  set('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  ;({ LimitsPop } = await import('../../web/src/components/LimitsPop.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
})

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else Reflect.deleteProperty(g, k)
  }
  dom.window.close()
})

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
})

/** The popover open over the card; what it dispatched, and what the card heard. */
async function open() {
  const actions: BoardAction[] = []
  const heard: string[] = []
  const card = document.getElementById('card') as HTMLElement
  const onClick = () => heard.push('card opened')
  card.addEventListener('click', onClick)
  const anchor = createRef<HTMLButtonElement>()
  ;(anchor as { current: HTMLButtonElement | null }).current = document.getElementById('limits') as HTMLButtonElement
  const value = board({ data: payload({}), ui: { limitsOpen: true }, dispatch: a => void actions.push(a) })
  root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () =>
    root?.render(
      <I18nProvider lang="en">
        <BoardContext.Provider value={value}>
          <LimitsPop anchor={anchor} />
        </BoardContext.Provider>
      </I18nProvider>,
    ),
  )
  const tap = async (pointerType: string) => {
    const down = new dom.window.Event('pointerdown', { bubbles: true, cancelable: true })
    Object.assign(down, { pointerType, button: 0 })
    await act(async () => void card.dispatchEvent(down))
    await act(
      async () => void card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })),
    )
  }
  return { actions, heard, tap, done: () => card.removeEventListener('click', onClick) }
}

test("a finger's tap outside closes the popover and does not open the card under it", async () => {
  const s = await open()
  try {
    await s.tap('touch')
    expect(s.actions).toEqual([{ type: 'limits', open: false }])
    expect(s.heard).toEqual([])
  } finally {
    s.done()
  }
})

test("a mouse's click outside closes it and opens the card, as before", async () => {
  const s = await open()
  try {
    await s.tap('mouse')
    expect(s.actions).toEqual([{ type: 'limits', open: false }])
    expect(s.heard).toEqual(['card opened'])
  } finally {
    s.done()
  }
})
