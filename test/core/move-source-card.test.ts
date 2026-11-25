// #642: the source card a move left awake. core/node-items.ts dropMovedCards drops it from the
// master's merged payload by the `movedTo` mark its own board wrote (services/move-out.ts finish),
// not by weighing two machines' clocks; services/board.ts carries the card's `moved` as `movedTo`,
// and core/agent-send.ts targetsOf answers the same way.
import { expect, test } from 'bun:test'
import { dropMovedCards } from '../../src/core/node-items.ts'
import type { Item } from '../../src/core/types.ts'

const SID = '1f0e3c1a-5b7d-4c2e-9a10-3c4b5d6e7f80'

/** A card of the merged payload: this computer's when `device` is unset, a node's with it. */
const card = (more: Partial<Item> & { key: string }): Item =>
  ({
    session: SID,
    pane: 'w1:p1',
    workspace: null,
    cwd: '/w/atlas',
    status: 'idle',
    name: 'Legacy-master',
    autoName: '',
    category: 'other',
    categorySet: false,
    column: 'idle',
    attention: '',
    activity: 100,
    ...more,
  }) as Item

const keys = (items: readonly Item[], masterId = ''): string[] => dropMovedCards(items, masterId).map(i => i.key)

// The issue's shape: `board move Legacy-master --device server-2` on the laptop; the master's
// payload holds the laptop's awake card (no device, status done) beside server-2's, and the
// laptop's clock runs behind, so #641's activity weigh cannot decide. The mark decides.
const laptop = (more: Partial<Item> = {}) => card({ key: SID, status: 'done', activity: 100, ...more })
const atServer2 = (more: Partial<Item> = {}) =>
  card({ key: `@server-2:${SID}`, device: 'server-2', pane: 'n1:p1', activity: 90, ...more })

test('a source card marked movedTo leaves once the session has a card on that device, whatever either clock says', () => {
  expect(keys([laptop({ movedTo: 'server-2' }), atServer2()])).toEqual([`@server-2:${SID}`])
  // The same with the node's card older by the clock: still only the mark weighs.
  expect(keys([laptop({ movedTo: 'server-2', activity: 500 }), atServer2({ activity: 1 })])).toEqual([
    `@server-2:${SID}`,
  ])
})

test('a marked card stays while no card of its session is on the device it moved to', () => {
  // An offline node, or a move that never landed: the source card is all the board has.
  expect(keys([laptop({ movedTo: 'server-2' })])).toEqual([SID])
  // A moved-on card: server-2's source stays while only server-3 runs the session now.
  expect(
    keys([
      laptop({ movedTo: 'server-2' }),
      atServer2({ movedTo: 'server-3' }),
      card({ key: '@server-3:' + SID, device: 'server-3', pane: 'n2:p1' }),
    ]),
  ).toEqual([`@server-3:${SID}`])
  // server-2 still shows a card of the session, so the laptop's is gone; server-2's own source
  // stays, as nothing runs on server-3 yet.
  expect(keys([laptop({ movedTo: 'server-2' }), atServer2({ movedTo: 'server-3' })])).toEqual([`@server-2:${SID}`])
})

test('a move back names the master by its id, which its own cards carry no device under', () => {
  // server-2's card marked movedTo 'laptop': the session runs on the master again.
  expect(keys([atServer2({ movedTo: 'laptop' }), laptop()], 'laptop')).toEqual([SID])
  // No card of it here: the marked node card stays.
  expect(keys([atServer2({ movedTo: 'laptop' })], 'laptop')).toEqual([`@server-2:${SID}`])
})

test('cards with no mark, and cards without a session id, are left exactly as they came', () => {
  const a = laptop()
  const b = atServer2()
  expect(keys([a, b])).toEqual([SID, `@server-2:${SID}`])
  // A pane-keyed card of no session: never compared.
  expect(keys([card({ key: 'pane-w1:p9', session: null, movedTo: 'server-2' }), b])).toEqual([
    'pane-w1:p9',
    `@server-2:${SID}`,
  ])
  // A session other cards share nothing with: order and count kept.
  const other = card({ key: 'x'.repeat(36), session: 'x'.repeat(36), name: 'other' })
  expect(keys([laptop({ movedTo: 'server-2' }), atServer2(), other])).toEqual([`@server-2:${SID}`, other.key])
})

test('#642 fix: a sleeping destination card does not drop the awake source', () => {
  // The session came back on the master while server-2's card sleeps: dropMovedCards must keep
  // the awake source, or the master's payload hides the only card that can answer.
  // The awake source stays; the node's sleeping card stays listed too, but the source is targetable.
  expect(keys([laptop({ movedTo: 'server-2', activity: 500 }), atServer2({ sleeping: true, activity: 1 })])).toEqual([
    SID,
    `@server-2:${SID}`,
  ])
  // Both asleep: the mark still hides the source, as collect() does.
  expect(keys([laptop({ movedTo: 'server-2', sleeping: true }), atServer2({ sleeping: true })])).toEqual([
    `@server-2:${SID}`,
  ])
})
