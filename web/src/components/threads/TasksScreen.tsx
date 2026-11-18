// The Tasks screen (board-6): the threads in the board's place, the whole page wide, every lane or
// one project's, with New task at the top. The agents' board is a press away (Agents) and stays as
// it was; the screen is this browser's choice (useThreads.tsx), off until it is picked.
import { type FormEvent, useLayoutEffect, useRef, useState } from 'react'
import { api, errorText } from '../../api/client.ts'
import { useThreadsContext } from '../../hooks/useThreads.tsx'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { type LaneMenuEngine, ThreadsBody, useThreadsMeta } from './ThreadsPanel.tsx'

/** The new thread's key, as POST /api/threads {op: 'new'} answers it. */
const isMade = (v: unknown): v is { key: string } =>
  typeof v === 'object' && v !== null && typeof (v as { key?: unknown }).key === 'string'

/**
 * New task: a title, the project (a lane) and the task in the owner's words. The thread is made
 * with op `new` (next, nobody holds it) and the words go in as its first note, so its watchers,
 * the lane's master among them, hear of it.
 */
export function NewTask({ lane, onDone }: { lane: string | null; onDone(key: string | null): void }) {
  const t = useT()
  const { data, toast } = useBoardContext()
  const lanes = data?.categories ?? []
  const [title, setTitle] = useState('')
  const [pick, setPick] = useState(lane ?? lanes[0]?.id ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !title.trim() || !pick) return
    setBusy(true)
    try {
      const made = await api.post('/api/threads', { op: 'new', lane: pick, title: title.trim() })
      const key = isMade(made) ? made.key : null
      if (key && text.trim()) await api.post(`/api/threads/${encodeURIComponent(key)}`, { op: 'post', text })
      onDone(key)
    } catch (err) {
      toast(errorText(err, t), true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="wt-new" onSubmit={e => void submit(e)}>
      <input
        className="wt-new-title"
        value={title}
        maxLength={80}
        placeholder={t('wt.new.title')}
        aria-label={t('wt.new.title')}
        // biome-ignore lint/a11y/noAutofocus: the form opens for this field
        autoFocus
        onChange={e => setTitle(e.target.value)}
      />
      <label className="wt-new-lane">
        <span>{t('wt.new.lane')}</span>
        <select value={pick} onChange={e => setPick(e.target.value)}>
          {lanes.map(c => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="wt-new-text"
        value={text}
        rows={4}
        placeholder={t('wt.new.text')}
        aria-label={t('wt.new.text')}
        onChange={e => setText(e.target.value)}
      />
      <div className="wt-new-actions">
        <button type="button" className="mini" disabled={busy} onClick={() => onDone(null)}>
          {t('wt.new.cancel')}
        </button>
        <button type="submit" className="mini primary" disabled={busy || !title.trim() || !pick}>
          {t('wt.new.create')}
        </button>
      </div>
    </form>
  )
}

export function TasksScreen({ menu }: { menu: LaneMenuEngine }) {
  const t = useT()
  const threads = useThreadsContext()
  const { canEdit } = useBoardContext()
  const meta = useThreadsMeta()
  const [adding, setAdding] = useState(false)
  const [lane, setLane] = useState<string | null>(threads?.fullLane ?? null)
  // Where the screen starts under the sticky toolbar: what is left of the window is its height.
  const root = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const el = root.current
    if (el) el.style.setProperty('--wt-top', `${Math.max(0, el.getBoundingClientRect().top + window.scrollY)}px`)
  })
  if (!threads) return null
  return (
    <main ref={root} className="wt-screen" aria-label={t('wt.screen.title')}>
      <header className="wt-screen-head">
        <h2>{t('wt.screen.title')}</h2>
        <p className="sheet-meta">{meta}</p>
        <span className="spacer" />
        {canEdit && (
          <button
            type="button"
            className="mini primary wt-new-open"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            {t('wt.new')}
          </button>
        )}
        <button
          type="button"
          className="mini wt-agents"
          title={t('wt.screen.agentsHint')}
          onClick={() => threads.setFull(false)}
        >
          {t('wt.screen.agents')}
        </button>
      </header>
      {adding && (
        <NewTask
          lane={lane}
          onDone={key => {
            setAdding(false)
            if (key) threads.open(key)
          }}
        />
      )}
      <ThreadsBody open menu={menu} lane={lane} onLane={setLane} />
    </main>
  )
}
