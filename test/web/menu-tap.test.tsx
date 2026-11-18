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
  { id: 'move', label: 'Move to', submenu: [{ id: 'cat:acme', label: 'Acme' }] },
]

/** The menu open over a "card" (the page's #outside) that opens on a click, as Board.tsx's do. */
async function overCard(source: 'touch' | 'mouse') {
  const side = reactMenuSide()
  const card = side.page('outside')
  asDom(card).addEventListener('click', () => side.log.push('card opened'))
  await side.open(ITEMS, { x: 100, y: 100, source, origin: 'opener' })
  await side.world.tick(400) // a tap well after it opened, not the release of the press that did
  await side.world.settle()
  const item = (i: number, level = 0) => {
    const el = side.levels()[level]?.querySelector(`[data-i="${i}"]`)
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

  test('a check that keeps the menu open, or an item that opens a submenu, spends nothing: its click is on the menu', async () => {
    const { side, card, item } = await overCard('touch')
    try {
      const tap = async (el: ReturnType<typeof item>) => {
        asDom(el).addEventListener('click', () => side.log.push(`click on ${el.id}`))
        await side.world.fire(el, 'pointerdown', { pointerType: 'touch' })
        await side.world.fire(el, 'pointerup', { pointerType: 'touch' })
        await side.world.fire(el, 'click', { pointerType: 'touch' })
      }
      await tap(item(1))
      await tap(item(2))
      await side.world.settle()
      expect(side.levels().length).toBe(2)
      expect(side.log.filter(l => l !== 'changed')).toEqual(['picked lane', 'click on menu-1-1', 'click on menu-1-2'])
      // A pick in the submenu takes both levels away: that click is spent.
      await side.world.fire(item(0, 1), 'pointerdown', { pointerType: 'touch' })
      await side.world.fire(item(0, 1), 'pointerup', { pointerType: 'touch' })
      await side.world.fire(card, 'click', { pointerType: 'touch' })
      expect(side.log.filter(l => l !== 'changed').slice(3)).toEqual(['picked cat:acme'])
      expect(side.isOpen()).toBe(false)
    } finally {
      await side.dispose()
    }
  })

  test('a tap outside closes it and does nothing else; a click long after a pick is not spent', async () => {
    const { side, card, item } = await overCard('touch')
    try {
      await side.world.fire(card, 'pointerdown', { pointerType: 'touch' })
      await side.world.fire(card, 'click', { pointerType: 'touch' })
      expect([side.isOpen(), side.log.includes('card opened')]).toEqual([false, false])
      await side.open(ITEMS, { x: 100, y: 100, source: 'touch', origin: 'opener' })
      await side.world.tick(400)
      await side.world.fire(item(0), 'pointerdown', { pointerType: 'touch' })
      await side.world.fire(item(0), 'pointerup', { pointerType: 'touch' })
      await side.world.tick(700) // no click came (the finger moved off); the next tap acts
      await side.world.fire(card, 'click', { pointerType: 'touch' })
      expect(side.log.filter(l => l !== 'changed')).toEqual(['picked time', 'card opened'])
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
        preventDefault: () => {
          e.prevented = true
        },
        stopImmediatePropagation: () => {
          e.stopped = true
        },
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
