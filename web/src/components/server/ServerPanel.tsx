// Settings → Server… (and the head's chip): the board's own server's state now, a side panel like
// Backup… and Time tracking…, read only. Under its host and uptime: CPU (a bar, the cores, the load
// average), memory and swap (bars, total, used, available), each disk (a bar, total, used,
// available, its mount point), the GPU where nvidia-smi is (none otherwise), and the processes that
// take the most CPU and the most memory, each named by what the board knows of it. It asks every
// PANEL_MS while open and the page is visible (models/server-state.ts); closed, it asks nothing.
import type { ReactNode } from 'react'
import type { SystemProcess, SystemView } from '../../../../src/core/system-state.ts'
import { diskPercent } from '../../../../src/core/system-state.ts'
import { errorText } from '../../api/client.ts'
import { useServerState } from '../../hooks/useServerState.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  bytesText,
  cpuText,
  labelText,
  levelOf,
  loadText,
  memoryPercent,
  PANEL_MS,
  pctText,
  type ServerPoll,
  share,
  swapPercent,
  uptimeText,
} from '../../models/server-state.ts'
import { Panel, type PanelBack } from '../panel/Panel.tsx'

export interface ServerPanelProps {
  open: boolean
  onClose(): void
  /** The page's poll unless given (a test's own). */
  poll?: ServerPoll
  /** Back to the Settings list when opened from it (#679). */
  back?: PanelBack | undefined
}

export function ServerPanel({ open, onClose, poll, back }: ServerPanelProps) {
  const t = useT()
  const { view, error } = useServerState('panel', open ? PANEL_MS : null, poll)
  const about = view
    ? view.uptime === null
      ? t('sys.aboutHost', { host: view.host })
      : t('sys.about', { host: view.host, uptime: uptimeText(view.uptime, t) })
    : ''
  return (
    <Panel
      id="server-sheet"
      kind="server"
      open={open}
      onClose={onClose}
      back={back}
      title={
        <>
          <h2>{t('sys.title')}</h2>
          {about && <p className="sheet-meta">{about}</p>}
        </>
      }
    >
      <ServerBody view={view} error={error === null ? null : errorText(error, t)} />
    </Panel>
  )
}

export interface ServerBodyProps {
  /** GET /api/system's answer; null while it is asked (or could not be read: `error`). */
  view: SystemView | null
  /** Why the last ask failed, in words; null when it did not. */
  error: string | null
}

/** The panel's content, from the state and the last failure: no asking here (ServerPanel does it). */
export function ServerBody({ view, error }: ServerBodyProps) {
  const t = useT()
  return (
    <div className="sheet-body cats-body server-body">
      {error && (
        <p className="access-problem" role="alert">
          {t(view ? 'sys.stale' : 'sys.loadError', { error })}
        </p>
      )}
      {!view && !error && <p className="sheet-meta">{t('sys.loading')}</p>}
      {view && <ServerView view={view} />}
    </div>
  )
}

function ServerView({ view }: { view: SystemView }) {
  const t = useT()
  const { cpu, memory } = view
  return (
    <>
      {cpu && (
        <section className="server-section" data-part="cpu">
          <h3 className="access-head">{t('sys.cpu')}</h3>
          <Meter pct={cpu.usage} label={t('sys.cpu')} />
          <p className="server-facts">
            <span>{t('sys.cpu.cores', { n: cpu.cores })}</span>
            {cpu.load && <span title={t('sys.cpu.loadHint')}>{loadText(cpu.load, t)}</span>}
            {cpu.usage === null && <span>{t('sys.cpu.first')}</span>}
          </p>
        </section>
      )}
      {memory && (
        <section className="server-section" data-part="memory">
          <h3 className="access-head">{t('sys.memory')}</h3>
          <Meter pct={memoryPercent(memory)} label={t('sys.memory')} />
          <Facts
            sizes={[
              t('sys.total', { size: bytesText(memory.total, t) }),
              t('sys.used', { size: bytesText(memory.used, t) }),
              t('sys.available', { size: bytesText(memory.available, t) }),
              t('sys.cache', { size: bytesText(memory.buffersCache, t) }),
            ]}
          />
          <h4 className="server-sub">{t('sys.swap')}</h4>
          {memory.swapTotal > 0 ? (
            <>
              <Meter pct={swapPercent(memory)} label={t('sys.swap')} />
              <Facts
                sizes={[
                  t('sys.total', { size: bytesText(memory.swapTotal, t) }),
                  t('sys.used', { size: bytesText(memory.swapUsed, t) }),
                ]}
              />
            </>
          ) : (
            <p className="server-facts">{t('sys.noSwap')}</p>
          )}
        </section>
      )}
      <section className="server-section" data-part="disks">
        <h3 className="access-head">{t('sys.disks')}</h3>
        {!view.disks.length && <p className="server-facts">{t('sys.noDisks')}</p>}
        {view.disks.map(d => (
          <div className="server-disk" key={`${d.device} ${d.mount}`}>
            <p className="server-name">
              <b>{d.mount}</b> <span className="sheet-meta">{t('sys.disk.of', { device: d.device, fs: d.fs })}</span>
            </p>
            <Meter pct={diskPercent(d)} label={d.mount} />
            <Facts
              sizes={[
                t('sys.total', { size: bytesText(d.total, t) }),
                t('sys.used', { size: bytesText(d.used, t) }),
                t('sys.available', { size: bytesText(d.available, t) }),
              ]}
            />
          </div>
        ))}
      </section>
      {view.gpu && view.gpu.length > 0 && (
        <section className="server-section" data-part="gpu">
          <h3 className="access-head">{t('sys.gpu')}</h3>
          {view.gpu.map((g, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two GPUs may share a name; nvidia-smi lists them in its order
            <div className="server-disk" key={i}>
              <p className="server-name">
                <b>{g.name}</b>
                {g.temperature !== null && (
                  <span className="sheet-meta"> {t('sys.gpu.temp', { deg: g.temperature })}</span>
                )}
              </p>
              <Meter pct={g.utilization} label={`${g.name}: ${t('sys.gpu.loadOf')}`} />
              {g.memoryTotal !== null && (
                <Meter pct={share(g.memoryUsed, g.memoryTotal)} label={`${g.name}: ${t('sys.memory')}`} />
              )}
              <p className="server-facts">
                <span>{t('sys.gpu.load', { pct: pctText(g.utilization) })}</span>
                {g.memoryTotal !== null && (
                  <span>
                    {t('sys.gpu.memory', { used: bytesText(g.memoryUsed, t), total: bytesText(g.memoryTotal, t) })}
                  </span>
                )}
              </p>
            </div>
          ))}
        </section>
      )}
      <section className="server-section" data-part="top-cpu">
        <h3 className="access-head" title={t('sys.topCpuHint')}>
          {t('sys.topCpu')}
        </h3>
        {view.top.cpu.length ? (
          <Processes list={view.top.cpu} lead="cpu" />
        ) : (
          <p className="server-facts">{t(cpu?.usage === null ? 'sys.topFirst' : 'sys.topNone')}</p>
        )}
      </section>
      <section className="server-section" data-part="top-memory">
        <h3 className="access-head">{t('sys.topMemory')}</h3>
        <Processes list={view.top.memory} lead="memory" />
      </section>
    </>
  )
}

/**
 * A bar of a percent and its figure, in the warning color from 80 % and the critical one from 90 %.
 * The bar is a picture of the figure beside it, which says it in words under the section's head.
 */
function Meter({ pct, label }: { pct: number | null; label: string }) {
  const level = levelOf(pct)
  return (
    <div className="server-meter" data-of={label}>
      <div className="server-bar" aria-hidden="true" data-level={level || undefined}>
        <span style={{ '--p': pct ?? 0 }} />
      </div>
      <span className="server-pct" data-level={level || undefined}>
        {pctText(pct)}
      </span>
    </div>
  )
}

function Facts({ sizes }: { sizes: ReactNode[] }) {
  return (
    <p className="server-facts">
      {sizes.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of figures, redrawn whole
        <span key={i}>{s}</span>
      ))}
    </p>
  )
}

/** The top processes: name, what the board knows of it, user and pid, its command; the list's figure first. */
function Processes({ list, lead }: { list: readonly SystemProcess[]; lead: 'cpu' | 'memory' }) {
  const t = useT()
  return (
    <ol className="server-procs" data-lead={lead}>
      {list.map(p => (
        <li className="server-proc" key={p.pid}>
          <div className="server-proc-who">
            <p className="server-name">
              <b>{p.name}</b>
              {p.label && (
                <span className="server-label" data-kind={p.label.kind}>
                  {labelText(p.label, t)}
                </span>
              )}
            </p>
            <p className="server-command" title={p.command}>
              {p.command}
            </p>
            <p className="sheet-meta">
              {p.user} · {t('sys.proc.pid', { pid: p.pid })}
            </p>
          </div>
          <div className="server-proc-use">
            <span className={lead === 'cpu' ? 'server-lead' : undefined} title={t('sys.proc.cpu')}>
              {cpuText(p.cpu, t)}
            </span>
            <span className={lead === 'memory' ? 'server-lead' : undefined} title={t('sys.proc.memory')}>
              {bytesText(p.rss, t)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  )
}
