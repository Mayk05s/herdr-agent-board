// The message box across sessions (web/app.js openSheet, saveDraft, the composer's submit and
// deliver, the discard button, the thread's Retry and Edit): the text stays with its session as a
// draft (models/drafts.ts) through a close, a switch to another session or a reload; the files
// belong to the session they were added for. A send leaves the box at once for the foot of the
// thread (the session's outbox, models/outbox.ts), goes out once and carries the draft's id; the
// draft stays stored until the session has the message, and one not sent stays at the foot with
// Retry and Edit. The page's state and effects come in as `deps`.
import { isCodexItem } from '../../../src/core/codex.ts'
import type { Item, Translator } from '../../../src/core/types.ts'
import { type Attachment, canSubmit, codexSendBlock, isUploading, sentText, uploadedPaths } from './composer.ts'
import type { Draft, DraftBook } from './drafts.ts'
import {
  type CodexReceipt,
  KEEP_SENT_MS,
  newestAt,
  type OutState,
  type ShownThread,
  sentKey,
  unsettled,
} from './outbox.ts'
import { draftKey } from './sheet.ts'

export type SendResult = { ok: true; codexReceipt?: unknown } | { ok: false; error: string }

/** One of the board's messages at the foot of its session's thread. */
export interface OutboxEntry {
  /** The id of the draft it was sent from: the request's id, and the bubble's. */
  id: string
  text: string
  /** The paths of its uploaded files. */
  files: string[]
  /** Those files as the box had them: "Edit" puts them back. */
  attached: readonly Attachment[]
  /** The message as the server types it: the text, then "Files:" and their paths. */
  full: string
  /** The words it goes by in the transcript (outbox.ts sentKey). */
  key: string
  /** The newest moment the thread knew of when it was sent (outbox.ts newestAt). */
  after: number
  state: OutState
  /** Why it was not sent ('' when the server did not say). */
  error: string
  /** When the session took it (0 until then). */
  sentAt: number
  codexReceipt?: CodexReceipt
  /** Keep the intended recipient when the transport is retried. */
  codexTarget?: {
    session: string | null
    codexThread: string | null
    codexTerminal: string | null
    codexRevision: string | null
  }
}

export interface ComposerPage {
  /** The open session's key, null once the sheet closed. */
  open: string | null
  /** The box's text. */
  text: string
  files: readonly Attachment[]
  canMutate: boolean
  /** The open session's detail as read so far (null until it came): its turns and its queue. */
  detail: ShownThread | null
  item(key: string): Item | undefined
  t: Translator
}

export interface ComposerDeps {
  drafts: DraftBook
  /** The page as of now. */
  page(): ComposerPage
  setText(text: string): void
  /** Drops the box's files, previews and all. */
  clearFiles(): void
  /** Empties the box's files but keeps their previews: the message's bubble and "Edit" keep them. */
  releaseFiles(): void
  /** "Edit": a message's files back into the box (the ones not there already). */
  restoreFiles(files: readonly Attachment[]): void
  /** A preview neither a message nor the box shows any more. */
  revoke(url: string): void
  /** The sessions with a message on its way changed. */
  sending(keys: ReadonlySet<string>): void
  /** The board's messages changed: the thread's foot is drawn anew. */
  changed(): void
  /** A message goes out to the open session: its thread goes to its foot, where the bubble is. */
  foot(): void
  toast(text: string, error?: boolean): void
  busy(key: string, label: string | null): void
  /** POST /api/session/<key>/message (useSessionActions.act). */
  post(key: string, body: Record<string, unknown>): Promise<SendResult>
  /** The session's detail again: the reply shows in the conversation. */
  reload(key: string): void
  focus(): void
  later(run: () => void, ms: number): void
  now(): number
}

export interface ComposerSession {
  /** The sheet opened `key` (again), or closed (null); `compose`: the box takes the focus. */
  opened(key: string | null, compose: boolean): void
  input(text: string): void
  send(): Promise<void>
  discard(): void
  /** Files held for delivery or retry, after they have left the composer itself. */
  hasUnsentAttachments(): boolean
  /**
   * The board's messages the thread of `key` shows at its foot now, the sheet open on `open` with
   * its `detail` as read so far.
   */
  waiting(key: string | null, open: string | null, detail: ShownThread | null): readonly OutboxEntry[]
  /** The ones the open session's thread has now (or that waited long enough) go for good. */
  settle(): void
  /** A message not sent goes again. */
  retry(id: string): Promise<void>
  /** A message not sent goes back into the box, files and all, to change or drop. */
  edit(id: string): void
}

/** A message sent: the conversation is read again a little later, with the reply on its way. */
export const RELOAD_AFTER_SEND_MS = 800
/** Redraw sent bubbles after the transcript has had time to catch up. */
export const REDRAW_AFTER_SEND_MS = KEEP_SENT_MS + 1000
/** "Write" opens the sheet, then the box takes the focus. */
export const COMPOSE_FOCUS_MS = 50

export function composerSession(deps: ComposerDeps): ComposerSession {
  const { drafts } = deps
  let draft: Draft | null = null // as last saved
  let identity: string | null = null // the session it is saved under
  let filesFor: string | null = null // the session the files were added for; outlives a close
  let open: string | null = null // the session open as of the last opening
  let onTheirWay: ReadonlySet<string> = new Set()
  const codexSeen = new Map<string, number>()
  const outbox = new Map<string, readonly OutboxEntry[]>() // session -> the board's messages its thread does not show yet

  function save(text: string): void {
    const key = open && identity
    if (!key) return
    // An empty box after a send keeps the message's own draft until the session has it.
    if (draft ? draft.text === text : !text) return
    draft = drafts.save(key, text)
  }

  function mark(key: string, on: boolean): void {
    const next = new Set(onTheirWay)
    if (on) next.add(key)
    else next.delete(key)
    onTheirWay = next
    deps.sending(next)
  }

  const entries = (key: string): readonly OutboxEntry[] => outbox.get(key) ?? []
  const find = (key: string, id: string): OutboxEntry | undefined => entries(key).find(e => e.id === id)
  function put(key: string, list: readonly OutboxEntry[]): void {
    if (list.length) outbox.set(key, list)
    else outbox.delete(key)
  }
  /** The message `id` of `key` with `fields` changed (one gone already stays gone). */
  const patch = (key: string, id: string, fields: Partial<OutboxEntry>): void =>
    put(
      key,
      entries(key).map(e => (e.id === id ? { ...e, ...fields } : e)),
    )

  /** What the thread of `key` shows of its outbox: the open session's settles against its detail. */
  function shown(
    key: string,
    openKey: string | null,
    detail: ShownThread | null,
    seen = new Map(codexSeen),
  ): readonly OutboxEntry[] {
    const list = entries(key)
    return openKey === key ? unsettled(list, detail ?? {}, deps.now(), KEEP_SENT_MS, seen) : list
  }

  /** A message gone for good: its previews, unless the box shows them again. */
  function forget(e: OutboxEntry): void {
    const files = deps.page().files
    for (const a of e.attached) if (a.url && !files.some(f => f.id === a.id)) deps.revoke(a.url)
  }

  /** Send one of the board's messages (again); its bubble says how it goes. */
  async function deliver(key: string, id: string): Promise<void> {
    patch(key, id, { state: 'sending', error: '' })
    const entry = find(key, id)
    if (!entry) return
    const page = deps.page()
    const it = page.item(key)
    mark(key, true)
    deps.changed()
    if (page.open === key) deps.foot()
    if (it?.sleeping) deps.busy(key, page.t('busy.waking'))
    const r: SendResult = it
      ? await deps.post(key, {
          text: entry.text,
          files: entry.files,
          session: it.session ?? null,
          requestId: id,
          ...entry.codexTarget,
        })
      : { ok: false, error: page.t('detail.missing') }
    mark(key, false)
    deps.busy(key, null)
    const { t, open: openNow } = deps.page()
    // While the thread is on show, the bubble says it.
    const onShow = openNow === key
    if (r.ok && it) {
      drafts.clear(draftKey(it), id)
      const receipt = r.codexReceipt
      const codexReceipt =
        receipt &&
        typeof receipt === 'object' &&
        'thread' in receipt &&
        (typeof receipt.thread === 'string' || receipt.thread === null) &&
        'text' in receipt &&
        typeof receipt.text === 'string' &&
        'after' in receipt &&
        typeof receipt.after === 'number'
          ? {
              thread: receipt.thread,
              text: receipt.text,
              after: receipt.after,
              ...('revision' in receipt && typeof receipt.revision === 'string' && { revision: receipt.revision }),
            }
          : entry.codexReceipt
      patch(key, id, { state: 'sent', sentAt: deps.now(), ...(codexReceipt && { codexReceipt }) })
      // A pane with no Claude session has no transcript to show it in.
      if (!it.session && !entry.codexTarget)
        put(
          key,
          entries(key).filter(e => e.id !== id),
        )
      if (!onShow || (!it.session && !entry.codexTarget)) deps.toast(sentText(it.name, entry.files.length, t))
      deps.later(() => {
        if (deps.page().open === key) deps.reload(key)
      }, RELOAD_AFTER_SEND_MS)
      deps.later(() => {
        if (entry.codexTarget && find(key, id)?.state === 'sent') patch(key, id, { state: 'history-unavailable' })
        if (deps.page().open === key) deps.changed()
      }, REDRAW_AFTER_SEND_MS)
    } else {
      const error = r.ok ? '' : r.error
      patch(key, id, { state: 'failed', error })
      if (!onShow) deps.toast(error, true)
    }
    deps.changed()
  }

  return {
    opened(key, compose) {
      const page = deps.page()
      if (key === null) {
        if (open) save(page.text)
        open = null
        return
      }
      // Files belong to the session they were added for, never to the next one; the same one
      // opened again keeps them.
      if (filesFor !== key && page.files.length) {
        deps.clearFiles()
        deps.toast(page.t('toast.attachDropped'))
      }
      if (open && open !== key) save(page.text)
      filesFor = key
      open = key
      const it = page.item(key)
      identity = draftKey(it) || key
      draft = drafts.read(draftKey(it))
      // A message on its way, or not sent, is in the thread: not in the box as well.
      if (draft && entries(key).some(e => e.id === draft?.id)) draft = null
      deps.setText(draft?.text ?? '')
      if (compose) deps.later(deps.focus, COMPOSE_FOCUS_MS)
    },

    input(text) {
      deps.setText(text)
      save(text)
    },

    async send() {
      const page = deps.page()
      const { open: key, t } = page
      const text = page.text.trim()
      const files = uploadedPaths(page.files)
      const sending = !!key && onTheirWay.has(key)
      if (!canSubmit({ canMutate: page.canMutate, key, sending, text, files, uploading: isUploading(page.files) }))
        return
      const it = key ? page.item(key) : undefined
      if (!key || !it || codexSendBlock(it, page.detail)) return
      save(page.text)
      // The draft stays stored until the session has the message: a reload before that keeps it.
      const request = draft ?? drafts.save(draftKey(it), page.text)
      if (!request) return
      const label = `${t('msg.files', { n: files.length })}:`
      // It leaves the box for the foot of the thread at once, written as the server types it.
      const full = [text, files.length ? `${label}\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n')
      const codexTarget = isCodexItem(it)
        ? {
            session: it.session,
            codexThread: it.codexThread ?? it.session,
            codexTerminal: it.codexTerminal ?? null,
            codexRevision: it.codexRevision ?? null,
          }
        : null
      const entry: OutboxEntry = {
        id: request.id,
        text,
        files,
        attached: page.files.filter(a => a.status === 'done'),
        full,
        key: sentKey(text, label),
        after: newestAt(page.detail) || deps.now() - 60_000,
        state: 'sending',
        error: '',
        sentAt: 0,
        ...(codexTarget && {
          codexTarget,
          codexReceipt: {
            thread: codexTarget.codexThread,
            text: full,
            after: deps.now(),
            ...(codexTarget.codexRevision && { revision: codexTarget.codexRevision }),
          },
        }),
      }
      put(key, [...entries(key), entry])
      draft = null
      deps.setText('')
      deps.releaseFiles() // the bubble and "Edit" keep them
      return deliver(key, entry.id)
    },

    discard() {
      if (open && onTheirWay.has(open)) return
      drafts.clear(identity)
      draft = null
      deps.setText('')
      deps.clearFiles()
      deps.focus()
    },

    hasUnsentAttachments() {
      for (const entries of outbox.values()) {
        if (entries.some(entry => entry.files.length && (entry.state === 'sending' || entry.state === 'failed')))
          return true
      }
      return false
    },

    waiting: (key, open, detail) => (key ? shown(key, open, detail) : []),

    settle() {
      const { open: key, detail } = deps.page()
      if (!key) return
      const list = entries(key)
      const left = shown(key, key, detail, codexSeen)
      if (left.length === list.length) return
      for (const e of list) if (!left.includes(e)) forget(e)
      put(key, left)
      deps.changed()
    },

    async retry(id) {
      const page = deps.page()
      const key = page.open
      if (!key || find(key, id)?.state !== 'failed') return
      if (page.canMutate && !onTheirWay.has(key) && !codexSendBlock(page.item(key), page.detail))
        return deliver(key, id)
    },

    edit(id) {
      const page = deps.page()
      const key = page.open
      const entry = key ? find(key, id) : undefined
      if (!key || entry?.state !== 'failed') return
      put(
        key,
        entries(key).filter(e => e !== entry),
      )
      const text = page.text.trim() ? `${entry.text}\n${page.text}` : entry.text
      deps.setText(text)
      deps.restoreFiles(entry.attached)
      save(text)
      deps.changed()
      deps.focus()
    },
  }
}
