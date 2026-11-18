// A finger on a menu over the cards (#432): the click a tap makes comes after its release and goes
// to what is under the finger by then, so a pick that takes the menu away must not let it through
// to the card under it; a tap outside only closes the menu. A mouse acts as before.
import { describe, expect, test } from 'bun:test'
import { type ClickSource, pressAway } from '../../web/src/models/click-away.ts'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import { reactMenuSide } from './support/menu-sides.tsx'
import { asDom } from './support/react-commit.ts'

const ITEMS: MenuEntry[] = [
  { id: 'time', label: 'Time' },
  { id: 'lane', label: 'Lane', checked: false, keep: true },
]

/** The menu open over a "card" (the page's #outside) that opens on a click, as Board.tsx's do. */
async function overCard(source: 'touch' | 'mouse') {
  const side = reactMenuSide()
  const card = side.page('outside')
  asDom(card).addEventListener('click', () => side.log.push('card opened'))
  await side.open(ITEMS, { x: 100, y: 100, source, origin: 'opener' })
  await side.world.tick(400) // a tap well after it opened, not the release of the press that did
  await side.world.settle()
  const item = (i: number) => {
    const el = side.levels()[0]?.querySelector(`[data-i="${i}"]`)
    if (!el) throw new Error(`no item ${i}`)
    return el
  }
  return { side, card, item }
}

describe('a tap on a menu item over a card', () => {
  test('runs the item; the click after it does not open the card under the menu', async () => {
    const { side, card, item } = await overCard('touch')
    try {
      await side.world.fire(item(0), 'pointerdown', { pointerType: 'touch' })
      await side.world.fire(item(0), 'pointerup', { pointerType: 'touch' })
      // The menu went with the pick (pointer-events: none as it fades): the click lands on the card.
      await side.world.fire(card, 'click', { pointerType: 'touch' })
      expect(side.log.filter(l => l !== 'changed')).toEqual(['picked time'])
      expect(side.isOpen()).toBe(false)
      // Only that one click: the next tap on the card opens it.
      await side.world.tick(50)
      await side.world.fire(card, 'click', { pointerType: 'touch' })
      expect(side.log.at(-1)).toBe('card opened')
    } finally {
      await side.dispose()
    }
  })

  test('a check that keeps the menu open spends nothing: its click is on the menu', async () => {
    const { side, card, item } = await overCard('touch')
    try {
      await side.world.fire(item(1), 'pointerdown', { pointerType: 'touch' })
      await side.world.fire(item(1), 'pointerup', { pointerType: 'touch' })
      expect(side.isOpen()).toBe(true)
      await side.world.fire(item(1), 'click', { pointerType: 'touch' })
      // A press outside closes it and is spent on that.
      await side.world.fire(card, 'pointerdown', { pointerType: 'touch' })
      await side.world.fire(card, 'click', { pointerType: 'touch' })
      expect(side.log.filter(l => l !== 'changed')).toEqual(['picked lane'])
      expect(side.isOpen()).toBe(false)
    } finally {
      await side.dispose()
    }
  })

  test('with a mouse as before: the pick runs and the next click on a card opens it', async () => {
    const { side, card, item } = await overCard('mouse')
    try {
      await side.world.fire(item(0), 'pointerdown')
      await side.world.fire(item(0), 'pointerup')
      await side.world.fire(card, 'click')
      expect(side.log.filter(l => l !== 'changed')).toEqual(['picked time', 'card opened'])
    } finally {
      await side.dispose()
    }
  })
})

describe('a press outside a popover (the usage pill, the setup note)', () => {
  function source() {
    const listeners = new Set<(e: Event) => void>()
    const on: ClickSource = {
      addEventListener: (_type, fn) => void listeners.add(fn),
      removeEventListener: (_type, fn) => void listeners.delete(fn),
    }
    const click = () => {
      const e = { prevented: false, stopped: false }
      const event = {
        preventDefault: () => void (e.prevented = true),
        stopImmediatePropagation: () => void (e.stopped = true),
      } as unknown as Event
      for (const fn of [...listeners]) fn(event)
      return e
    }
    return { on, click, listeners }
  }

  test("a finger's spends the click that follows it, that one only", () => {
    let now = 1000
    const s = source()
    pressAway({ pointerType: 'touch' }, s.on, () => now)
    now += 120
    expect(s.click()).toEqual({ prevented: true, stopped: true })
    expect(s.click()).toEqual({ prevented: false, stopped: false })
    expect(s.listeners.size).toBe(0)
  })

  test("a mouse's click acts as before; a click long after the press is not spent", () => {
    let now = 1000
    const s = source()
    pressAway({ pointerType: 'mouse' }, s.on, () => now)
    expect(s.listeners.size).toBe(0)
    pressAway({ pointerType: 'pen' }, s.on, () => now)
    now += 700
    expect(s.click()).toEqual({ prevented: false, stopped: false })
    expect(s.listeners.size).toBe(0)
  })
})
