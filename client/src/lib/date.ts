/**
 * Date / time utilities — ALL display formatters render in Asia/Kolkata (IST)
 * regardless of the user's device timezone or where the server runs.
 *
 * Storage in DB is UTC. Two formats appear from the API:
 *   1. ISO with marker:    "2026-04-19T13:30:57.530Z"      (Date.toISOString())
 *   2. SQLite timeless:    "2026-04-19 13:30:57"           (datetime('now'))
 *
 * `parseDbTs()` normalizes both into a JS Date. Format (2) is treated as UTC
 * because that's what SQLite's datetime('now') returns, and JS would otherwise
 * mis-parse it as local-time (Chrome behaviour).
 */

const IST_TZ = 'Asia/Kolkata'

/** Parse a DB timestamp string (either ISO or SQLite "YYYY-MM-DD HH:MM:SS") as UTC. */
export function parseDbTs(s?: string | null): Date | null {
  if (!s) return null
  const str = String(s).trim()
  if (!str) return null
  // SQLite timeless format: append 'Z' so JS parses as UTC
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str)) {
    const iso = str.replace(' ', 'T') + 'Z'
    const d = new Date(iso)
    return isNaN(d.getTime()) ? null : d
  }
  const d = new Date(str)
  return isNaN(d.getTime()) ? null : d
}

/** "10:42 am" — IST time only */
export function fmtIstTime(s?: string | null): string {
  const d = parseDbTs(s)
  if (!d) return '—'
  return d.toLocaleTimeString('en-IN', { timeZone: IST_TZ, hour: '2-digit', minute: '2-digit' })
}

/** "20 Apr" — IST short date */
export function fmtIstDateShort(s?: string | null): string {
  const d = parseDbTs(s)
  if (!d) return '—'
  return d.toLocaleDateString('en-IN', { timeZone: IST_TZ, day: '2-digit', month: 'short' })
}

/** "20 Apr, 6:10 pm" — IST date + time */
export function fmtIstDateTime(s?: string | null): string {
  const d = parseDbTs(s)
  if (!d) return '—'
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

/** "20/04/2026, 6:10:42 pm" — IST full datetime with seconds (logs / audit) */
export function fmtIstFull(s?: string | null): string {
  const d = parseDbTs(s)
  if (!d) return '—'
  return d.toLocaleString('en-IN', {
    timeZone: IST_TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

/** Local IST calendar date YYYY-MM-DD — used for daily attendance bucketing */
export function localDateStr(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 3600000)
  const y = ist.getUTCFullYear()
  const m = `${ist.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${ist.getUTCDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Current month IST as YYYY-MM */
export function currentPeriod() {
  const ist = new Date(Date.now() + 5.5 * 3600000)
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Current minutes-since-midnight in IST (0 .. 1439). Useful for shift-end check. */
export function nowIstMinutes(): number {
  const ist = new Date(Date.now() + 5.5 * 3600000)
  return ist.getUTCHours() * 60 + ist.getUTCMinutes()
}

/** Parse "HH:MM" → minutes since midnight (e.g. "09:00" → 540). */
export function hmToMinutes(hm?: string | null): number {
  if (!hm || typeof hm !== 'string') return 9 * 60
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10))
  if (Number.isNaN(h)) return 9 * 60
  return h * 60 + (Number.isNaN(m) ? 0 : m)
}
