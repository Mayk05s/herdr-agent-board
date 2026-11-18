// The Tasks screen and the review step on the page (board-6): `#tasks` opens the screen, the
// sections put what waits on the owner first with Ready for review beside Needs you, a thread in
// review shows its result, how to check it and Accept / Return, and the screen has New task and
// the way back to the agents. Off (no threads), the screen draws nothing.
import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Party, ThreadEntryView, ThreadRow, ThreadView } from '../../src/core/work-threads.ts'
import { TasksScreen } from '../../web/src/components/threads/TasksScreen.tsx'
import { ThreadPane } from '../../web/src/components/threads/ThreadPane.tsx'
import { type Threads, ThreadsContext, tasksInHash } from '../../web/src/hooks/useThreads.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { STATUS_COLUMN, sectionsOf } from '../../web/src/models/work-threads.ts'
import { type Board, BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board, payload } from './support/board.tsx'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const worker: Party = { kind: 'session', key: 'pane-w8:p2M', name: 'Board-task-pool' }
const owner: Party = { kind: 'owner' }

function row(fields: Partial<ThreadRow> & Pick<ThreadRow, 'key'>): ThreadRow {
  return {
    id: `${fields.key}-id`,
    lane: 'board',
    title: `Title of ${fields.key}`,
    summary: '',
    status: 'doing',
    waitingOn: '',
    proposed: null,
    assignee: null,
    parent: null,
    scope: 'local',
    createdBy: owner,
    createdAt: NOW,
    updatedAt: NOW,
    doneAt: null,
    rev: 1,
    parentKey: null,
    children: { done: 0, all: 0 },
    ...fields,
  }
}

const entry = (n: number, fields: Partial<ThreadEntryView>): ThreadEntryView => ({
  id: `e${n}`,
  thread: 't',
  n,
  seq: n,
  at: NOW + n,
  author: worker,
  type: 'note',
  text: '',
  ...fields,
})

const threads = (rows: ThreadRow[] = []): Threads => ({
  rows,
  known: new Set(rows.map(r => r.key)),
  rev: 1,
  open() {},
  asked: null,
  shown: false,
  setShown() {},
  full: true,
  setFull() {},
  fullLane: null,
})

function render(node: ReactNode, value: Board, t: Threads | null, lang: 'en' | 'ru' = 'en'): string {
  return renderToStaticMarkup(
    <I18nProvider lang={lang}>
      <BoardContext.Provider value={value}>
        <ThreadsContext.Provider value={t}>{node}</ThreadsContext.Provider>
      </BoardContext.Provider>
    </I18nProvider>,
  )
}

const menu = { open() {}, openNow: { subscribe: () => () => {} }, isOpen: () => false } as never

test('#tasks opens the Tasks screen on every lane, #tasks=<lane> on one; any other address does not', () => {
  expect(tasksInHash('#tasks')).toBeNull()
  expect(tasksInHash('#tasks=mokupilot')).toBe('mokupilot')
  expect(tasksInHash('')).toBeUndefined()
  expect(tasksInHash('#thread=board-6')).toBeUndefined()
  expect(tasksInHash('#tasks=Bad Lane')).toBeUndefined()
})

test('sections: Needs you, then Ready for review, then the rest; review in the owner colour', () => {
  const rows = [
    row({ key: 'board-1', status: 'next' }),
    row({ key: 'board-2', status: 'review' }),
    row({ key: 'board-3', status: 'owner' }),
    row({ key: 'board-4', status: 'waiting' }),
  ]
  expect(sectionsOf(rows, { lane: null, query: '' }).map(s => s.id)).toEqual(['owner', 'review', 'waiting', 'next'])
  expect(STATUS_COLUMN.review).toBe('me')
})

test('a thread in review: its result, how to check it, the files and links handed in, Accept and Return', () => {
  const view: ThreadView = {
    head: row({ key: 'board-7', status: 'review', assignee: worker, summary: 'Tasks screen built, local commit' }),
    children: [],
    entries: [
      entry(1, { author: owner, type: 'system', set: { title: 'Pool', status: 'next', lane: 'board' } }),
      entry(2, {
        text: 'Open #tasks and add a task',
        set: { status: 'review', summary: 'Tasks screen built, local commit' },
        links: [{ url: 'http://127.0.0.1:12499/#tasks' }],
      }),
    ],
    earlier: 0,
    ask: null,
    review: 'e2',
  }
  const value = board({ data: payload({ threads: { rev: 1, needsOwner: 1 } }) })
  const html = render(<ThreadPane view={view} onOpen={() => {}} onBack={() => {}} />, value, threads())
  expect(html).toContain('class="wt-review" data-review="e2"')
  expect(html).toContain('<b>Result:</b> Tasks screen built, local commit')
  expect(html).toContain('<b>How to check:</b> Open #tasks and add a task')
  expect(html).toContain('href="http://127.0.0.1:12499/#tasks"')
  expect(html).toContain('>Return with a remark</button>')
  expect(html).toContain('>Accept</button>')
  // The result is said once: not again as the plain summary line.
  expect(html).not.toContain('class="wt-summary"')
  const ru = render(<ThreadPane view={view} onOpen={() => {}} onBack={() => {}} />, value, threads(), 'ru')
  expect(ru).toContain('Готово к проверке')
  expect(ru).toContain('>Принять</button>')
  expect(ru).toContain('>Вернуть с замечанием</button>')
})

test('a thread out of review shows no review block, as before', () => {
  const view: ThreadView = {
    head: row({ key: 'board-8', status: 'doing', summary: 'on it' }),
    children: [],
    entries: [entry(1, { set: { status: 'doing', summary: 'on it' } })],
    earlier: 0,
    ask: null,
  }
  const html = render(<ThreadPane view={view} onOpen={() => {}} onBack={() => {}} />, board(), threads())
  expect(html).not.toContain('wt-review')
  expect(html).toContain('class="wt-summary"')
})

test('the Tasks screen: its title, New task, the way back to the agents and the list; nothing while threads are off', () => {
  const rows = [row({ key: 'board-1', status: 'next' }), row({ key: 'board-2', status: 'review' })]
  const value = board({ data: payload({ threads: { rev: 1, needsOwner: 1 } }) })
  const html = render(<TasksScreen menu={menu} />, value, threads(rows), 'ru')
  expect(html).toContain('class="wt-screen"')
  expect(html).toContain('<h2>Задачи</h2>')
  expect(html).toContain('>Новая задача</button>')
  expect(html).toContain('>Агенты</button>')
  expect(html).toContain('Запланировано')
  expect(html).toContain('Готово к проверке')
  expect(render(<TasksScreen menu={menu} />, value, null)).toBe('')
})
