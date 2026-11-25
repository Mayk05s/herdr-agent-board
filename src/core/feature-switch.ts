// A feature's switch in config.json (#596): Settings turns watches, decisions, the away journal,
// threads and threads' verified done on and off without losing what the section holds. A section is
// `true` or an object; off with fields of its own keeps them under `"on": false`, off with none takes
// the key out; on drops `on` again, and a section left with nothing else in it is `true`. A switch
// already in the state asked leaves the value exactly as written. A config with no `"on": false` in
// it reads as it did before Settings had these switches.

type Raw = Record<string, unknown>

const sectionOf = (raw: unknown): Raw | null =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Raw) : null

/** The section turned off by Settings (`"on": false`): its reader takes it as absent. */
export const switchedOff = (raw: unknown): boolean => sectionOf(raw)?.on === false

/** On as the readers take it: `true`, or an object without `"on": false`. */
const isOn = (raw: unknown): boolean => raw === true || (sectionOf(raw) !== null && !switchedOff(raw))

/**
 * config.json's value for a section once Settings turned it `on` or off; undefined: the key goes. One
 * already in that state (`{}` on, `false` or a value that reads as off, off) comes back as it was.
 */
export function switched(raw: unknown, on: boolean): unknown {
  if (isOn(raw) === on) return raw
  const { on: _was, ...own } = sectionOf(raw) ?? {}
  if (on) return Object.keys(own).length ? own : true
  return Object.keys(own).length ? { ...own, on: false } : undefined
}

/**
 * The section with `field` set to `value` (undefined: taken out), `true` when nothing else is left;
 * the section as it was when the field already says so.
 */
export function withField(raw: unknown, field: string, value: unknown): unknown {
  const section: Raw = { ...(sectionOf(raw) ?? {}) }
  if (value === undefined ? !(field in section) : section[field] === value) return raw
  if (value === undefined) delete section[field]
  else section[field] = value
  return Object.keys(section).length ? section : true
}
