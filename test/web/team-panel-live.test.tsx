// The Team panel's view in a page whose effects run (react-dom in support/mini-dom.ts): without the
// payload's teamRev, or on a remote page, /api/team is never asked, even with the panel open; with
// it, it is asked once on opening and again when teamRev changes. The owner's remote page asks for
// the switches and who to welcome only on the board's own server (the payload's `server`), and
// People and agents shows the passkeys on the computer's page only.
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { BoardPayload } from '../../src/core/payload.ts'
import { board, payload } from './support/board.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { miniWindow } from './support/mini-dom.ts'

type Dom = ReturnType<typeof miniWindow>
let dom: Dom
let show: (data: BoardPayload, open?: boolean) => Promise<void>
let people: (data: BoardPayload) => Promise<void>
let root: { render(node: null): void; unmount(): void }
let flush: (fn: () => void) => void

const VIEW = {
  state: 'online',
  me: { peer: null, fingerprint: '', name: null },
  hub: 'wss://h.example.com',
  roster: [],
}

beforeAll(async () => {
  dom = miniWindow(800)
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const { useTeam } = await import('../../web/src/hooks/useTeam.ts')
  const { TeamPeople } = await import('../../web/src/components/team/TeamPeople.tsx')
  const { I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx')
  const { BoardContext } = await import('../../web/src/state/BoardProvider.tsx')
  const container = dom.document.body.appendChild(dom.document.createElement('div'))
  const r = createRoot(container as unknown as HTMLElement)
  root = r
  flush = flushSync
  function Probe({ open }: { open: boolean }) {
    useTeam(open)
    return null
  }
  show = async (data, open = true) => {
    flushSync(() =>
      r.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board({ data })}>
            <Probe open={open} />
          </BoardContext.Provider>
        </I18nProvider>,
      ),
    )
    await new Promise(done => setTimeout(done, 10))
  }
  people = async data => {
    flushSync(() =>
      r.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board({ data })}>
            <TeamPeople
              view={{ ...VIEW, me: { ...VIEW.me, peer: 'M'.repeat(43) } } as never}
              threads={[]}
              agents={AGENTS}
              pending={[]}
              disabled={false}
              onBack={() => {}}
              onSelect={() => {}}
              onTrust={() => {}}
              onAgents={() => {}}
            />
          </BoardContext.Provider>
        </I18nProvider>,
      ),
    )
    await new Promise(done => setTimeout(done, 10))
  }
})

afterEach(() => {
  restoreFetch()
  dom.document.documentElement.removeAttribute('data-remote')
  dom.document.documentElement.removeAttribute('data-team')
  // Each test draws its own: nothing of the one before stays mounted.
  flush(() => root.render(null))
})

/** The page's sections with class `name`. */
const sections = (name: string) =>
  dom.document.body.querySelectorAll('section').filter(el => el.className.split(' ').includes(name))
/** The switches on the page, by their name. */
const switches = () => dom.document.body.querySelectorAll('[data-switch]').map(el => el.getAttribute('data-switch'))

afterAll(async () => {
  flush(() => root.unmount())
  await new Promise(done => setTimeout(done, 20))
  dom.uninstall()
})

test('no teamRev: nothing is asked, open or not', async () => {
  const calls = answers([200, VIEW])
  await show(payload())
  expect(calls).toHaveLength(0)
})

test('teamRev on a remote page: nothing is asked', async () => {
  const calls = answers([200, VIEW])
  dom.document.documentElement.setAttribute('data-remote', '')
  await show(payload({ teamRev: 1 }))
  expect(calls).toHaveLength(0)
})

const AGENTS = { off: false, listener: null, peers: {}, paused: {}, lanes: [] }

test('teamRev on the local page: asked on opening, again on a new revision', async () => {
  const calls = answers(
    [200, VIEW],
    [200, { threads: [] }],
    [200, AGENTS],
    [200, { pending: [] }],
    [200, VIEW],
    [200, { threads: [] }],
    [200, AGENTS],
    [200, { pending: [] }],
  )
  const once = ['/api/team', '/api/team/threads', '/api/team/agents', '/api/team/welcome']
  await show(payload({ teamRev: 1 }))
  expect(calls.map(c => c.url)).toEqual(once)
  await show(payload({ teamRev: 2 }))
  expect(calls.map(c => c.url)).toEqual([...once, ...once])
})

test("teamRev on the owner's remote page to a PC (a phone, the tunnel): the view and the threads, no switches", async () => {
  const calls = answers([200, VIEW], [200, { threads: [] }])
  dom.document.documentElement.setAttribute('data-remote', '')
  dom.document.documentElement.setAttribute('data-team', '')
  await show(payload({ teamRev: 1 }))
  expect(calls.map(c => c.url)).toEqual(['/api/team', '/api/team/threads'])
})

test("teamRev on the board's own server's page (its domain's login): the switches and who to welcome, as on the computer", async () => {
  const calls = answers([200, VIEW], [200, { threads: [] }], [200, AGENTS], [200, { pending: [] }])
  dom.document.documentElement.setAttribute('data-remote', '')
  dom.document.documentElement.setAttribute('data-team', '')
  await show(payload({ teamRev: 1, server: true }))
  expect(calls.map(c => c.url)).toEqual(['/api/team', '/api/team/threads', '/api/team/agents', '/api/team/welcome'])
})

test("People and agents: the passkeys on the computer's page; not on the board's own server's, where the switches are", async () => {
  const calls = answers([200, { passkeys: [], required: false }])
  await people(payload({ teamRev: 1 }))
  expect(calls.map(c => c.url)).toEqual(['/api/team/passkeys'])
  expect(sections('team-passkeys')).toHaveLength(1)
  expect(switches()).toEqual(expect.arrayContaining(['passkey', 'agents', 'mute-chat']))
  const there = answers([200, { passkeys: [], required: false }])
  dom.document.documentElement.setAttribute('data-remote', '')
  dom.document.documentElement.setAttribute('data-team', '')
  await people(payload({ teamRev: 1, server: true }))
  expect(there).toHaveLength(0)
  expect(sections('team-passkeys')).toHaveLength(0)
  // the switches and the team chat's mute are drawn there, the passkey's not
  expect(switches()).toEqual(expect.arrayContaining(['agents', 'mute-chat']))
  expect(switches()).not.toContain('passkey')
})
