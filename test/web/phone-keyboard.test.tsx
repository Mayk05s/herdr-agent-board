// A phone's keyboard over the board (web/src/models/phone-keyboard.ts, hooks/usePhoneKeyboard.ts):
// what shows above it, where the browser slid what shows to, and only that, is the sheet's while it
// is up; a browser's bars coming and going, a pinch zoom and a turn of the phone are no keyboard.
// The marks on <html> come only on a phone's page in the hand: on the computer, on a tablet and on
// the board on 127.0.0.1 nothing listens to what shows and nothing is marked.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { KEYBOARD_MIN, KeyboardWatch } from '../../web/src/models/phone-keyboard.ts'

const PAGE = { width: 390, height: 844 }
const area = (height: number, offsetTop = 0, scale = 1, width = 390) => ({ width, height, offsetTop, scale })

describe('the keyboard from what shows', () => {
  test('the page whole, then the bars that come and go: no keyboard', () => {
    const watch = new KeyboardWatch()
    expect(watch.next(area(844), PAGE)).toEqual({ up: false, height: 844, top: 0 })
    expect(watch.next(area(764, 40), PAGE)).toEqual({ up: false, height: 764, top: 0 })
    expect(watch.next(area(844 - KEYBOARD_MIN), PAGE).up).toBe(false)
    expect(watch.next(area(844 - KEYBOARD_MIN - 1), PAGE).up).toBe(true)
  })

  test('the keyboard up: what shows above it, from where the browser slid it to; down again, as it was', () => {
    const watch = new KeyboardWatch()
    watch.next(area(844), PAGE)
    expect(watch.next(area(430, 300), PAGE)).toEqual({ up: true, height: 430, top: 300 })
    // Typing on, the browser slides a little further.
    expect(watch.next(area(430, 320), PAGE)).toEqual({ up: true, height: 430, top: 320 })
    expect(watch.next(area(844), PAGE)).toEqual({ up: false, height: 844, top: 0 })
  })

  test('a browser that shrinks the page itself with the keyboard: still a keyboard, by the most that showed', () => {
    const watch = new KeyboardWatch()
    watch.next(area(844), PAGE)
    expect(watch.next(area(430), { width: 390, height: 430 })).toEqual({ up: true, height: 430, top: 0 })
  })

  test('a pinch zoom is no keyboard; pinched with the keyboard up, the sheet stays where the keyboard put it', () => {
    const watch = new KeyboardWatch()
    watch.next(area(844), PAGE)
    // Twice as big: half the page shows, over the whole screen.
    expect(watch.next(area(422, 250, 2), PAGE)).toEqual({ up: false, height: 844, top: 0 })
    watch.next(area(844), PAGE)
    expect(watch.next(area(430, 300), PAGE)).toEqual({ up: true, height: 430, top: 300 })
    expect(watch.next(area(215, 400, 2), PAGE)).toEqual({ up: true, height: 430, top: 300 })
  })

  test('a turn of the phone starts over: the other way round, what shows whole is less', () => {
    const watch = new KeyboardWatch()
    watch.next(area(844), PAGE)
    expect(watch.next(area(390, 0, 1, 844), { width: 844, height: 390 })).toEqual({ up: false, height: 390, top: 0 })
  })
})

// ---------------------------------------------------------------- the marks on <html>

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'matchMedia',
  'visualViewport',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
let createRoot: typeof import('react-dom/client').createRoot
let usePhoneKeyboard: typeof import('../../web/src/hooks/usePhoneKeyboard.ts').usePhoneKeyboard
let PHONE_TOUCH_QUERY = ''

/** What shows of the page, as the browser's window.visualViewport: it says when it changes. */
class FakeArea extends dom.window.EventTarget {
  width = 390
  height = 844
  offsetTop = 0
  scale = 1
  listeners = 0
  override addEventListener(...args: Parameters<EventTarget['addEventListener']>) {
    this.listeners++
    super.addEventListener(...args)
  }
  override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>) {
    this.listeners--
    super.removeEventListener(...args)
  }
  show(height: number, offsetTop: number) {
    this.height = height
    this.offsetTop = offsetTop
    this.dispatchEvent(new dom.window.Event('resize'))
  }
}

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ usePhoneKeyboard, PHONE_TOUCH_QUERY } = await import('../../web/src/hooks/usePhoneKeyboard.ts'))
})

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

function Probe() {
  usePhoneKeyboard()
  return null
}

/** The board's page as `setup` has it (a phone's in the hand matches PHONE_TOUCH_QUERY), with the hook drawn. */
async function page(setup: { remote: boolean; matches: (query: string) => boolean }) {
  const html = dom.window.document.documentElement
  html.toggleAttribute('data-remote', setup.remote)
  const shown = new FakeArea()
  g.visualViewport = shown
  g.matchMedia = (query: string) => ({ matches: setup.matches(query), addEventListener() {}, removeEventListener() {} })
  const root = createRoot(dom.window.document.getElementById('root') as unknown as HTMLElement)
  await act(async () => root.render(<Probe />))
  const marks = () => ({
    keyboard: html.hasAttribute('data-keyboard'),
    height: html.style.getPropertyValue('--vv-height'),
    top: html.style.getPropertyValue('--vv-top'),
  })
  return { shown, marks, unmount: () => act(async () => root.unmount()) }
}

describe('the keyboard marks on <html>', () => {
  test("a phone's page in the hand: what shows, the keyboard up and down; nothing left once gone", async () => {
    const { shown, marks, unmount } = await page({ remote: true, matches: q => q === PHONE_TOUCH_QUERY })
    expect(marks()).toEqual({ keyboard: false, height: '844px', top: '0px' })
    await act(async () => shown.show(430, 300))
    expect(marks()).toEqual({ keyboard: true, height: '430px', top: '300px' })
    await act(async () => shown.show(844, 0))
    expect(marks()).toEqual({ keyboard: false, height: '844px', top: '0px' })
    await unmount()
    expect(marks()).toEqual({ keyboard: false, height: '', top: '' })
    expect(shown.listeners).toBe(0)
  })

  for (const [where, setup] of [
    ['the computer through the domain', { remote: true, matches: () => false }],
    ['a tablet (a finger, a wide screen)', { remote: true, matches: (q: string) => q === '(pointer: coarse)' }],
    ['the board on 127.0.0.1', { remote: false, matches: (q: string) => q === PHONE_TOUCH_QUERY }],
  ] as const)
    test(`${where}: nothing listens to what shows, nothing is marked`, async () => {
      const { shown, marks, unmount } = await page(setup)
      expect(shown.listeners).toBe(0)
      await act(async () => shown.show(430, 300))
      expect(marks()).toEqual({ keyboard: false, height: '', top: '' })
      await unmount()
    })
})
