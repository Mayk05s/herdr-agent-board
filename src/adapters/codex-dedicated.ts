// A CODEX_HOME of its own for the Codex sessions herdr runs (install.ts --codex-home). The global
// ~/.codex belongs to Codex Desktop too, so the board's hooks go in this folder only. What Codex
// must share with the global one is linked, never copied: a copy of auth.json lets two rotating
// refresh tokens drift apart, and a copy of config.toml loses later edits. Codex writes through a
// link (config.toml, checked with codex 0.169 features enable), so its trust entries land in the
// shared file. Hooks, sessions and the rest stay the dedicated folder's own.
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the dedicated folder goes when --codex-home names none. */
export const defaultCodexHome = (home = homedir()): string => join(home, '.config', 'herdr', 'codex')

const SHARED = ['auth.json', 'config.toml', 'AGENTS.md', 'rules'] as const

const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * `dir` made ready: the shared files and folders of `source` linked in where `dir` has none, and
 * `skills/` a real folder with a link per skill of `source` (the board's own skills are written
 * there as files). Returns what was linked and what could not be (no right to link, as on Windows
 * without developer mode); nothing there is replaced.
 */
export function prepareCodexHome(dir: string, source: string): { linked: string[]; failed: string[] } {
  if (join(dir) === join(source)) throw new Error('the dedicated Codex home is the global one')
  mkdirSync(join(dir, 'skills'), { recursive: true })
  const linked: string[] = []
  const failed: string[] = []
  const link = (from: string, to: string, name: string): void => {
    if (!existsSync(from) || present(to)) return
    try {
      symlinkSync(from, to)
      linked.push(name)
    } catch {
      failed.push(name)
    }
  }
  for (const name of SHARED) link(join(source, name), join(dir, name), name)
  try {
    for (const entry of readdirSync(join(source, 'skills')))
      link(join(source, 'skills', entry), join(dir, 'skills', entry), join('skills', entry))
  } catch {} // No skills there, or none readable: the dedicated folder has the board's own.
  return { linked, failed }
}
