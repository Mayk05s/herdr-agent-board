// A phone's on-screen keyboard over the board (hooks/usePhoneKeyboard.ts, styles/pwa.css). A phone's
// browser leaves the page's own height as it is while the keyboard is up and shrinks only what shows
// of it (the visual viewport), and it slides what shows down the page to the field typed in: the
// session sheet, fixed to the page's height, then runs on under the keyboard, and what it shows
// jumps as the browser slides. So, while the keyboard is up, the sheet takes what shows: its top
// where what shows starts, its height what shows of it.

/** What the browser says shows of the page (window.visualViewport). */
export interface VisibleArea {
  width: number
  height: number
  /** How far down the page what shows starts. */
  offsetTop: number
  /** Pinch zoom: 1 when none. */
  scale: number
}

export interface KeyboardView {
  /** A keyboard covers part of the screen. */
  up: boolean
  /** What shows of the page, in the page's pixels unzoomed. */
  height: number
  /** Where what shows starts on the page. */
  top: number
}

/**
 * Lost more than this many pixels, the screen has a keyboard over it: a browser's bars that come
 * and go as the page scrolls take less, a phone's keyboard far more (with its bar of suggestions).
 */
export const KEYBOARD_MIN = 150

/** Zoomed in more than this, the user pinched: where what shows starts is where they went, not the keyboard. */
const ZOOMED = 1.01

/**
 * The keyboard from what shows, one change after another. What shows without a keyboard is the
 * most that showed at this width (a turn of the phone starts over), or the page's own height when
 * that is more.
 */
export class KeyboardWatch {
  private full = 0
  private width = -1
  private top = 0

  next(area: VisibleArea, page: { width: number; height: number }): KeyboardView {
    if (page.width !== this.width) {
      this.width = page.width
      this.full = 0
    }
    const scale = area.scale > 0 ? area.scale : 1
    // Zoomed, what shows is a part of the page as big as the screen less the keyboard, unzoomed.
    const height = Math.round(area.height * scale)
    this.full = Math.max(this.full, height, page.height)
    // Pinched in, what shows moves with the fingers: the sheet stays where the keyboard put it.
    if (scale <= ZOOMED) this.top = Math.max(0, Math.round(area.offsetTop))
    const up = this.full - height > KEYBOARD_MIN
    return { up, height, top: up ? this.top : 0 }
  }
}
