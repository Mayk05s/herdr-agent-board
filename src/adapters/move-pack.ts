// A session's files as they go from one device to another (#616, core/move-device.ts): listed with
// their hashes on the source, kept by hash on the target until the move commits, then written into
// the target profile's folder under the project folder of the session's new path. Claude's layout
// (adapters/move-files.ts): the transcript `projects/<project>/<id>.jsonl`, the session's own folder
// beside it, and `file-history/<id>/`. A link is never followed and never sent.
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MAX_PACK_FILE_BYTES, MAX_PACK_FILES, type PackFile, type PackFileKind } from '../core/move-device.ts'
import { projectFolderName } from '../core/resume.ts'
import { renameWithRetry } from './json-store.ts'
import { findTranscript, isPrefixFile } from './move-files.ts'

/** A file of the pack with where it is on this computer. */
export interface ListedFile extends PackFile {
  abs: string
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The SHA-256 of a file, read a piece at a time. */
export function fileHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', chunk => h.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

/** Every plain file below `root`, '/' between: no link, no device. */
function walk(root: string, out: { rel: string; abs: string }[], rel = ''): void {
  let names: string[]
  try {
    names = readdirSync(join(root, rel))
  } catch {
    return
  }
  for (const name of names.sort()) {
    const r = rel ? `${rel}/${name}` : name
    const abs = join(root, r)
    const st = lstatSync(abs, { throwIfNoEntry: false })
    if (!st) continue
    if (st.isDirectory()) walk(root, out, r)
    else if (st.isFile()) out.push({ rel: r, abs })
    if (out.length > MAX_PACK_FILES) return
  }
}

/**
 * The session's files in the profile folder `dir`, each with its size and hash; or why not: no
 * transcript, too many files, one too large.
 */
export async function listSessionFiles(
  dir: string,
  session: string,
  cwd: string,
): Promise<{ ok: true; files: ListedFile[]; transcript: string } | { ok: false; error: string }> {
  const transcript = findTranscript(dir, session, cwd)
  if (!transcript) return { ok: false, error: 'no-transcript' }
  const found: { kind: PackFileKind; rel: string; abs: string }[] = [{ kind: 'transcript', rel: '', abs: transcript }]
  for (const [kind, root] of [
    ['side', join(dirname(transcript), session)],
    ['history', join(dir, 'file-history', session)],
  ] as const) {
    const list: { rel: string; abs: string }[] = []
    walk(root, list)
    for (const f of list) found.push({ kind, ...f })
  }
  if (found.length > MAX_PACK_FILES) return { ok: false, error: `more than ${MAX_PACK_FILES} files` }
  const files: ListedFile[] = []
  for (const f of found) {
    const st = statSync(f.abs)
    if (st.size > MAX_PACK_FILE_BYTES) return { ok: false, error: `${f.abs} is larger than the move takes` }
    files.push({
      kind: f.kind,
      path: f.rel,
      size: st.size,
      sha256: await fileHash(f.abs),
      mode: process.platform !== 'win32' && st.mode & 0o111 ? 0o755 : 0o644,
      abs: f.abs,
    })
  }
  return { ok: true, files, transcript }
}

const SHA = /^[0-9a-f]{64}$/

/** Blobs kept by hash while a move is on its way (the target's side), in `dir`. */
export interface BlobStore {
  has(sha: string): boolean
  path(sha: string): string
  /** The bytes of `body` kept under `sha` once they hash to it: { ok } or why not ('size', 'hash', an error). */
  put(
    sha: string,
    body: ReadableStream<Uint8Array> | null,
    max: number,
  ): Promise<{ ok: true } | { ok: false; why: string }>
  drop(sha: string): void
  /** Blobs older than `ms` go. */
  sweep(ms: number, now?: number): void
}

export function blobStore(dir: string): BlobStore {
  const path = (sha: string): string => join(dir, sha)
  return {
    has: sha => SHA.test(sha) && !!statSync(path(sha), { throwIfNoEntry: false })?.isFile(),
    path,
    async put(sha, body, max) {
      if (!SHA.test(sha)) return { ok: false, why: 'hash' }
      mkdirSync(dir, { recursive: true })
      const tmp = `${path(sha)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      const h = createHash('sha256')
      let size = 0
      const fh = await open(tmp, 'w', 0o600)
      try {
        if (body)
          for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.length
            if (size > max) throw new Error('size')
            h.update(chunk)
            await fh.write(chunk)
          }
        await fh.close()
        if (h.digest('hex') !== sha) throw new Error('hash')
        renameSync(tmp, path(sha))
        return { ok: true }
      } catch (err) {
        await fh.close().catch(() => {})
        try {
          unlinkSync(tmp)
        } catch {}
        return { ok: false, why: messageOf(err) }
      }
    },
    drop(sha) {
      if (SHA.test(sha)) rmSync(path(sha), { force: true })
    },
    sweep(ms, now = Date.now()) {
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        const p = join(dir, name)
        try {
          if (now - statSync(p).mtimeMs > ms) rmSync(p, { force: true })
        } catch {}
      }
    },
  }
}

/** Where the transcript of `session` goes in profile folder `dir` for a session that runs in `cwd`. */
export const transcriptPath = (dir: string, cwd: string, session: string): string =>
  join(dir, 'projects', projectFolderName(cwd), `${session}.jsonl`)

/**
 * Why the session's files cannot be written into `dir` for `cwd`, known before anything is
 * written; '' when they can. The target has a transcript of it already (a move there before) that
 * is not the start of the one that comes (`incoming`: its blob): longer, or another conversation.
 */
export function installBlock(dir: string, cwd: string, session: string, incoming: string): string {
  const there = findTranscript(dir, session, cwd)
  if (!there) return ''
  try {
    return isPrefixFile(there, incoming) ? '' : `${there} is a longer or different copy of this conversation`
  } catch (err) {
    return `comparing with ${there} failed: ${messageOf(err)}`
  }
}

/**
 * The session's files written into profile folder `dir` for `cwd` from the blobs: the side folder
 * and the file history first, the transcript last through a temp file, so a write cut off halfway
 * leaves no transcript or a whole one. A transcript of the session already there under another
 * project folder (an older path) is left where it is; Claude resumes it from the new one.
 */
export function installSessionFiles(
  dir: string,
  cwd: string,
  session: string,
  files: readonly PackFile[],
  blob: (sha: string) => string,
): { ok: true; transcript: string } | { ok: false; error: string } {
  const transcript = transcriptPath(dir, cwd, session)
  const where = (f: PackFile): string =>
    f.kind === 'transcript'
      ? transcript
      : f.kind === 'side'
        ? join(dirname(transcript), session, ...f.path.split('/'))
        : join(dir, 'file-history', session, ...f.path.split('/'))
  try {
    for (const f of files) {
      if (f.kind === 'transcript') continue
      const to = where(f)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(blob(f.sha256), to)
      if (process.platform !== 'win32') chmodSync(to, f.mode)
    }
    const t = files.find(f => f.kind === 'transcript')
    if (!t) return { ok: false, error: 'no transcript in the pack' }
    mkdirSync(dirname(transcript), { recursive: true })
    const tmp = `${transcript}.${process.pid}.tmp`
    try {
      copyFileSync(blob(t.sha256), tmp)
      renameWithRetry(tmp, transcript)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {}
      throw err
    }
    return { ok: true, transcript }
  } catch (err) {
    return { ok: false, error: `writing into ${dir} failed: ${messageOf(err)}` }
  }
}
