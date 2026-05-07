import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { NotificationBell } from './NotificationBell'
import { useRealtimeEvents } from '../realtime'

type Live = { date?: string; currently_in?: unknown[] }

type SearchRes = {
  employees: { id: number; full_name: string; email: string; login_id?: string | null }[]
  branches: { id: number; name: string }[]
}

function roleLabel(role: string) {
  const m: Record<string, string> = {
    SUPER_ADMIN: 'Super Admin',
    ADMIN: 'Admin',
    ATTENDANCE_MANAGER: 'Attendance Manager',
    LOCATION_MANAGER: 'Branch Manager',
    USER: 'Staff',
  }
  return m[role] || role
}

function useDarkMode() {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('ph-dark') === '1' ||
      (!localStorage.getItem('ph-dark') && window.matchMedia('(prefers-color-scheme: dark)').matches)
  })

  useEffect(() => {
    const root = document.documentElement
    if (dark) {
      root.classList.add('dark')
      localStorage.setItem('ph-dark', '1')
    } else {
      root.classList.remove('dark')
      localStorage.setItem('ph-dark', '0')
    }
  }, [dark])

  return [dark, setDark] as const
}

type TopBarProps = {
  onMenu: () => void
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function TopBar({ onMenu }: TopBarProps) {
  const nav = useNavigate()
  const { user: me } = useAuth()
  const [live, setLive] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchData, setSearchData] = useState<SearchRes | null>(null)
  const [dark, setDark] = useDarkMode()
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const base = import.meta.env.BASE_URL
  const installRef = useRef<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault()
      installRef.current = e as BeforeInstallPromptEvent
      setInstallPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  async function handleInstall() {
    const prompt = installRef.current
    if (!prompt) return
    await prompt.prompt()
    const choice = await prompt.userChoice
    if (choice.outcome === 'accepted') {
      setInstallPrompt(null)
      installRef.current = null
    }
  }

  const refreshLive = useCallback(() => {
    api<Live>('/attendance/live-status')
      .then((d) => setLive(Array.isArray(d.currently_in) ? d.currently_in.length : 0))
      .catch(() => setLive(null))
  }, [])

  useEffect(() => {
    refreshLive()
    // Periodic safety net (in case SSE drops). Heavily reduced from 30s → 60s.
    const t = window.setInterval(refreshLive, 60000)
    return () => window.clearInterval(t)
  }, [refreshLive])

  // Live: any punch from anywhere updates the count instantly.
  useRealtimeEvents({ attendance: () => refreshLive() }, [refreshLive])

  useEffect(() => {
    const h = window.setTimeout(() => {
      if (q.trim().length < 1) {
        setSearchData(null)
        return
      }
      api<SearchRes>('/search?q=' + encodeURIComponent(q.trim()))
        .then(setSearchData)
        .catch(() => setSearchData({ employees: [], branches: [] }))
    }, q.trim().length < 1 ? 0 : 320)
    return () => window.clearTimeout(h)
  }, [q])

  const goEmployee = useCallback(
    (id: number) => {
      setSearchOpen(false)
      setQ('')
      nav(`/employees/${id}`)
    },
    [nav]
  )

  return (
    <header className="sticky top-0 z-30 border-b border-[#1f5e3b]/8 bg-white/80 dark:bg-[#0f1a13]/90 ph-glass">
      <div className="flex flex-wrap items-center gap-3 px-3 py-3 sm:gap-4 sm:px-5 sm:py-3.5">
        <button
          type="button"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#1f5e3b]/10 bg-white/90 dark:bg-white/5 text-[#1f5e3b] dark:text-[#66bb6a] shadow-sm transition hover:bg-[#1f5e3b]/5 md:hidden"
          onClick={onMenu}
          aria-label="Open menu"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <img
          src={`${base}logo.png`}
          alt=""
          className="hidden h-9 w-9 shrink-0 rounded-lg object-contain shadow-sm md:block lg:h-10 lg:w-10"
          width={40}
          height={40}
        />

        <div className="relative min-w-0 flex-1 max-w-xl">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#1f5e3b]/40">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 200)}
            placeholder="Search name, email, ID, branch…"
            className="w-full rounded-xl border border-[#1f5e3b]/10 bg-white/95 dark:bg-white/8 dark:text-white dark:placeholder:text-white/40 py-2.5 pl-10 pr-4 text-sm text-[#14261a] shadow-inner outline-none ring-0 transition focus:border-[#66bb6a]/40 focus:ring-4 focus:ring-[#1f5e3b]/8"
          />
          {searchOpen && q.trim().length > 0 && searchData && (
            <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-xl border border-[#1f5e3b]/10 bg-white dark:bg-[#1a2e1f] py-2 shadow-xl">
              {searchData.employees.length === 0 && searchData.branches.length === 0 && (
                <div className="px-3 py-2 text-xs text-[#1f5e3b]/60">No matches</div>
              )}
              {searchData.employees.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-[#1f5e3b]/5"
                  onMouseDown={() => goEmployee(e.id)}
                  onClick={() => goEmployee(e.id)}
                >
                  <span className="font-medium text-[#14261a] dark:text-white">{e.full_name}</span>
                  <span className="text-xs text-[#1f5e3b]/65 dark:text-white/50">
                    {e.login_id || e.email}
                  </span>
                </button>
              ))}
              {searchData.branches.map((b) => (
                <div key={b.id} className="px-3 py-1.5 text-xs text-[#1f5e3b]/80">
                  Branch: <strong>{b.name}</strong>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#66bb6a]/30 bg-gradient-to-r from-[#e8f5e9] to-white dark:from-[#1a2e1f] dark:to-[#1f5e3b]/20 px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] dark:text-[#66bb6a] shadow-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#66bb6a] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#2e7d32]" />
            </span>
            <span className="hidden sm:inline">Live</span>
            <span className="tabular-nums">{live === null ? '—' : `${live} in`}</span>
          </div>

          <div className="text-[#1f5e3b] dark:text-[#66bb6a]">
            <NotificationBell />
          </div>

          {installPrompt && (
            <button
              type="button"
              onClick={() => void handleInstall()}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-[#1f5e3b]/20 bg-white dark:bg-white/5 px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] dark:text-[#66bb6a] shadow-sm transition hover:bg-[#1f5e3b]/5"
              title="Install app"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Install
            </button>
          )}

          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#1f5e3b]/10 bg-white/90 dark:bg-white/5 text-[#1f5e3b] dark:text-[#66bb6a] shadow-sm transition hover:bg-[#1f5e3b]/5"
            aria-label="Toggle dark mode"
            title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {dark ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M12 5a7 7 0 100 14A7 7 0 0012 5z" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>

          <div className="flex items-center gap-2.5 rounded-2xl border border-[#1f5e3b]/10 bg-white dark:bg-white/5 px-2.5 py-1.5 shadow-sm sm:gap-3 sm:px-3 sm:py-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#2e7d32] to-[#1f5e3b] text-xs font-bold text-white shadow-inner">
              {(me?.full_name || '?')
                .split(/\s+/)
                .map((s) => s[0])
                .slice(0, 2)
                .join('')
                .toUpperCase()}
            </div>
            <div className="min-w-0 hidden text-left sm:block">
              <div className="truncate text-sm font-semibold text-[#14261a] dark:text-white">{me?.full_name || '…'}</div>
              <div className="text-[11px] font-medium text-[#1f5e3b]/75 dark:text-[#66bb6a]/80">{me ? roleLabel(me.role) : ''}</div>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}
