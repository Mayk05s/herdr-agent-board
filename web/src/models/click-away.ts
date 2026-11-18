// Classify the press before a click handler can replace its DOM subtree.

/** What the classification reads of a pointer event (a DOM event, or a stand-in in the tests). */
export interface PressEvent {
  button?: number
  clientX: number
  clientY: number
  target: unknown
  composedPath?: () => unknown[]
}

export interface Press {
  x: number
  y: number
  /** The press was inside the kept area. */
  kept: boolean
  /** It only put a menu away. */
  menu: boolean
}

type Matcher = { matches: (selector: string) => unknown }
type Closer = { closest: (selector: string) => unknown }

function isMatcher(node: unknown): node is Matcher {
  return typeof node === 'object' && node !== null && 'matches' in node && typeof node.matches === 'function'
}

function isCloser(node: unknown): node is Closer {
  return typeof node === 'object' && node !== null && 'closest' in node && typeof node.closest === 'function'
}

export function eventWithin(event: Pick<PressEvent, 'target' | 'composedPath'>, selector: string): boolean {
  return (
    !!event.composedPath?.().some(node => isMatcher(node) && node.matches(selector)) ||
    (isCloser(event.target) && !!event.target.closest(selector))
  )
}

export function panelPress(event: PressEvent, selector: string, menu = false): Press | null {
  return event.button === 0 ? { x: event.clientX, y: event.clientY, kept: eventWithin(event, selector), menu } : null
}

/** What pressAway listens on: the window, or a stand-in in the tests. */
export interface ClickSource {
  addEventListener(type: 'click', listener: (e: Event) => void, capture: boolean): void
  removeEventListener(type: 'click', listener: (e: Event) => void, capture: boolean): void
}

/**
 * A popover put away by a press outside it: a finger's press also spends the click that follows,
 * which would otherwise open what is under it, a card say (#432), as a press outside a menu does
 * (components/menu/menu-engine.ts). A mouse's click acts, as before.
 */
export function pressAway(
  event: { pointerType?: string },
  on: ClickSource,
  now: () => number = () => performance.now(),
): void {
  if (!event.pointerType || event.pointerType === 'mouse') return
  const until = now() + 600
  const click = (e: Event) => {
    on.removeEventListener('click', click, true)
    if (now() > until) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  on.addEventListener('click', click, true)
}

export function outsidePanelPress(down: Press | null, click: PressEvent, selector: string): boolean {
  return (
    !!down &&
    !down.menu &&
    !down.kept &&
    Math.hypot(click.clientX - down.x, click.clientY - down.y) <= 6 &&
    !eventWithin(click, selector)
  )
}
