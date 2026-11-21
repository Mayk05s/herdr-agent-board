// Settings' feature switches (#596): Watches, Decisions (with whether a default may answer) and Away
// journal after Threads, Case files and Verified done under Threads while threads are on; each Off or
// On as the payload says it, with one line on what it does, in English and Russian; what a pick asks
// the board for; the page's own gear (hooks/useSettingsMenu.ts) offering them on the local board's
// page only; and a menu with none of them given as it was.
import { afterEach, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { MenuItem } from '../../web/src/components/menu/MenuItem.tsx'
import type { MenuEngine } from '../../web/src/components/menu/menu-engine.ts'
import {
  type FeatureSetting,
  settingsMenuFrom,
  type ThreadsSetting,
  useSettingsMenu,
} from '../../web/src/hooks/useSettingsMenu.ts'
import type { MenuEntry } from '../../web/src/models/menu-model.ts'
import { featuresNow, type SettingsNow, settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { watchView } from '../../web/src/models/watch.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { findAll, reactMarkup } from './support/markup.ts'

afterEach(restoreFetch)

const en = translator('en')
const ru = translator('ru')
const now: SettingsNow = {
  t: en,
  theme: 'auto',
  languages: { en: 'English' },
  canEdit: true,
  dock: 'right',
  sleepers: false,
  profiles: false,
}
type Sub = { id: string; label: string; note?: string; disabled?: boolean; reason?: string; submenu: MenuEntry[] }
const entry = (items: readonly MenuEntry[], id: string) =>
  items.find(i => 'id' in i && i.id === id) as unknown as Sub | undefined
const lines = (sub: Sub | undefined) =>
  (sub?.submenu ?? []).map(i => ('separator' in i ? '---' : `${i.id}${i.checked ? ' ✓' : ''}`))
const offNote = (items: readonly MenuEntry[], id: string) =>
  (entry(items, id)?.submenu[0] as { note?: string } | undefined)?.note
const ids = (items: readonly MenuEntry[]) => items.flatMap(i => ('id' in i ? [i.id] : []))
const OFF = { watches: false, decisions: false, journal: false }

test('none given (another device, an older board): the menu is as it was, item for item', () => {
  const base = { ...now, todos: 'none' as const, threads: 'agents' as const, compact: '' }
  expect(JSON.stringify(settingsMenu({ ...base, threadsCases: undefined, threadsVerify: undefined }))).toBe(
    JSON.stringify(settingsMenu(base)),
  )
  expect(ids(settingsMenu(base))).toEqual(['theme', 'lang', 'panel', 'todos', 'threads', 'compact', 'sleepers'])
  expect(lines(entry(settingsMenu(base), 'threads'))).toEqual(['threads:none', 'threads:mine', 'threads:agents ✓'])
})

test('Watches, Decisions and Away journal come after Threads, before Auto-compact, each Off checked and a line on it', () => {
  const items = settingsMenu({ ...now, todos: 'none', threads: 'none', compact: '', ...OFF })
  expect(ids(items).slice(ids(items).indexOf('threads'), ids(items).indexOf('compact') + 1)).toEqual([
    'threads',
    'watches',
    'decisions',
    'journal',
    'compact',
  ])
  expect(lines(entry(items, 'watches'))).toEqual(['watches:off ✓', 'watches:on'])
  expect(lines(entry(items, 'decisions'))).toEqual(['decisions:off ✓', 'decisions:on'])
  expect(lines(entry(items, 'journal'))).toEqual(['journal:off ✓', 'journal:on'])
  expect(['watches', 'decisions', 'journal'].map(id => [entry(items, id)?.label, entry(items, id)?.note])).toEqual([
    [
      'Watches',
      'Wakes a waiting session only when its probe fires. Sessions already running learn it at their next start.',
    ],
    [
      'Decisions',
      'Questions with options and a default, in one queue. Sessions already running learn it at their next start.',
    ],
    ['Away journal', 'Shows what changed while you were away.'],
  ])
  expect(entry(items, 'watches')?.submenu.map(i => ('label' in i ? i.label : '---'))).toEqual(['Off', 'On'])
})

test('on: On checked; decisions say whether a default may answer, only while they are on', () => {
  const on = settingsMenu({ ...now, watches: true, decisions: true, decisionsDefaults: true, journal: true })
  expect(lines(entry(on, 'watches'))).toEqual(['watches:off', 'watches:on ✓'])
  expect(lines(entry(on, 'journal'))).toEqual(['journal:off', 'journal:on ✓'])
  expect(lines(entry(on, 'decisions'))).toEqual([
    'decisions:off',
    'decisions:on ✓',
    '---',
    'decisionsDefaults:on ✓',
    'decisionsDefaults:off',
  ])
  expect(
    entry(on, 'decisions')
      ?.submenu.slice(3)
      .map(i => ('label' in i ? i.label : '')),
  ).toEqual(['Default answers allowed', 'No default answers'])
  const none = settingsMenu({ ...now, decisions: true, decisionsDefaults: false })
  expect(lines(entry(none, 'decisions')).slice(-2)).toEqual(['decisionsDefaults:on', 'decisionsDefaults:off ✓'])
  // Off: no defaults to choose, whatever is given.
  expect(lines(entry(settingsMenu({ ...now, decisions: false, decisionsDefaults: true }), 'decisions'))).toHaveLength(2)
})

test('under Threads while they are on: Case files and Verified done, a check each with its line; hidden while off', () => {
  const on = entry(settingsMenu({ ...now, threads: 'agents', threadsCases: false, threadsVerify: true }), 'threads')
  expect(lines(on)).toEqual([
    'threads:none',
    'threads:mine',
    'threads:agents ✓',
    '---',
    'threadsCases:on',
    'threadsVerify:off ✓',
  ])
  expect(on?.submenu.slice(4).map(i => ('label' in i ? [i.label, i.note] : []))).toEqual([
    [
      'Case files',
      "A thread keeps a case's reference, state and sessions. Sessions already running learn it at their next start.",
    ],
    ['Verified done', "A worker's done counts once a new session has checked it."],
  ])
  // With Team's sharing too: after it.
  const shared = entry(
    settingsMenu({ ...now, threads: 'mine', threadsShare: true, threadsCases: true, threadsVerify: false }),
    'threads',
  )
  expect(lines(shared).slice(3)).toEqual([
    '---',
    'threadsShare:shared ✓',
    'threadsShare:local',
    '---',
    'threadsCases:off ✓',
    'threadsVerify:on',
  ])
  // Threads off: neither, as main had it.
  expect(
    lines(entry(settingsMenu({ ...now, threads: 'none', threadsCases: false, threadsVerify: false }), 'threads')),
  ).toEqual(['threads:none ✓', 'threads:mine', 'threads:agents'])
})

test('Russian, and gray without the board with the reason instead of the line', () => {
  const items = settingsMenu({ ...now, t: ru, threads: 'agents', threadsCases: false, threadsVerify: false, ...OFF })
  expect(['watches', 'decisions', 'journal'].map(id => entry(items, id)?.label)).toEqual([
    'Наблюдения',
    'Решения',
    'Журнал отсутствия',
  ])
  expect(entry(items, 'journal')?.note).toBe('Показывает, что менялось, пока вас не было.')
  expect(entry(items, 'watches')?.submenu.map(i => ('label' in i ? i.label : ''))).toEqual(['Выключено', 'Включено'])
  expect(
    entry(items, 'threads')
      ?.submenu.slice(4)
      .map(i => ('label' in i ? i.label : '')),
  ).toEqual(['Кейсы', 'Проверка готовности'])
  const gray = entry(settingsMenu({ ...now, canEdit: false, ...OFF }), 'watches')
  expect(gray).toMatchObject({ disabled: true, reason: en('live.off') })
  const markup = JSON.stringify(
    reactMarkup(<MenuItem item={gray as never} id="m-1" index={1} checks={false} active={false} expanded={false} />),
  )
  expect(markup).toContain(en('live.off'))
  expect(markup).not.toContain('check command')
})

test("the line is drawn under the label, in the reason's place; an item without one is drawn as before", () => {
  const item = { id: 'watches', label: 'Watches', note: 'A line', submenu: [] }
  const nodes = reactMarkup(<MenuItem item={item} id="m-0" index={0} checks={false} active={false} expanded={false} />)
  const notes = findAll(nodes, el => (el.attrs.get('class') ?? '').split(' ').includes('mi-note'))
  expect(notes).toHaveLength(1)
  expect(notes[0]?.attrs.get('class')).toBe('mi-reason mi-note')
  const plain = { id: 'x', label: 'X' }
  expect(
    JSON.stringify(
      reactMarkup(<MenuItem item={plain} id="m-0" index={0} checks={false} active={false} expanded={false} />),
    ),
  ).not.toContain('mi-reason')
})

test('every new string: English and Russian, no long dashes', () => {
  const keys = [
    'set.feature.off',
    'set.feature.on',
    'set.watches',
    'set.watches.note',
    'set.decisions',
    'set.decisions.note',
    'set.decisions.defaults',
    'set.decisions.noDefaults',
    'set.journal',
    'set.journal.note',
    'set.cases',
    'set.cases.note',
    'set.verify',
    'set.verify.note',
    'feature.err.setting',
    'feature.err.decisionsOff',
  ]
  for (const t of [en, ru])
    for (const key of keys) {
      expect(t(key)).not.toBe(key)
      expect(t(key)).not.toMatch(/[\u2013\u2014]/)
    }
  for (const key of keys) expect(ru(key)).not.toBe(en(key))
})

test("Off says what it leaves behind: watches no longer checked, defaults that will not run; the journal's error in its line", () => {
  const items = settingsMenu({
    ...now,
    watches: true,
    watchesRunning: 2,
    decisions: true,
    decisionsDefaults: true,
    defaultsRunning: 1,
    journal: true,
    journalError: 'journal.db could not be opened',
  })
  const offOf = (id: string) => offNote(items, id)
  expect(offOf('watches')).toBe('2 watches stop being checked until this is on again')
  expect(offOf('decisions')).toBe('1 default will not run')
  expect(entry(items, 'journal')?.note).toBe('On, but nothing is recorded: journal.db could not be opened')
  expect(lines(entry(items, 'journal'))).toEqual(['journal:off', 'journal:on ✓'])
  // Nothing running, or off already: no such line.
  const quiet = settingsMenu({ ...now, watches: true, decisions: false, defaultsRunning: 3, journal: true })
  expect(offNote(quiet, 'watches')).toBeUndefined()
  expect(offNote(quiet, 'decisions')).toBeUndefined()
  expect(entry(quiet, 'journal')?.note).toBe('Shows what changed while you were away.')
  const ruItems = settingsMenu({
    ...now,
    t: ru,
    watches: true,
    watchesRunning: 5,
    decisions: true,
    decisionsDefaults: true,
    defaultsRunning: 2,
  })
  expect(offNote(ruItems, 'watches')).toBe('5 наблюдений не будут проверяться, пока наблюдения выключены')
  expect(offNote(ruItems, 'decisions')).toBe('2 ответа по умолчанию не сработают')
})

test('what Off leaves behind, counted from the payload: watches being checked, defaults set and not held', () => {
  const watch = (id: string, off?: true) => ({
    id,
    key: id,
    kind: 'watch',
    text: 'x',
    next: 0,
    probe: { cmd: 'exit 1', everyMs: 60_000, timeoutMs: 1000 },
    ...(off && { off }),
  })
  const d = (defaultAt: number | null, held = false) => ({ defaultAt, held })
  expect(
    featuresNow({
      watches: true,
      schedules: [watch('a'), watch('b'), { id: 'r', kind: 'reminder' }],
      decisions: { defaults: true, items: [d(5), d(null), d(9, true)] },
      journal: { strip: null, last: null, error: 'no db' },
    }),
  ).toEqual({
    watches: true,
    decisions: true,
    decisionsDefaults: true,
    journal: true,
    journalError: 'no db',
    watchesRunning: 2,
    defaultsRunning: 1,
  })
  // Watches off: the ones left are not checked, nothing to count.
  expect(featuresNow({ schedules: [watch('a', true)] })).toEqual({ watches: false, decisions: false, journal: false })
})

test('a watch the payload marks off: the card and the sheet say it is not checked, not when it was last checked', () => {
  const w = {
    id: 'a1b2c3',
    key: 's1',
    name: 'anna',
    kind: 'watch' as const,
    text: 'CI',
    next: 0,
    created: 0,
    lastCheck: Date.now() - 240_000,
    probe: { cmd: 'exit 1', everyMs: 600_000, timeoutMs: 1000 },
  }
  expect(watchView(w, Date.now(), en).state).toBe('checked 4 min ago, nothing yet')
  expect(watchView({ ...w, off: true }, Date.now(), en).state).toBe('not checked: watches are off')
  expect(watchView({ ...w, off: true }, Date.now(), ru).state).toBe('не проверяется: наблюдения выключены')
})

test('the state as the payload says it: off without each line; defaults only while decisions are on', () => {
  expect(featuresNow({})).toEqual({ watches: false, decisions: false, journal: false })
  expect(featuresNow({ watches: true, decisions: { defaults: false }, journal: { strip: null, last: null } })).toEqual({
    watches: true,
    decisions: true,
    decisionsDefaults: false,
    journal: true,
  })
  expect(featuresNow({ threads: {} })).toMatchObject({ threadsCases: false, threadsVerify: false })
  expect(featuresNow({ threads: { cases: true, verify: true } })).toMatchObject({
    threadsCases: true,
    threadsVerify: true,
  })
})

test('a pick: on or off for each; anything else is no pick', () => {
  expect(settingPicked('watches:on')).toEqual({ kind: 'feature', feature: 'watches', value: true })
  expect(settingPicked('decisions:off')).toEqual({ kind: 'feature', feature: 'decisions', value: false })
  expect(settingPicked('journal:on')).toEqual({ kind: 'feature', feature: 'journal', value: true })
  expect(settingPicked('decisionsDefaults:off')).toEqual({ kind: 'decisionsDefaults', value: false })
  expect(settingPicked('threadsCases:on')).toEqual({ kind: 'threadsCases', value: true })
  expect(settingPicked('threadsVerify:off')).toEqual({ kind: 'threadsVerify', value: false })
  for (const id of ['watches', 'watches:maybe', 'journal:', 'cases:on', 'threadsVerify'])
    expect(settingPicked(id)).toBeNull()
})

test('out of the gear: each pick asks for its switch', () => {
  const features: FeatureSetting[] = []
  const threads: ThreadsSetting[] = []
  let picked: (id: string) => void = () => {}
  const open = settingsMenuFrom({
    menu: {
      open(_items, opts) {
        picked = id => opts.onPick?.(id, { id, label: id })
      },
    },
    t: () => en,
    canEdit: () => true,
    languages: () => ({ en: 'English' }),
    dock: () => 'right',
    sleepers: () => false,
    root: () => ({ dataset: {} }),
    coarse: () => false,
    setTheme() {},
    chooseLanguage() {},
    placePanels() {},
    resetPanelSize() {},
    toggleSleepers() {},
    profiles: () => false,
    openProfiles() {},
    fold: () => null,
    chooseFold() {},
    threads: () => 'agents',
    threadsCases: () => false,
    threadsVerify: () => true,
    chooseThreads: body => void threads.push(body),
    watches: () => false,
    decisions: () => true,
    decisionsDefaults: () => true,
    journal: () => false,
    chooseFeature: body => void features.push(body),
  })
  open({ getBoundingClientRect: () => ({ right: 0, bottom: 0 }) } as HTMLElement, false)
  for (const id of [
    'watches:on',
    'decisions:off',
    'decisionsDefaults:off',
    'journal:on',
    'threadsCases:on',
    'threadsVerify:off',
  ])
    picked(id)
  expect(features).toEqual([{ watches: true }, { decisions: false }, { decisionsDefaults: false }, { journal: true }])
  expect(threads).toEqual([{ cases: true }, { verify: false }])
})

/** The page's own gear on `data`: the items it opens, and the pick function. */
function pageGear(data: BoardPayload, remote = false) {
  const g = globalThis as Record<string, unknown>
  const saved = { document: g.document, matchMedia: g.matchMedia }
  g.document = { documentElement: { hasAttribute: (name: string) => remote && name === 'data-remote', dataset: {} } }
  g.matchMedia = () => ({ matches: false })
  try {
    let items: readonly MenuEntry[] = []
    let pick: (id: string) => void = () => {}
    const menu = {
      open: (opened: readonly MenuEntry[], opts: { onPick?: (id: string, it: unknown) => void }) => {
        items = opened
        pick = id => opts.onPick?.(id, { id, label: id })
      },
      openNow: { subscribe: () => () => {} },
      isOpen: () => false,
    } as unknown as MenuEngine
    let gear: ReturnType<typeof useSettingsMenu> | null = null
    function Probe() {
      gear = useSettingsMenu(menu, () => {})
      return null
    }
    renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
        <Probe />
      </PanelProvider>,
      board({ data, canEdit: true }),
    )
    ;(gear as ReturnType<typeof useSettingsMenu> | null)?.open(
      { getBoundingClientRect: () => ({ right: 0, bottom: 0 }) } as HTMLElement,
      false,
    )
    return { items, pick }
  } finally {
    g.document = saved.document
    g.matchMedia = saved.matchMedia
  }
}

test("the page: the switches from the payload on the local page; Threads' own only while threads are on; none on another device", async () => {
  const off = pageGear(payload({ threads: { rev: 0, needsOwner: 0 } }))
  expect(lines(entry(off.items, 'watches'))).toEqual(['watches:off ✓', 'watches:on'])
  expect(lines(entry(off.items, 'threads')).slice(-3)).toEqual(['---', 'threadsCases:on', 'threadsVerify:on'])
  // Threads off: Off checked, and nothing under it.
  const threadsOff = pageGear(payload({}))
  expect(lines(entry(threadsOff.items, 'threads'))).toEqual(['threads:none ✓', 'threads:mine', 'threads:agents'])
  const on = pageGear(
    payload({
      watches: true,
      decisions: { items: [], defaulted: [], defaults: false },
      journal: { strip: null, last: null },
      threads: { rev: 3, needsOwner: 0, cases: true, verify: true },
    }),
  )
  expect(lines(entry(on.items, 'watches'))).toEqual(['watches:off', 'watches:on ✓'])
  expect(lines(entry(on.items, 'decisions')).slice(-2)).toEqual(['decisionsDefaults:on', 'decisionsDefaults:off ✓'])
  expect(lines(entry(on.items, 'journal'))).toEqual(['journal:off', 'journal:on ✓'])
  expect(lines(entry(on.items, 'threads')).slice(-2)).toEqual(['threadsCases:off ✓', 'threadsVerify:off ✓'])
  // A pick posts to the board: the features to /api/feature-settings, threads' own to /api/threads-settings.
  const calls = answers()
  on.pick('journal:off')
  on.pick('decisionsDefaults:on')
  on.pick('threadsVerify:off')
  await Bun.sleep(10)
  expect(sent(calls)).toEqual([
    ['/api/feature-settings', 'POST', '1', { journal: false }],
    ['/api/feature-settings', 'POST', '1', { decisionsDefaults: true }],
    ['/api/threads-settings', 'POST', '1', { verify: false }],
  ])
  // Another device's page: none of them, as Threads.
  const remote = pageGear(payload({ watches: true, threads: { rev: 0, needsOwner: 0, cases: true } }), true)
  for (const id of ['watches', 'decisions', 'journal', 'threads']) expect(entry(remote.items, id)).toBeUndefined()
})
