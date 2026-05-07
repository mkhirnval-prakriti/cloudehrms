import { useEffect, useRef } from 'react'
import { apiBaseUrl, getToken } from './api'

type EventHandler = (data: unknown) => void
type EventMap = Partial<Record<'attendance' | 'payroll' | 'leave' | 'notification' | 'ping' | 'hello', EventHandler>>

let es: EventSource | null = null
let currentToken: string | null = null
let reconnectTimer: number | null = null
const subs = new Set<EventMap>()
let backoff = 1000

function tearDown() {
  if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null }
  if (es) { try { es.close() } catch { /* */ } es = null }
  currentToken = null
}

function connect() {
  const token = getToken()
  if (!token) { tearDown(); return }
  // If a socket exists for a *different* token (account switch / re-login),
  // close it to avoid the new subscriber receiving the previous user's events.
  if (es && currentToken !== token) tearDown()
  if (es) return
  currentToken = token
  const url = `${apiBaseUrl()}/api/events?token=${encodeURIComponent(token)}`
  const sock = new EventSource(url)
  es = sock
  sock.addEventListener('open', () => { backoff = 1000 })
  sock.addEventListener('error', () => {
    if (es !== sock) return // already replaced
    try { sock.close() } catch { /* */ }
    es = null
    currentToken = null
    backoff = Math.min(30000, backoff * 2)
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (subs.size) connect()
    }, backoff)
  })
  for (const ev of ['attendance', 'payroll', 'leave', 'notification', 'ping', 'hello'] as const) {
    sock.addEventListener(ev, (msg) => {
      let data: unknown = null
      try { data = JSON.parse((msg as MessageEvent).data) } catch { /* */ }
      for (const m of subs) m[ev]?.(data)
    })
  }
}

function disconnect() {
  if (subs.size === 0) tearDown()
}

/** Force-close the socket. Call on logout / account switch. */
export function closeRealtime() {
  tearDown()
  backoff = 1000
}

/** React hook: subscribe to live events. Pass {} to just keep socket open. */
export function useRealtimeEvents(handlers: EventMap, deps: unknown[] = []) {
  const ref = useRef<EventMap>(handlers)
  ref.current = handlers
  useEffect(() => {
    const wrapper: EventMap = {}
    for (const k of Object.keys(handlers) as (keyof EventMap)[]) {
      wrapper[k] = (d) => ref.current[k]?.(d)
    }
    subs.add(wrapper)
    connect()
    // Detect token changes (e.g. login on a different tab) and refresh socket.
    const tokenWatch = window.setInterval(() => {
      const t = getToken()
      if (t !== currentToken) {
        if (es) tearDown()
        if (subs.size) connect()
      }
    }, 5000)
    return () => {
      subs.delete(wrapper)
      window.clearInterval(tokenWatch)
      setTimeout(disconnect, 200)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
