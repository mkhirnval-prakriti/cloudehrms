import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useRealtimeEvents } from '../realtime'

type Notif = {
  id: number
  user_id: number
  kind: string
  title: string
  body: string
  link: string
  read_at: string | null
  created_at: string
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notif[]>([])
  const [unread, setUnread] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ notifications: Notif[]; unread_count: number }>('/notifications?limit=30')
      setItems(d.notifications || [])
      setUnread(d.unread_count || 0)
    } catch { /* silent */ }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Live push: prepend new notifications + bump badge instantly. Dedupe by id.
  useRealtimeEvents({
    notification: (n) => {
      const row = n as Notif
      if (!row || !row.id) return
      setItems((prev) => {
        if (prev.some((x) => x.id === row.id)) return prev
        return [row, ...prev].slice(0, 50)
      })
      setUnread((c) => {
        // Only bump if it's actually unread + not already in our list.
        if (row.read_at) return c
        return c + 1
      })
    },
  }, [])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  async function markOne(id: number) {
    setItems((arr) => arr.map((x) => x.id === id ? { ...x, read_at: new Date().toISOString() } : x))
    setUnread((c) => Math.max(0, c - 1))
    try { await api(`/notifications/${id}/read`, { method: 'POST' }) } catch { /* */ }
  }
  async function markAll() {
    setItems((arr) => arr.map((x) => ({ ...x, read_at: x.read_at || new Date().toISOString() })))
    setUnread(0)
    try { await api('/notifications/read-all', { method: 'POST' }) } catch { /* */ }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-full p-2 text-white/90 hover:bg-white/10"
        aria-label="Notifications"
        title="Notifications"
      >
        <span className="text-lg">🔔</span>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-[70vh] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-700">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-100">Notifications</p>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs font-medium text-blue-600 hover:underline">Mark all read</button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-gray-500">Koi notifications nahi.</p>
            ) : (
              items.map((n) => {
                const unreadRow = !n.read_at
                const icon = n.kind === 'attendance' ? '🕐' : n.kind === 'leave' ? '🌴' : n.kind === 'payroll' ? '💰' : '🔔'
                const ts = new Date(n.created_at).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })
                return (
                  <button
                    key={n.id}
                    onClick={() => { markOne(n.id); if (n.link) window.location.href = n.link }}
                    className={`flex w-full items-start gap-2 border-b border-gray-50 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50 ${unreadRow ? 'bg-blue-50/60 dark:bg-blue-900/20' : ''}`}
                  >
                    <span className="mt-0.5 text-lg">{icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`truncate font-medium ${unreadRow ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-200'}`}>{n.title}</p>
                      {n.body && <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{n.body}</p>}
                      <p className="mt-0.5 text-[10px] text-gray-400">{ts}</p>
                    </div>
                    {unreadRow && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-500" />}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
