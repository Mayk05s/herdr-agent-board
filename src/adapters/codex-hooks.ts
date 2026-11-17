// Only Codex's hooks.json and its backup. Configuration, trust and herdr's hooks stay theirs.
import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { labelHerdrHook, planCodexHooks } from '../core/codex-hooks.ts'

export function codexHooksPlan(
  dir: string,
  script: string,
  labels?: Partial<Record<string, string>>,
): { file: string; before: string | null; after: string } {
  const file = join(dir, 'hooks.json')
  let before: string | null = null
  try {
    before = readFileSync(file, 'utf8')
  } catch (err) {
    if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) throw err
  }
  let settings: unknown
  try {
    const text = before?.replace(/^\uFEFF/, '').trim()
    settings = text ? JSON.parse(text) : undefined
  } catch {
    throw new Error(`${file} is not valid JSON; left as it was`)
  }
  const next = planCodexHooks(settings, script, labels)
  const unchanged = before !== null && JSON.stringify(settings) === JSON.stringify(next)
  return { file, before, after: unchanged && before !== null ? before : `${JSON.stringify(next, null, 2)}\n` }
}

export function installCodexHooks(plan: ReturnType<typeof codexHooksPlan>): void {
  if (plan.before === plan.after) return
  if (plan.before !== null) {
    try {
      copyFileSync(plan.file, `${plan.file}.bak-agent-board`, constants.COPYFILE_EXCL)
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST')) throw err
    }
  }
  mkdirSync(dirname(plan.file), { recursive: true })
  writeFileSync(plan.file, plan.after)
}

/** herdr's Codex hook in `dir`'s hooks.json named `label` in /hooks; false when it was already, or is not there. */
export function labelHerdrHookIn(dir: string, label: string): boolean {
  const file = join(dir, 'hooks.json')
  let settings: unknown
  try {
    settings = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return false
  }
  const next = labelHerdrHook(settings, label)
  if (!next) return false
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return true
}
