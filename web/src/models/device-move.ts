// A session moved to another device from its card's menu (#616): POST /api/move with `device`, as
// `board move --device` moves it (src/services/nodes/move-device.ts), and what the toast says of it.
// The card shows "Moving to <device>…" while its files cross and its start there is waited for;
// the toast says where it runs now, or why it stays (the board's own words: a folder that does not
// travel, a session at work, a device not reachable).
import type { MoveDeps } from './profile-move.ts'

/** One target as POST /api/move answers a device move, as far as the page reads it. */
interface DeviceResult {
  target: string
  result: 'moved' | 'refused'
  why?: string
}

const isResult = (v: unknown): v is DeviceResult =>
  typeof v === 'object' && v !== null && typeof (v as DeviceResult).target === 'string'

/** A card's session to the device `device` (its title `title`), one toast for how it went. */
export async function moveCardToDevice(
  deps: Pick<MoveDeps, 't' | 'post' | 'errorText' | 'toast' | 'busy' | 'name'>,
  key: string,
  device: string,
  title: string,
): Promise<void> {
  const t = deps.t()
  const name = deps.name(key)
  deps.busy(key, t('moveDevice.busy', { device: title }))
  let one: DeviceResult | undefined
  try {
    const reply = await deps.post('/api/move', { targets: [key], device })
    one = (Array.isArray(reply.results) ? reply.results.filter(isResult) : [])[0]
  } catch (err) {
    return deps.toast(deps.errorText(err), true)
  } finally {
    deps.busy(key, null)
  }
  if (!one) return
  if (one.result === 'moved') return deps.toast(t('moveDevice.done', { name, device: title }))
  deps.toast(t('move.refused', { name, why: one.why ?? '' }), true)
}
