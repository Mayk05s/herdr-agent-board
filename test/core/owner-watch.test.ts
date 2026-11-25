// What waits on the owner and the line a session hears of it (#434, core/owner-watch.ts).
import { expect, test } from 'bun:test'
import { cardsWaiting, ownerLine, threadsWaiting, toldOf, waitingFor } from '../../src/core/owner-watch.ts'
import type { Item } from '../../src/core/types.ts'
import type { Party, ThreadHead, Watch } from '../../src/core/work-threads.ts'

const day: Party = { kind: 'session', key: 'day-1', name: 'day' }
const anna: Party = { kind: 'session', key: 'anna-1', name: 'anna' }
const head = (over: Partial<ThreadHead> = {}): ThreadHead =>
  ({
    id: 't1',
    key: 'atlas-1',
    lane: 'atlas',
    title: 'Import mapping',
    summary: '',
    status: 'owner',
    waitingOn: 'Pick v2 or v3',
    proposed: null,
    assignee: null,
    parent: null,
    scope: 'local',
    createdBy: anna,
    createdAt: 0,
    updatedAt: 0,
    doneAt: null,
    rev: 1,
    ...over,
  }) as ThreadHead
const watch = (over: Partial<Watch>): Watch => ({
  session: 'day-1',
  name: 'day',
  target: 'owner',
  what: 'status',
  idle: false,
  wake: false,
  since: 0,
  ...over,
})

test('more than three changes: three spelled out, then how many more', () => {
  const now = toldOf(['a', 'b', 'c', 'd', 'e'].map(n => ({ id: `card:${n}`, who: n, text: `q ${n}` })))
  expect(ownerLine({}, now)).toBe('a asks the owner: q a · b asks the owner: q b · c asks the owner: q c · and 2 more')
  expect(ownerLine(now, {})).toBe('a: settled · b: settled · c: settled · and 2 more')
})

test("a shared thread's words never go in; a local one says what it waits on", () => {
  const shared = head({ scope: { kind: 'shared' } as unknown as ThreadHead['scope'] })
  expect(threadsWaiting([{ head: shared, ask: 'peer words' }])[0]?.text).toBe('')
  expect(threadsWaiting([{ head: head(), ask: '' }])[0]?.text).toBe('Pick v2 or v3')
})

test('a thread someone else set to the owner reaches its assignee; one it put there itself does not', () => {
  const assigned = head({ assignee: day })
  const answersOnly = [watch({}), watch({ target: 't1', what: 'answers' })]
  expect(waitingFor(threadsWaiting([{ head: assigned, ask: '', by: anna }]), 'day-1', answersOnly)).toHaveLength(1)
  expect(waitingFor(threadsWaiting([{ head: assigned, ask: '', by: day }]), 'day-1', answersOnly)).toHaveLength(0)
  // A lane watch that hears status changes hears it already.
  const lane = [watch({}), watch({ target: 'lane:atlas' })]
  expect(waitingFor(threadsWaiting([{ head: head(), ask: '', by: anna }]), 'day-1', lane)).toHaveLength(0)
})

test('a card is told by its name with its ask; its own card never', () => {
  const items = [
    { key: 'anna-1', session: 'anna-1', name: 'anna', attention: 'ask', question: 'Ship it?' },
    { key: 'day-1', session: 'day-1', name: 'day', attention: 'ask', question: 'End the day?' },
  ] as unknown as Item[]
  const all = cardsWaiting(items, new Map())
  expect(waitingFor(all, 'day-1', [watch({})]).map(w => [w.who, w.text])).toEqual([['anna', 'Ship it?']])
})
