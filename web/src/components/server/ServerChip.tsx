// The board's own server's state in the head (models/server-state.ts): "CPU 25% · RAM 34%", and the
// fullest disk while it is at 80 % or over, each figure orange from 80 % and red from 90 %. It asks
// every CHIP_MS while the page is visible; a click opens Settings → Server…'s panel. Drawn on the
// board's own server's page only (the toolbar is given `onServer` there). On a phone it is not shown
// and asks nothing (the head has no room: Settings → Server… is there); in a toolbar without room for
// it, it leaves for More first after the quiet notes (models/toolbar-fit.ts). Until the first answer,
// and where the board refuses the route, there is no chip.
import { useMediaQuery } from '../../hooks/useMediaQuery.ts'
import { useServerState } from '../../hooks/useServerState.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { PHONE_QUERY } from '../../models/panel-motion.ts'
import { CHIP_MS, chipParts, chipText, pctText, type ServerPoll, worst } from '../../models/server-state.ts'
import { classNames } from '../class-names.ts'

export function ServerChip({ onOpen, poll }: { onOpen(): void; poll?: ServerPoll }) {
  const t = useT()
  const phone = useMediaQuery(PHONE_QUERY)
  const { view, error, gone } = useServerState('chip', phone ? null : CHIP_MS, poll)
  if (!view || gone) return null
  const parts = chipParts(view, t)
  const text = chipText(parts)
  const level = worst(parts.map(p => p.level))
  return (
    <button
      type="button"
      className={classNames('server-chip', error !== null && 'stale')}
      id="server-chip"
      hidden={phone}
      data-level={level || undefined}
      title={t('sys.chipHint')}
      aria-label={`${t('sys.title')}: ${text}`}
      onClick={() => onOpen()}
    >
      {parts.map(p => (
        <span key={p.id} className="server-chip-part">
          {p.label} <b data-level={p.level || undefined}>{pctText(p.pct)}</b>
        </span>
      ))}
    </button>
  )
}
