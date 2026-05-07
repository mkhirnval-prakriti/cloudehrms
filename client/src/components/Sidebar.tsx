import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { useModuleVisibility } from '../lib/useModuleVisibility'
import { ensurePushSubscription } from '../lib/pushNotifications'

const items: { to: string; label: string; Icon: FC<{ className?: string }> }[] = [
  { to: '/', label: 'Dashboard', Icon: IconHome },
  { to: '/attendance', label: 'Employee Dashboard', Icon: IconUsers },
  { to: '/pending-registrations', label: 'Pending Registrations', Icon: IconClock },
  { to: '/biometric-requests', label: 'Biometric Approvals', Icon: IconShield },
  { to: '/documents', label: 'Doc Verification', Icon: IconDoc },
  { to: '/leaves', label: 'Leaves', Icon: IconCalendar },
  { to: '/staff-mgmt', label: 'Staff Mgmt', Icon: IconCog },
  { to: '/kiosk', label: 'Kiosk Mode', Icon: IconMonitor },
  { to: '/qr-scan', label: 'QR Attendance', Icon: IconQr },
  { to: '/notices', label: 'Notice Board', Icon: IconBell },
  { to: '/payroll', label: 'Payroll', Icon: IconCurrency },
  { to: '/office', label: 'Branch Location', Icon: IconMap },
  { to: '/trash', label: 'Trash', Icon: IconTrash },
  { to: '/monitor', label: 'Live Monitor', Icon: IconMonitorActivity },
  { to: '/company', label: 'Settings', Icon: IconBuilding },
  { to: '/guide', label: 'Help & Guide', Icon: IconBook },
]

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200',
    isActive
      ? 'bg-white/18 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)] ring-1 ring-[#66bb6a]/40'
      : 'text-emerald-50/90 hover:bg-white/10 hover:text-white',
  ].join(' ')

type SidebarProps = {
  mobileOpen: boolean
  onClose: () => void
}

export function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const base = import.meta.env.BASE_URL
  const { user, clearSession } = useAuth()
  const { canSee } = useModuleVisibility()
  const navigate = useNavigate()
  const [pendingCount, setPendingCount] = useState(0)
  const [unreadNotices, setUnreadNotices] = useState(0)

  // Reset Password modal state
  const [showReset, setShowReset] = useState(false)
  const [curPwd, setCurPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confPwd, setConfPwd] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [resetMsg, setResetMsg] = useState<{ ok: boolean; text: string } | null>(null)

  function openReset() { setShowReset(true); setCurPwd(''); setNewPwd(''); setConfPwd(''); setResetMsg(null) }
  function closeReset() { setShowReset(false); setResetMsg(null) }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault()
    setResetMsg(null)
    if (!curPwd) { setResetMsg({ ok: false, text: 'Current password required.' }); return }
    if (newPwd.length < 6) { setResetMsg({ ok: false, text: 'New password must be at least 6 characters.' }); return }
    if (newPwd !== confPwd) { setResetMsg({ ok: false, text: 'New password and confirmation do not match.' }); return }
    setResetBusy(true)
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ current_password: curPwd, new_password: newPwd }),
      })
      setResetMsg({ ok: true, text: 'पासवर्ड सफलतापूर्वक बदल गया' })
      setCurPwd(''); setNewPwd(''); setConfPwd('')
    } catch (err) {
      setResetMsg({ ok: false, text: (err as Error).message || 'Password change failed.' })
    } finally {
      setResetBusy(false)
    }
  }

  function handleLogout() {
    clearSession()
    navigate('/login')
    onClose()
  }

  useEffect(() => {
    if (!user || !canPerm(user, 'users:read')) return
    api<{ count: number }>('/admin/pending-registrations')
      .then((d) => setPendingCount(d.count || 0))
      .catch(() => setPendingCount(0))
    const t = window.setInterval(() => {
      api<{ count: number }>('/admin/pending-registrations')
        .then((d) => setPendingCount(d.count || 0))
        .catch(() => {})
    }, 60000)
    return () => window.clearInterval(t)
  }, [user])

  // Unread notices badge — every 60s
  useEffect(() => {
    if (!user) return
    const fetchUnread = () => {
      api<{ count: number }>('/notices/unread-count')
        .then((d) => setUnreadNotices(d.count || 0))
        .catch(() => {})
    }
    fetchUnread()
    const t = window.setInterval(fetchUnread, 60000)
    const onVis = () => { if (document.visibilityState === 'visible') fetchUnread() }
    document.addEventListener('visibilitychange', onVis)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [user])

  // Register Web Push subscription once per session
  useEffect(() => {
    if (!user) return
    void ensurePushSubscription()
  }, [user])

  const primaryOrder = [
    '/',
    '/attendance',
    '/pending-registrations',
    '/documents',
    '/leaves',
    '/staff-mgmt',
    '/kiosk',
    '/notices',
    '/payroll',
    '/office',
    '/trash',
    '/monitor',
  ]
  const visibleItems = items.filter((it) => {
    if (!user) return false
    // RBAC check first — visibility settings can only further restrict, not grant
    if (it.to === '/staff-mgmt') return canPerm(user, 'users:read') && canSee('nav.employees')
    if (it.to === '/pending-registrations') return canPerm(user, 'users:read')
    if (it.to === '/biometric-requests') return canPerm(user, 'biometric:admin') || user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'
    if (it.to === '/attendance') return canPerm(user, 'attendance:punch') && canSee('nav.attendance')
    if (it.to === '/kiosk') return canPerm(user, 'attendance:punch') && user.role !== 'USER' && canSee('nav.kiosk')
    if (it.to === '/qr-scan') return canPerm(user, 'attendance:punch') && canSee('nav.attendance') && user.role === 'USER'
    if (it.to === '/identity') return canPerm(user, 'attendance:punch')
    // Documents: admins see "Doc Verification" queue; staff (USER) see "My Documents" upload page
    if (it.to === '/documents') return canPerm(user, 'documents:read_all') || user.role === 'USER'
    if (it.to === '/leaves') return canPerm(user, 'leave:read_all') || canPerm(user, 'leave:read_self')
    if (it.to === '/payroll') return (canPerm(user, 'payroll:read') || canPerm(user, 'payroll:read_self')) && canSee('nav.payroll')
    if (it.to === '/office') return canPerm(user, 'branches:read') && canSee('nav.branches')
    if (it.to === '/company') return user.role !== 'USER'
    if (it.to === '/notices') return true
    if (it.to === '/guide') return canPerm(user, 'settings:read')
    if (it.to === '/reports') return canSee('nav.reports')
    if (it.to === '/trash') return user.role === 'SUPER_ADMIN'
    if (it.to === '/monitor') return user.role === 'SUPER_ADMIN'
    return true
  })
  const topItems = visibleItems.filter((it) => primaryOrder.includes(it.to))
  const otherItems = visibleItems.filter((it) => !primaryOrder.includes(it.to))

  const aside = (
    <aside className="flex h-full w-64 shrink-0 flex-col ph-brand-gradient text-white shadow-[4px_0_24px_rgba(31,94,59,0.15)]">
      <div className="flex items-center gap-3 border-b border-white/10 px-4 py-4">
        <img
          src={`${base}logo.png`}
          alt=""
          className="h-12 w-12 rounded-xl bg-white/10 object-contain p-1 shadow-inner"
        />
        <div className="min-w-0">
          <div className="truncate text-sm font-bold leading-tight tracking-tight">Prakriti Herbs</div>
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-emerald-100/85">Ayurveda · HRMS</div>
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {topItems.map((it) => {
          // Staff see this menu as "My Documents"; admins keep "Doc Verification"
          const label = it.to === '/documents' && user?.role === 'USER' ? 'My Documents' : it.label
          return (
          <NavLink key={it.to} to={it.to} end={it.to === '/'} className={linkClass} onClick={() => onClose()}>
            <it.Icon className="h-5 w-5 shrink-0 opacity-90 group-hover:opacity-100" />
            <span className="flex-1 truncate">{label}</span>
            {it.to === '/pending-registrations' && pendingCount > 0 && (
              <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-orange-400 text-[10px] font-bold text-white">
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            )}
            {it.to === '/notices' && unreadNotices > 0 && (
              <span className="ml-auto flex min-w-[20px] h-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white animate-pulse">
                {unreadNotices > 9 ? '9+' : unreadNotices}
              </span>
            )}
          </NavLink>
          )
        })}
        {otherItems.length > 0 && (
          <div className="mt-3 space-y-0.5 border-t border-white/10 pt-3">
            <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-100/70">
              Other
            </div>
            {otherItems.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.to === '/'} className={linkClass} onClick={() => onClose()}>
                <it.Icon className="h-5 w-5 shrink-0 opacity-90 group-hover:opacity-100" />
                <span className="truncate">{it.label}</span>
              </NavLink>
            ))}
          </div>
        )}
      </nav>
      {/* ── Account actions: Reset Password + Logout ── */}
      <div className="border-t border-white/10 px-2 py-2 space-y-0.5">
        <button
          type="button"
          onClick={openReset}
          className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-emerald-50/90 transition-all duration-200 hover:bg-white/10 hover:text-white"
        >
          <IconLock className="h-5 w-5 shrink-0 opacity-90 group-hover:opacity-100" />
          <span className="flex-1 text-left truncate">Reset Password</span>
        </button>
        <button
          type="button"
          onClick={handleLogout}
          className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-red-300 transition-all duration-200 hover:bg-red-500/20 hover:text-red-100"
        >
          <IconLogout className="h-5 w-5 shrink-0 opacity-90 group-hover:opacity-100" />
          <span className="flex-1 text-left truncate">Logout</span>
        </button>
      </div>
      <div className="border-t border-white/10 p-3 text-[10px] leading-snug text-emerald-100/65">
        Prakriti Herbs Ayurveda
      </div>
    </aside>
  )

  return (
    <>
      {/* Desktop */}
      <div className="hidden h-full md:flex">{aside}</div>
      {/* Mobile overlay */}
      <div
        className={`fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px] transition-opacity md:hidden ${
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`fixed inset-y-0 left-0 z-50 w-[min(18rem,88vw)] transform transition-transform duration-300 ease-out md:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {aside}
      </div>

      {/* ── Reset Password Modal ── */}
      {showReset && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal
        >
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div>
                <h3 className="font-bold text-[#1f5e3b]">🔒 Reset Password</h3>
                <p className="text-xs text-gray-500">अपना पासवर्ड बदलें</p>
              </div>
              <button
                type="button"
                onClick={closeReset}
                className="rounded-xl border border-gray-200 px-3 py-1.5 text-sm font-semibold text-gray-500 hover:bg-gray-50"
              >
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleResetPassword(e)} className="space-y-4 p-5">
              {resetMsg && (
                <div
                  className={`rounded-xl px-4 py-3 text-sm font-medium ${
                    resetMsg.ok
                      ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {resetMsg.text}
                </div>
              )}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-gray-600">Current Password</label>
                <input
                  type="password"
                  value={curPwd}
                  onChange={(e) => setCurPwd(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 placeholder-gray-400 focus:border-[#1f5e3b] focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/15"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-gray-600">New Password</label>
                <input
                  type="password"
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder="Min 6 characters"
                  autoComplete="new-password"
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 placeholder-gray-400 focus:border-[#1f5e3b] focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/15"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-gray-600">Confirm New Password</label>
                <input
                  type="password"
                  value={confPwd}
                  onChange={(e) => setConfPwd(e.target.value)}
                  placeholder="Re-enter new password"
                  autoComplete="new-password"
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 placeholder-gray-400 focus:border-[#1f5e3b] focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/15"
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeReset}
                  className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resetBusy}
                  className="flex-1 rounded-xl bg-[#1f5e3b] py-2.5 text-sm font-bold text-white shadow disabled:opacity-50 hover:bg-[#2e7d32]"
                >
                  {resetBusy ? '⏳ Saving...' : '✅ Change Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}


function IconHome({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  )
}
function IconClock({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
function IconUsers({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  )
}
function IconDoc({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  )
}
function IconCalendar({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  )
}
function IconCurrency({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}
function IconQr({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 5h2v2H5zM17 5h2v2h-2zM5 17h2v2H5zM15 15h2v2h-2zM19 15h2v2h-2zM15 19h2v2h-2zM19 19h2v2h-2z" />
    </svg>
  )
}
function IconCog({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}
function IconMonitor({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  )
}
function IconTrash({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  )
}
function IconMonitorActivity({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  )
}
function IconMap({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  )
}
function IconBuilding({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
    </svg>
  )
}
function IconBell({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  )
}
function IconBook({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
    </svg>
  )
}
function IconShield({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  )
}
function IconLock({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  )
}
function IconLogout({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  )
}
