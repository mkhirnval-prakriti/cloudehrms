import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, apiFetchUrl, getToken } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { PageSkeleton } from '../components/PageSkeleton'
import {
  MODULE_GROUPS,
  MODULE_LABELS,
  CONFIGURABLE_ROLES,
  useBranchAccess,
} from '../lib/useModuleVisibility'

type SectionKey = 'home' | 'general' | 'attendance' | 'notifications' | 'roles'

type CompanyProfile = {
  company_name: string
  legal_name?: string
  gstin: string
  cin: string
  email: string
  address: string
  legal_address?: string
  city: string
  state: string
  pincode: string
  authorized_signatory?: string
  director?: string
}
type WifiNetwork = { ssid: string; password: string; ip_subnet?: string }
type CustomRole = { id: number; name: string; permissions?: string[]; active: number }
type RoleVisibility = Record<string, Record<string, boolean>>
type SheetStatus = {
  enabled: boolean
  google_sheet_link: string
  default_webhook_url: string
  api_key: string
  branch_map: Record<string, string>
  last_sync_at: string
  last_error: string
  branches: { id: number; name: string }[]
  sheet_to_portal_enabled?: boolean
  backfill_armed?: boolean
  backfill_armed_at?: string
  backfill_armed_by?: string
  last_backfill_at?: string
}

const CARDS: { key: Exclude<SectionKey, 'home'>; icon: string; title: string; desc: string; tags: string }[] = [
  { key: 'general',       icon: '⚙️',  title: 'General Settings',         desc: 'Company profile, modules, data export & app download.', tags: 'general company profile gstin cin export download apk modules' },
  { key: 'attendance',    icon: '📅',  title: 'Attendance Settings',      desc: 'WiFi rules, face/GPS verification, work-day defaults.',  tags: 'attendance wifi face gps location punch verify' },
  { key: 'notifications', icon: '🔔',  title: 'Notification Settings',    desc: 'Daily report recipients & Google Sheet sync.',          tags: 'notification email daily report google sheet sync webhook' },
  { key: 'roles',         icon: '👥',  title: 'Role & Permission Settings', desc: 'Module visibility, branch access, custom roles.',     tags: 'role permission visibility branch access custom roles users' },
]

const INPUT = 'w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20'
const INPUT_ERR = 'w-full rounded-xl border border-red-400 bg-red-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-200'
const BTN_PRI = 'rounded-lg bg-[#1f5e3b] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#17472d] disabled:opacity-60'
const BTN_SEC = 'rounded-lg border border-[#1f5e3b]/20 px-4 py-2 text-xs font-semibold text-[#1f5e3b] transition hover:bg-[#1f5e3b]/5'
const BTN_DANGER = 'rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50'

// ── Toast ─────────────────────────────────────────────────────────────────
type ToastKind = 'success' | 'error' | 'info'
type Toast = { id: number; kind: ToastKind; text: string }

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`flex max-w-sm cursor-pointer items-start gap-2 rounded-xl px-4 py-3 text-sm shadow-lg ${
            t.kind === 'success' ? 'bg-emerald-600 text-white' :
            t.kind === 'error'   ? 'bg-red-600 text-white' :
                                   'bg-[#1f5e3b] text-white'
          }`}
        >
          <span>{t.kind === 'success' ? '✅' : t.kind === 'error' ? '⚠️' : 'ℹ️'}</span>
          <span className="flex-1">{t.text}</span>
          <span className="opacity-70">✕</span>
        </div>
      ))}
    </div>
  )
}

// ── Toggle ────────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-xl border border-[#1f5e3b]/12 bg-white px-4 py-3 transition hover:bg-[#f7fbf8]">
      <div>
        <p className="text-sm font-medium text-[#14261a]">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] text-[#1f5e3b]/55">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative ml-3 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-[#1f5e3b]' : 'bg-gray-300'}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </label>
  )
}

// ── Sticky Save Bar ───────────────────────────────────────────────────────
function StickyBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset?: () => void }) {
  if (!dirty) return null
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[#1f5e3b]/10 bg-white/95 px-4 py-3 shadow-[0_-4px_18px_rgba(31,94,59,0.08)] backdrop-blur sm:-mx-6 sm:px-6">
      <p className="text-xs font-semibold text-amber-700">⚠ You have unsaved changes</p>
      <div className="flex gap-2">
        {onReset && <button type="button" onClick={onReset} className={BTN_SEC}>Reset</button>}
        <button type="button" onClick={onSave} disabled={saving} className={BTN_PRI}>
          {saving ? 'Saving…' : '💾 Save Changes'}
        </button>
      </div>
    </div>
  )
}

function SectionHeader({ icon, title, subtitle, onBack }: { icon: string; title: string; subtitle: string; onBack: () => void }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <button type="button" onClick={onBack} className={BTN_SEC + ' shrink-0'}>← Back</button>
        <div>
          <h1 className="text-2xl font-bold text-[#1f5e3b]">{icon} {title}</h1>
          <p className="mt-1 text-sm text-[#1f5e3b]/65">{subtitle}</p>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// HUB
// ────────────────────────────────────────────────────────────────────────────
function SettingsHub({ onPick }: { onPick: (k: Exclude<SectionKey, 'home'>) => void }) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return CARDS
    return CARDS.filter((c) => `${c.title} ${c.desc} ${c.tags}`.toLowerCase().includes(q))
  }, [search])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Settings</h1>
        <p className="mt-1 text-sm text-[#1f5e3b]/65">Manage your company configuration. Tap any card to open its options.</p>
      </div>

      <div className="relative">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Search settings (e.g. wifi, role, email, export)…"
          className="w-full rounded-2xl border border-[#1f5e3b]/15 bg-white px-5 py-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {filtered.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick(c.key)}
            className="ph-card group flex items-start gap-4 rounded-2xl p-6 text-left transition hover:-translate-y-0.5 hover:shadow-lg"
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#1f5e3b]/8 text-2xl">{c.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-[#1f5e3b]">{c.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-[#1f5e3b]/65">{c.desc}</p>
              <p className="mt-3 text-[11px] font-semibold text-[#1f5e3b] opacity-0 transition group-hover:opacity-100">Open →</p>
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="col-span-full rounded-xl bg-amber-50 p-6 text-center text-sm text-amber-800">
            No settings match "{search}". Try a different keyword.
          </p>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// GENERAL SECTION
// ────────────────────────────────────────────────────────────────────────────
function GeneralSection({ onBack, pushToast }: { onBack: () => void; pushToast: (k: ToastKind, t: string) => void }) {
  const { user } = useAuth()
  const isSuper = user?.role === 'SUPER_ADMIN'

  const profileQ = useQuery({ queryKey: ['company-profile'], queryFn: () => api<{ profile: CompanyProfile }>('/company/profile') })
  const apkQ     = useQuery({ queryKey: ['mobile-apk'],      queryFn: () => api<{ apk_url: string; note: string }>('/mobile/apk') })
  const settingsQ = useQuery({ queryKey: ['settings', 'all'], queryFn: () => api<Record<string, unknown>>('/settings') })

  const [profile, setProfile] = useState<CompanyProfile | null>(null)
  const [original, setOriginal] = useState<CompanyProfile | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [savingProfile, setSavingProfile] = useState(false)

  const [modules, setModules] = useState<Record<string, boolean>>({})
  const [originalModules, setOriginalModules] = useState<Record<string, boolean>>({})
  const [savingModules, setSavingModules] = useState(false)

  useEffect(() => {
    if (profileQ.data?.profile) {
      setProfile(profileQ.data.profile)
      setOriginal(profileQ.data.profile)
    }
  }, [profileQ.data])

  useEffect(() => {
    const f = ((settingsQ.data?.features as Record<string, boolean>) || {})
    if (Object.keys(f).length) {
      const defaults: Record<string, boolean> = {
        attendance: true, leave: true, kiosk: true, staff: true,
        documents: true, payroll: true, notices: true,
      }
      const merged = { ...defaults, ...f }
      setModules(merged)
      setOriginalModules(merged)
    }
  }, [settingsQ.data])

  const profileDirty = !!profile && !!original && JSON.stringify(profile) !== JSON.stringify(original)
  const modulesDirty = JSON.stringify(modules) !== JSON.stringify(originalModules)

  function validateProfile(p: CompanyProfile): Record<string, string> {
    const e: Record<string, string> = {}
    if (!p.legal_name?.trim() && !p.company_name?.trim()) e.legal_name = 'Company name is required.'
    if (!p.email?.trim()) e.email = 'Email is required.'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim())) e.email = 'Enter a valid email address.'
    if (p.gstin && p.gstin.trim().length > 0 && p.gstin.trim().length < 15) e.gstin = 'GSTIN must be 15 characters.'
    if (p.pincode && !/^\d{6}$/.test(p.pincode.trim())) e.pincode = 'Pincode must be 6 digits.'
    return e
  }

  async function saveProfile() {
    if (!profile) return
    const e = validateProfile(profile)
    setErrors(e)
    if (Object.keys(e).length) {
      pushToast('error', 'Please fix the highlighted fields.')
      return
    }
    setSavingProfile(true)
    try {
      await api('/company/profile', { method: 'PATCH', body: JSON.stringify(profile) })
      setOriginal(profile)
      pushToast('success', 'Company profile saved.')
    } catch (ex) {
      pushToast('error', `Failed to save: ${(ex as Error).message}`)
    } finally {
      setSavingProfile(false)
    }
  }

  async function saveModules() {
    setSavingModules(true)
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ features: modules }) })
      setOriginalModules(modules)
      pushToast('success', 'Module settings saved.')
    } catch (ex) {
      pushToast('error', `Failed to save modules: ${(ex as Error).message}`)
    } finally {
      setSavingModules(false)
    }
  }

  async function downloadExport(path: '/system/export.xlsx' | '/system/export.pdf', name: string) {
    try {
      const token = getToken()
      const res = await fetch(apiFetchUrl(path), {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!res.ok) {
        if (res.status === 401) throw new Error('Session expired — log in again.')
        if (res.status === 403) throw new Error('Only Super Admin can export full system data.')
        throw new Error(`Export failed (HTTP ${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = name
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
      pushToast('success', `Downloaded "${name}" (${Math.round(blob.size / 1024)} KB)`)
    } catch (ex) {
      pushToast('error', (ex as Error).message)
    }
  }

  if (profileQ.isLoading || settingsQ.isLoading || !profile) return <PageSkeleton rows={5} />

  return (
    <div className="space-y-6 pb-4">
      <SectionHeader icon="⚙️" title="General Settings" subtitle="Company profile, feature modules, data export and mobile app." onBack={onBack} />

      {/* Company Profile */}
      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-base font-semibold text-[#1f5e3b]">🏢 Company Profile</h2>
        <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Basic legal and contact information.</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <FieldInput label="Legal Name *" value={profile.legal_name || ''} onChange={(v) => setProfile({ ...profile, legal_name: v, company_name: v })} error={errors.legal_name} disabled={!isSuper} />
          <FieldInput label="GSTIN" value={profile.gstin || ''} onChange={(v) => setProfile({ ...profile, gstin: v.toUpperCase() })} error={errors.gstin} placeholder="15 chars" disabled={!isSuper} />
          <FieldInput label="CIN" value={profile.cin || ''} onChange={(v) => setProfile({ ...profile, cin: v.toUpperCase() })} disabled={!isSuper} />
          <FieldInput label="Company Email *" type="email" value={profile.email || ''} onChange={(v) => setProfile({ ...profile, email: v })} error={errors.email} disabled={!isSuper} />
          <FieldInput label="Authorised Signatory" value={profile.authorized_signatory || ''} onChange={(v) => setProfile({ ...profile, authorized_signatory: v, director: v })} disabled={!isSuper} />
          <FieldInput label="Pincode" value={profile.pincode || ''} onChange={(v) => setProfile({ ...profile, pincode: v.replace(/\D/g, '').slice(0, 6) })} error={errors.pincode} disabled={!isSuper} />
          <FieldInput label="City" value={profile.city || ''} onChange={(v) => setProfile({ ...profile, city: v })} disabled={!isSuper} />
          <FieldInput label="State" value={profile.state || ''} onChange={(v) => setProfile({ ...profile, state: v })} disabled={!isSuper} />
          <div className="sm:col-span-2">
            <FieldInput label="Full Address" value={profile.legal_address || profile.address || ''} onChange={(v) => setProfile({ ...profile, legal_address: v, address: v })} disabled={!isSuper} />
          </div>
        </div>

        {!isSuper && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">View only — Super Admin can edit company profile.</p>}
        {isSuper && <StickyBar dirty={profileDirty} saving={savingProfile} onSave={saveProfile} onReset={() => { setProfile(original); setErrors({}) }} />}
      </div>

      {/* Feature Modules */}
      {isSuper && (
        <div className="ph-card rounded-2xl p-6">
          <h2 className="text-base font-semibold text-[#1f5e3b]">🧩 Feature Modules</h2>
          <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Turn entire modules on/off across the system.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {Object.keys(modules).map((k) => (
              <Toggle key={k} checked={!!modules[k]} onChange={(v) => setModules((p) => ({ ...p, [k]: v }))} label={k.charAt(0).toUpperCase() + k.slice(1)} />
            ))}
          </div>
          <StickyBar dirty={modulesDirty} saving={savingModules} onSave={saveModules} onReset={() => setModules(originalModules)} />
        </div>
      )}

      {/* Data Export & App */}
      {isSuper && (
        <div className="ph-card rounded-2xl p-6">
          <h2 className="text-base font-semibold text-[#1f5e3b]">📦 Data Export &amp; Mobile App</h2>
          <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Download full system data as backup, or get the staff mobile app.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => downloadExport('/system/export.xlsx', `full-system-${new Date().toISOString().slice(0, 10)}.xlsx`)} className={BTN_PRI}>📊 Export All Data (Excel)</button>
            <button type="button" onClick={() => downloadExport('/system/export.pdf', `full-system-${new Date().toISOString().slice(0, 10)}.pdf`)} className={BTN_SEC}>📄 Export All Data (PDF)</button>
            {apkQ.data?.apk_url && <a href={apkQ.data.apk_url} className={BTN_SEC}>📱 Download HRMS Mobile App</a>}
          </div>
          <p className="mt-3 text-[11px] text-[#1f5e3b]/55">💡 Tip: Download monthly to keep a personal backup of all employees, attendance, payroll, leaves and documents.</p>
        </div>
      )}
    </div>
  )
}

function FieldInput({ label, value, onChange, error, type = 'text', placeholder, disabled }: { label: string; value: string; onChange: (v: string) => void; error?: string; type?: string; placeholder?: string; disabled?: boolean }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-[#14261a]">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={(error ? INPUT_ERR : INPUT) + (disabled ? ' bg-gray-100 text-gray-500' : '')}
      />
      {error && <p className="mt-1 text-[11px] font-medium text-red-600">{error}</p>}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// ATTENDANCE SECTION
// ────────────────────────────────────────────────────────────────────────────
function AttendanceSection({ onBack, pushToast }: { onBack: () => void; pushToast: (k: ToastKind, t: string) => void }) {
  const { user } = useAuth()
  const isSuper = user?.role === 'SUPER_ADMIN'

  const wifiQ = useQuery({ queryKey: ['wifi-config'], queryFn: () => api<{ enabled: boolean; networks: WifiNetwork[] }>('/attendance/wifi-config'), enabled: isSuper })
  const settingsQ = useQuery({ queryKey: ['settings', 'all'], queryFn: () => api<Record<string, unknown>>('/settings') })

  const [wifiEnabled, setWifiEnabled] = useState(false)
  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[]>([])
  const [origWifi, setOrigWifi] = useState<{ enabled: boolean; networks: WifiNetwork[] }>({ enabled: false, networks: [] })
  const [savingWifi, setSavingWifi] = useState(false)

  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [origFeatures, setOrigFeatures] = useState<Record<string, boolean>>({})
  const [savingFeatures, setSavingFeatures] = useState(false)

  useEffect(() => {
    if (wifiQ.data) {
      setWifiEnabled(!!wifiQ.data.enabled)
      const nets = Array.isArray(wifiQ.data.networks) ? wifiQ.data.networks : []
      setWifiNetworks(nets)
      setOrigWifi({ enabled: !!wifiQ.data.enabled, networks: nets })
    }
  }, [wifiQ.data])

  useEffect(() => {
    const f = ((settingsQ.data?.features as Record<string, boolean>) || {})
    const att = {
      face_verification: !!f.face_verification,
      gps_verification: !!f.gps_verification,
      wifi_restriction: !!f.wifi_restriction,
      auto_mark_absent: !!f.auto_mark_absent,
      late_grace_period: !!f.late_grace_period,
    }
    setFeatures(att)
    setOrigFeatures(att)
  }, [settingsQ.data])

  const wifiDirty = JSON.stringify({ enabled: wifiEnabled, networks: wifiNetworks }) !== JSON.stringify(origWifi)
  const featuresDirty = JSON.stringify(features) !== JSON.stringify(origFeatures)

  async function saveWifi() {
    // Validate: at least one SSID if enabled
    if (wifiEnabled && wifiNetworks.filter((n) => n.ssid?.trim()).length === 0) {
      pushToast('error', 'Add at least one WiFi network when restriction is enabled.')
      return
    }
    setSavingWifi(true)
    try {
      const cleaned = wifiNetworks.filter((n) => n.ssid?.trim() || n.ip_subnet?.trim())
      await api('/attendance/wifi-config', { method: 'PATCH', body: JSON.stringify({ enabled: wifiEnabled, networks: cleaned }) })
      setOrigWifi({ enabled: wifiEnabled, networks: cleaned })
      setWifiNetworks(cleaned)
      pushToast('success', 'WiFi settings saved.')
    } catch (ex) {
      pushToast('error', `Failed: ${(ex as Error).message}`)
    } finally {
      setSavingWifi(false)
    }
  }

  async function saveFeatures() {
    setSavingFeatures(true)
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ features }) })
      setOrigFeatures(features)
      pushToast('success', 'Attendance rules saved.')
    } catch (ex) {
      pushToast('error', `Failed: ${(ex as Error).message}`)
    } finally {
      setSavingFeatures(false)
    }
  }

  if (!isSuper) {
    return (
      <div className="space-y-6 pb-4">
        <SectionHeader icon="📅" title="Attendance Settings" subtitle="Only Super Admin can configure attendance rules." onBack={onBack} />
        <div className="ph-card rounded-2xl p-8 text-center text-sm text-[#1f5e3b]/70">
          Please contact your Super Admin to change attendance settings.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-4">
      <SectionHeader icon="📅" title="Attendance Settings" subtitle="WiFi, face & GPS verification rules." onBack={onBack} />

      {/* Verification Rules */}
      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-base font-semibold text-[#1f5e3b]">🛡 Verification Rules</h2>
        <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Choose how staff can punch in.</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Toggle checked={!!features.face_verification} onChange={(v) => setFeatures({ ...features, face_verification: v })} label="Face Verification" hint="Staff must scan face on punch" />
          <Toggle checked={!!features.gps_verification}  onChange={(v) => setFeatures({ ...features, gps_verification: v })}  label="GPS / Location Check" hint="Punch must be within branch radius" />
          <Toggle checked={!!features.wifi_restriction}  onChange={(v) => setFeatures({ ...features, wifi_restriction: v })}  label="WiFi Restriction" hint="Punch only on office WiFi" />
          <Toggle checked={!!features.auto_mark_absent}  onChange={(v) => setFeatures({ ...features, auto_mark_absent: v })}  label="Auto-mark Absent" hint="If no punch by end of day" />
        </div>
        <StickyBar dirty={featuresDirty} saving={savingFeatures} onSave={saveFeatures} onReset={() => setFeatures(origFeatures)} />
      </div>

      {/* WiFi Networks */}
      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-base font-semibold text-[#1f5e3b]">📶 Office WiFi Networks</h2>
        <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Only these WiFi networks will allow punch-in (when WiFi Restriction is on).</p>

        <div className="mt-4">
          <Toggle checked={wifiEnabled} onChange={setWifiEnabled} label="Enable WiFi-based attendance" />
        </div>

        {wifiEnabled && (
          <div className="mt-4 space-y-2">
            {wifiNetworks.length === 0 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">No networks added. Click "+ Add Network" below.</p>
            )}
            {wifiNetworks.map((n, i) => (
              <div key={i} className="grid gap-2 rounded-xl border border-[#1f5e3b]/12 bg-[#f7fbf8] p-3 sm:grid-cols-[1fr_1fr_140px_auto]">
                <input value={n.ssid} onChange={(e) => setWifiNetworks((p) => p.map((x, idx) => idx === i ? { ...x, ssid: e.target.value } : x))} placeholder="WiFi SSID *" className={INPUT} />
                <input value={n.password} onChange={(e) => setWifiNetworks((p) => p.map((x, idx) => idx === i ? { ...x, password: e.target.value } : x))} placeholder="Password" className={INPUT} type="password" />
                <input value={n.ip_subnet || ''} onChange={(e) => setWifiNetworks((p) => p.map((x, idx) => idx === i ? { ...x, ip_subnet: e.target.value } : x))} placeholder="IP prefix (e.g. 192.168.1)" className={INPUT} />
                <button type="button" onClick={() => setWifiNetworks((p) => p.filter((_, idx) => idx !== i))} className={BTN_DANGER}>Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => setWifiNetworks((p) => [...p, { ssid: '', password: '', ip_subnet: '' }])} className={BTN_SEC}>+ Add WiFi Network</button>
          </div>
        )}

        <StickyBar dirty={wifiDirty} saving={savingWifi} onSave={saveWifi} onReset={() => { setWifiEnabled(origWifi.enabled); setWifiNetworks(origWifi.networks) }} />
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// NOTIFICATIONS SECTION
// ────────────────────────────────────────────────────────────────────────────
function SmtpStatusBanner() {
  const q = useQuery({
    queryKey: ['smtp-status'],
    queryFn: () => api<{ configured: boolean; host: string | null; from: string | null }>('/settings/daily-report/smtp-status'),
  })
  if (q.isLoading || !q.data) return null
  if (q.data.configured) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span>Email server connected ({q.data.host}). Reports will be sent from <strong>{q.data.from}</strong>.</span>
      </div>
    )
  }
  return (
    <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
      <div className="flex items-center gap-2 font-semibold"><span className="h-2 w-2 rounded-full bg-amber-500" /> Email server not configured</div>
      <p className="mt-1.5 leading-relaxed">
        Daily reports cannot be sent until SMTP credentials are added. Ask your developer to set these environment secrets:
        <code className="ml-1 rounded bg-white/60 px-1">SMTP_HOST</code>,
        <code className="ml-1 rounded bg-white/60 px-1">SMTP_PORT</code>,
        <code className="ml-1 rounded bg-white/60 px-1">SMTP_USER</code>,
        <code className="ml-1 rounded bg-white/60 px-1">SMTP_PASS</code>,
        <code className="ml-1 rounded bg-white/60 px-1">SMTP_FROM</code>.
        For Gmail use an App Password (host: <code>smtp.gmail.com</code>, port: <code>587</code>).
      </p>
    </div>
  )
}

function SendTestEmailButton({ recipients, pushToast }: { recipients: string; pushToast: (k: ToastKind, t: string) => void }) {
  const [sending, setSending] = useState(false)
  async function send() {
    const list = recipients.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length === 0) {
      pushToast('error', 'Add at least one recipient before sending a test email.')
      return
    }
    if (!confirm(`Send a test daily report email now to:\n${list.join(', ')}?`)) return
    setSending(true)
    try {
      await api('/settings/daily-report/test', { method: 'POST', body: '{}' })
      pushToast('success', `Test email sent to ${list.length} recipient${list.length > 1 ? 's' : ''}. Check inbox (and spam folder).`)
    } catch (ex) {
      const msg = (ex as Error).message || 'Failed'
      if (msg.includes('SMTP not configured')) {
        pushToast('error', 'SMTP server not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS in environment secrets.')
      } else {
        pushToast('error', `Failed to send: ${msg}`)
      }
    } finally {
      setSending(false)
    }
  }
  return (
    <button
      type="button"
      onClick={send}
      disabled={sending}
      className="rounded-lg border border-[#1f5e3b]/20 bg-white px-3 py-2 text-xs font-semibold text-[#1f5e3b] hover:bg-[#f5faf6] disabled:opacity-50"
    >
      {sending ? 'Sending…' : '✉️ Send Test Email Now'}
    </button>
  )
}

type DailyReportRow = {
  userId: number; name: string; loginId: string | null; branch: string;
  status: string; statusLabel: string;
  punchInTime: string; punchOutTime: string;
  workMinutes: number; workHours: string;
  missedPunchOut: boolean;
}
type DailyReportData = {
  date: string;
  summary: {
    total: number; present: number; late: number; halfDay: number; absent: number;
    missedPunchOut: number; totalWorkHours: number; avgWorkHours: number;
    leavePending: number; leaveApprovedToday: number;
  };
  byBranch: { branch: string; total: number; present: number; late: number; halfDay: number; absent: number }[];
  rows: DailyReportRow[];
}

const STATUS_COLORS: Record<string, { bg: string; fg: string; bar: string }> = {
  present:  { bg: 'bg-emerald-100', fg: 'text-emerald-800', bar: 'bg-emerald-500' },
  late:     { bg: 'bg-amber-100',   fg: 'text-amber-800',   bar: 'bg-amber-500' },
  half_day: { bg: 'bg-blue-100',    fg: 'text-blue-800',    bar: 'bg-blue-500' },
  half:     { bg: 'bg-blue-100',    fg: 'text-blue-800',    bar: 'bg-blue-500' },
  absent:   { bg: 'bg-red-100',     fg: 'text-red-800',     bar: 'bg-red-500' },
}

function DailyReportPreview() {
  const [date, setDate] = useState(() => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10))
  const [filter, setFilter] = useState<'all' | 'present' | 'late' | 'half' | 'absent' | 'missed'>('all')
  const [expanded, setExpanded] = useState(false)
  const q = useQuery({
    queryKey: ['daily-report-preview', date],
    queryFn: () => api<DailyReportData>(`/reports/daily-attendance?date=${date}`),
  })

  if (q.isLoading) return <div className="mt-4 rounded-xl bg-[#f5faf6] p-4 text-xs text-[#1f5e3b]/60">Loading today's snapshot…</div>
  if (q.error || !q.data) return <div className="mt-4 rounded-xl bg-red-50 p-4 text-xs text-red-700">Failed to load report: {(q.error as Error)?.message || 'unknown'}</div>

  const d = q.data
  const s = d.summary
  const total = Math.max(s.total, 1)
  const presentPct = Math.round((s.present / total) * 100)
  const latePct = Math.round((s.late / total) * 100)
  const halfPct = Math.round((s.halfDay / total) * 100)
  const absentPct = Math.round((s.absent / total) * 100)

  const filteredRows = d.rows.filter((r) => {
    if (filter === 'all') return true
    if (filter === 'missed') return r.missedPunchOut
    if (filter === 'half') return r.status === 'half' || r.status === 'half_day'
    return r.status === filter
  })

  return (
    <div className="mt-4 rounded-xl border border-[#1f5e3b]/15 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1f5e3b]/10 p-4">
        <div>
          <h3 className="text-sm font-semibold text-[#1f5e3b]">📊 Today's Snapshot — Email Preview</h3>
          <p className="mt-0.5 text-[11px] text-[#1f5e3b]/55">Same data your recipients will receive at 7 PM IST.</p>
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-[#1f5e3b]/20 bg-white px-2 py-1 text-xs text-[#14261a]"
        />
      </div>

      <div className="p-4 space-y-4">
        {/* 4 stat cards */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { key: 'present', label: 'Present', val: s.present, pct: presentPct, ring: 'border-l-emerald-500 bg-emerald-50 text-emerald-800' },
            { key: 'late',    label: 'Late',    val: s.late,    pct: latePct,    ring: 'border-l-amber-500 bg-amber-50 text-amber-800' },
            { key: 'half',    label: 'Half Day',val: s.halfDay, pct: halfPct,    ring: 'border-l-blue-500 bg-blue-50 text-blue-800' },
            { key: 'absent',  label: 'Absent',  val: s.absent,  pct: absentPct,  ring: 'border-l-red-500 bg-red-50 text-red-800' },
          ].map((c) => (
            <button
              key={c.key}
              onClick={() => { setFilter(filter === c.key as typeof filter ? 'all' : c.key as typeof filter); setExpanded(true) }}
              className={`rounded-lg border-l-4 p-3 text-left transition hover:scale-[1.02] ${c.ring} ${filter === c.key ? 'ring-2 ring-[#1f5e3b]/40' : ''}`}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wide opacity-80">{c.label}</div>
              <div className="text-2xl font-bold leading-none mt-1">{c.val}</div>
              <div className="text-[10px] opacity-70 mt-0.5">{c.pct}% of {s.total}</div>
            </button>
          ))}
        </div>

        {/* Stacked bar chart */}
        <div>
          <div className="text-[11px] font-semibold text-[#14261a]/70 mb-1.5">Attendance Distribution</div>
          <div className="flex h-6 overflow-hidden rounded-md bg-gray-200">
            {s.present > 0 && <div className="flex items-center justify-center bg-emerald-500 text-[10px] font-bold text-white" style={{ width: `${presentPct}%` }}>{s.present}</div>}
            {s.late > 0 && <div className="flex items-center justify-center bg-amber-500 text-[10px] font-bold text-white" style={{ width: `${latePct}%` }}>{s.late}</div>}
            {s.halfDay > 0 && <div className="flex items-center justify-center bg-blue-500 text-[10px] font-bold text-white" style={{ width: `${halfPct}%` }}>{s.halfDay}</div>}
            {s.absent > 0 && <div className="flex items-center justify-center bg-red-500 text-[10px] font-bold text-white" style={{ width: `${absentPct}%` }}>{s.absent}</div>}
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg bg-gray-50 p-2.5">
            <div className="text-[10px] font-semibold uppercase text-gray-500">Total Hours</div>
            <div className="text-base font-bold text-[#14261a]">{s.totalWorkHours}h</div>
          </div>
          <div className="rounded-lg bg-gray-50 p-2.5">
            <div className="text-[10px] font-semibold uppercase text-gray-500">Avg / Staff</div>
            <div className="text-base font-bold text-[#14261a]">{s.avgWorkHours}h</div>
          </div>
          <button
            onClick={() => { setFilter(filter === 'missed' ? 'all' : 'missed'); setExpanded(true) }}
            className={`rounded-lg p-2.5 text-left transition hover:scale-[1.02] ${s.missedPunchOut > 0 ? 'bg-orange-50' : 'bg-gray-50'} ${filter === 'missed' ? 'ring-2 ring-orange-400' : ''}`}
          >
            <div className="text-[10px] font-semibold uppercase text-orange-700">⚠ Missed Out</div>
            <div className="text-base font-bold text-orange-900">{s.missedPunchOut}</div>
          </button>
          <div className="rounded-lg bg-purple-50 p-2.5">
            <div className="text-[10px] font-semibold uppercase text-purple-700">On Leave</div>
            <div className="text-base font-bold text-purple-900">{s.leaveApprovedToday}<span className="ml-1 text-[10px] font-normal text-gray-500">/{s.leavePending} pend</span></div>
          </div>
        </div>

        {/* Branch breakdown */}
        {d.byBranch.length > 1 && (
          <div>
            <div className="text-[11px] font-semibold text-[#14261a]/70 mb-1.5">🏢 Branch-wise</div>
            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">Branch</th>
                    <th className="px-2 py-1.5 text-center font-medium">Total</th>
                    <th className="px-2 py-1.5 text-center font-medium text-emerald-700">P</th>
                    <th className="px-2 py-1.5 text-center font-medium text-amber-700">L</th>
                    <th className="px-2 py-1.5 text-center font-medium text-blue-700">H</th>
                    <th className="px-2 py-1.5 text-center font-medium text-red-700">A</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byBranch.map((b) => (
                    <tr key={b.branch} className="border-t border-gray-100">
                      <td className="px-2 py-1.5">{b.branch}</td>
                      <td className="px-2 py-1.5 text-center">{b.total}</td>
                      <td className="px-2 py-1.5 text-center font-semibold text-emerald-700">{b.present}</td>
                      <td className="px-2 py-1.5 text-center font-semibold text-amber-700">{b.late}</td>
                      <td className="px-2 py-1.5 text-center font-semibold text-blue-700">{b.halfDay}</td>
                      <td className="px-2 py-1.5 text-center font-semibold text-red-700">{b.absent}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Per-user detail (collapsible) */}
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center justify-between rounded-lg bg-[#f5faf6] px-3 py-2 text-xs font-semibold text-[#1f5e3b] hover:bg-[#ebf4ee]"
          >
            <span>👥 Staff Detail ({filteredRows.length}{filter !== 'all' ? ` of ${d.rows.length}` : ''})</span>
            <span>{expanded ? '▲' : '▼'}</span>
          </button>
          {expanded && (
            <div className="mt-2">
              {filter !== 'all' && (
                <div className="mb-2 flex items-center justify-between rounded-md bg-blue-50 px-3 py-1.5 text-[11px] text-blue-800">
                  <span>Filtered: <strong>{filter}</strong></span>
                  <button onClick={() => setFilter('all')} className="font-semibold underline">Clear</button>
                </div>
              )}
              <div className="max-h-96 overflow-y-auto rounded-lg border border-gray-100">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Name / ID</th>
                      <th className="px-2 py-1.5 text-left font-medium">Branch</th>
                      <th className="px-2 py-1.5 text-center font-medium">Status</th>
                      <th className="px-2 py-1.5 text-center font-medium">In</th>
                      <th className="px-2 py-1.5 text-center font-medium">Out</th>
                      <th className="px-2 py-1.5 text-right font-medium">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.length === 0 ? (
                      <tr><td colSpan={6} className="px-2 py-4 text-center text-gray-400">No matching staff</td></tr>
                    ) : filteredRows.map((r) => {
                      const c = STATUS_COLORS[r.status] || STATUS_COLORS.absent
                      return (
                        <tr key={r.userId} className="border-t border-gray-100 hover:bg-gray-50">
                          <td className="px-2 py-1.5">
                            <div className="font-medium text-[#14261a]">{r.name}</div>
                            <div className="text-[10px] text-gray-400">{r.loginId}</div>
                          </td>
                          <td className="px-2 py-1.5 text-gray-600">{r.branch}</td>
                          <td className="px-2 py-1.5 text-center">
                            <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${c.bg} ${c.fg}`}>{r.statusLabel}</span>
                          </td>
                          <td className="px-2 py-1.5 text-center font-mono text-[11px]">{r.punchInTime}</td>
                          <td className="px-2 py-1.5 text-center font-mono text-[11px]">{r.punchOutTime}{r.missedPunchOut && <span className="ml-0.5 text-red-500">⚠</span>}</td>
                          <td className="px-2 py-1.5 text-right font-semibold text-[#1f5e3b]">{r.workHours}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NotificationsSection({ onBack, pushToast }: { onBack: () => void; pushToast: (k: ToastKind, t: string) => void }) {
  const { user } = useAuth()
  const isSuper = user?.role === 'SUPER_ADMIN'

  const dailyQ = useQuery({
    queryKey: ['daily-report'],
    queryFn: () => api<{ enabled?: boolean; recipients?: string[] }>('/settings/daily-report'),
    enabled: isSuper,
  })
  const sheetQ = useQuery({
    queryKey: ['sheet-status'],
    queryFn: () => api<SheetStatus>('/integrations/sheets/status'),
    enabled: isSuper,
  })
  const appsScriptStatusQ = useQuery({
    queryKey: ['apps-script-status'],
    queryFn: () => api<{
      enabled: boolean;
      queue_pending: number;
      queue_dead: number;
      auto_pull: { at: string; ok: boolean; summary: string | null; error: string | null; from?: string; to?: string } | null;
      auto_pull_interval_sec: number;
      absent_push: { at: string; ok: boolean; date?: string; count?: number; skipped?: boolean; reason?: string | null; error?: string | null } | null;
      absent_push_hour_ist: string;
    }>('/integrations/apps-script/status'),
    enabled: isSuper,
    refetchInterval: 60_000,
  })

  const [enabled, setEnabled] = useState(true)
  const [emails, setEmails] = useState('')
  const [origEnabled, setOrigEnabled] = useState(true)
  const [origEmails, setOrigEmails] = useState('')
  const [emailErrors, setEmailErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const [showSheetModal, setShowSheetModal] = useState(false)
  const [sheetWebhook, setSheetWebhook] = useState('')
  const [sheetLink, setSheetLink] = useState('')
  const [sheetSaving, setSheetSaving] = useState(false)
  const [showScriptGuide, setShowScriptGuide] = useState(false)
  const [scriptCode, setScriptCode] = useState<string>('')
  const [scriptLoading, setScriptLoading] = useState(false)
  const [scriptCopied, setScriptCopied] = useState(false)
  const [scriptVariant, setScriptVariant] = useState<'simple' | 'full'>('full')
  const [bulkSyncing, setBulkSyncing] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [lastTestResult, setLastTestResult] = useState<{
    ok: boolean; title: string; detail?: string; hint?: string; at: string;
  } | null>(null)
  const [backfillFrom, setBackfillFrom] = useState('')
  const [backfillTo, setBackfillTo] = useState('')

  // Simple Attendance-only Apps Script — exactly the version requested for the
  // Copy Code button. Single tab "Attendance", 12-column upsert by unique_key.
  const SIMPLE_ATTENDANCE_SCRIPT = `const SHEET_NAME = "Attendance";

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    const rows = sheet.getDataRange().getValues();
    const headers = rows[0];

    const uniqueIndex = headers.indexOf("unique_key");

    if (uniqueIndex === -1) {
      return ContentService.createTextOutput("unique_key column missing");
    }

    let rowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
      if (rows[i][uniqueIndex] == data.unique_key) {
        rowIndex = i + 1;
        break;
      }
    }

    const rowData = [
      data.unique_key || "",
      data.employee_name || "UNKNOWN",
      data.employee_id || "",
      data.branch || "",
      data.role || "",
      data.date || "",
      data.attendance_mode || "",
      data.punch_in || "",
      data.punch_out || "",
      data.total_hours || "",
      data.status || "",
      data.notes || ""
    ];

    if (rowIndex === -1) {
      sheet.appendRow(rowData);
    } else {
      sheet.getRange(rowIndex, 1, 1, rowData.length).setValues([rowData]);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
`

  const activeScript = scriptVariant === 'simple' ? SIMPLE_ATTENDANCE_SCRIPT : scriptCode

  // Eagerly fetch the full Advanced script as soon as the page mounts so that
  // the default "Copy Code" button (Advanced variant) has content ready instantly.
  useEffect(() => {
    if (scriptCode || !isSuper) return
    let cancelled = false
    ;(async () => {
      setScriptLoading(true)
      try {
        const r = await api<{ code: string }>('/integrations/sheets/script')
        if (!cancelled) setScriptCode(r.code || '')
      } catch {
        /* silent — modal will retry on open */
      } finally {
        if (!cancelled) setScriptLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper])

  async function openScriptGuide() {
    setShowScriptGuide(true)
    // Lazy-load full script in background if eager fetch failed
    if (scriptCode) return
    setScriptLoading(true)
    try {
      const r = await api<{ code: string }>('/integrations/sheets/script')
      setScriptCode(r.code || '')
    } catch (ex) {
      pushToast('error', `Failed to load full script: ${(ex as Error).message}`)
    } finally {
      setScriptLoading(false)
    }
  }

  // ── Push HRMS → Sheet (forward sync, always allowed) ──────────────────────
  async function runPushToSheet() {
    if (bulkSyncing) return
    if (!sheetConnected) {
      pushToast('error', 'Pehle "Connect Google Sheet" se webhook URL save karein.')
      return
    }
    const ok = window.confirm(
      'HRMS → Sheet push karega (Attendance, Users, Leave, Branches, Notices). Continue?'
    )
    if (!ok) return
    setBulkSyncing(true)
    try {
      const r = await api<{ ok: boolean; synced?: number; tabs?: Record<string, number>; error?: string; message?: string }>(
        '/integrations/apps-script/bulk-push',
        { method: 'POST', body: '{}' }
      )
      if (r?.ok === false) {
        pushToast('error', `Push failed: ${r.error || r.message || 'unknown'}`)
      } else {
        const tabs = r.tabs ? ` — ${Object.entries(r.tabs).map(([k, v]) => `${k}:${v}`).join(', ')}` : ''
        pushToast('success', `Push (HRMS→Sheet): ${r.synced ?? 0} chunks${tabs}`)
      }
      void sheetQ.refetch()
    } catch (ex) {
      pushToast('error', `Push failed: ${(ex as Error).message}`)
    } finally {
      setBulkSyncing(false)
    }
  }

  // ── Arm one-shot backfill (Sheet → HRMS) ──────────────────────────────────
  async function armBackfill() {
    const ok = window.confirm(
      '⚠ ARM BACKFILL — Sheet → HRMS\n\n' +
      'Iske baad ek-baar "Run Backfill Now" click karne se Google Sheet ka pura Attendance data HRMS me import ho jaayega (UPSERT).\n\n' +
      '• Deleted users ki rows skip ho jaayengi (re-import nahi hongi)\n' +
      '• Run hone ke baad arming AUTOMATICALLY off ho jaayegi\n' +
      '• Galti se dobara import na ho, isliye har baar Arm karna padega\n\n' +
      'Aage badhna hai?'
    )
    if (!ok) return
    try {
      await api('/integrations/sheets/arm-backfill', { method: 'POST', body: '{}' })
      pushToast('success', '✅ Backfill armed. Ab "Run Backfill Now" click karein (sirf 1 baar chalega).')
      void sheetQ.refetch()
    } catch (ex) {
      pushToast('error', `Arm failed: ${(ex as Error).message}`)
    }
  }

  async function disarmBackfill() {
    try {
      await api('/integrations/sheets/disarm-backfill', { method: 'POST', body: '{}' })
      pushToast('success', 'Backfill disarmed.')
      void sheetQ.refetch()
    } catch (ex) {
      pushToast('error', `Disarm failed: ${(ex as Error).message}`)
    }
  }

  async function runBackfillNow(opts?: { from?: string; to?: string }) {
    if (bulkSyncing) return
    const body: Record<string, string> = {}
    if (opts?.from) body.from = opts.from
    if (opts?.to)   body.to   = opts.to
    const isScoped = !!(opts?.from && opts?.to)
    setBulkSyncing(true)
    try {
      const p = await api<{ ok: boolean; total?: number; inserted?: number; updated?: number; failed?: number; skipped?: number; skippedDeleted?: number; skippedDeletedUsers?: string[]; error?: string; hint?: string; notArmed?: boolean; scoped?: boolean; from?: string; to?: string }>(
        '/integrations/apps-script/pull-from-sheet',
        { method: 'POST', body: JSON.stringify(body) }
      )
      if (p?.ok === false) {
        pushToast('error', `Backfill failed: ${p.error || 'unknown'}${p.hint ? ' — ' + p.hint : ''}`)
      } else {
        const delPart = p.skippedDeleted ? ` (incl. ${p.skippedDeleted} deleted-user rows)` : ''
        const scopeMsg = isScoped ? ` [${opts!.from} → ${opts!.to}]` : ' (full)'
        const armMsg = isScoped ? '' : ' Arming auto-cleared.'
        pushToast('success', `Backfill done${scopeMsg}: inserted=${p.inserted ?? 0}, updated=${p.updated ?? 0}, skipped=${p.skipped ?? 0}${delPart}, failed=${p.failed ?? 0} (of ${p.total ?? 0}).${armMsg}`)
      }
      void sheetQ.refetch()
    } catch (ex) {
      pushToast('error', `Backfill failed: ${(ex as Error).message}`)
    } finally {
      setBulkSyncing(false)
    }
  }

  // ── Test Apps Script connection (real ping with shared secret) ───────────
  async function testAppsScriptConnection() {
    setTestingConnection(true)
    try {
      const r = await api<{
        ok: boolean; pong?: boolean; service?: string; spreadsheet_name?: string;
        attendance_tab?: string; attendance_rows?: number; attendance_found?: boolean;
        autosync_enabled?: boolean; error?: string; hint?: string; urlInvalid?: boolean;
      }>('/integrations/apps-script/test-connection', { method: 'POST', body: '{}' })
      const now = new Date().toLocaleString()
      if (r?.ok === false) {
        // "Unknown command: ping" is a harmless health-check error — actual
        // sync (fetch_attendance + auto-pull) works without it. Don't scare
        // the user with a red toast for it.
        const isHarmlessPingError = /Unknown command/i.test(r.error || '')
        if (isHarmlessPingError) {
          pushToast('info', `ℹ Health-check ping unsupported by deployed Apps Script — actual sync chal raha hai (auto-pull active).`)
        } else {
          pushToast('error', `❌ Test failed: ${r.error || 'unknown'}`)
        }
        setLastTestResult({
          ok: false,
          title: r.error || 'Test failed',
          hint: r.hint,
          at: now,
        })
      } else {
        const tab = r.attendance_found ? `${r.attendance_tab} (${r.attendance_rows ?? 0} rows)` : '⚠ Attendance tab missing'
        const detail = `Connected to "${r.spreadsheet_name || 'sheet'}" — ${tab}. Apps Script autosync: ${r.autosync_enabled ? 'ON' : 'OFF'}`
        pushToast('success', `✅ ${detail}`)
        setLastTestResult({ ok: true, title: '✅ Connected', detail, at: now })
      }
      void sheetQ.refetch()
    } catch (ex) {
      const msg = (ex as Error).message
      pushToast('error', `Test failed: ${msg}`)
      setLastTestResult({ ok: false, title: 'Test failed', detail: msg, at: new Date().toLocaleString() })
    } finally {
      setTestingConnection(false)
    }
  }

  async function toggleSheetToPortal(next: boolean) {
    const confirmMsg = next
      ? '⚠ Sheet → Portal sync ENABLE karna hai?\n\n' +
        'Iske baad jab kisi ne Sheet me cell edit kiya (onSheetEdit trigger) ya kisi tarah POST aaya, woh seedha HRMS DB me update ho jaayega.\n\n' +
        'Default OFF rakhna safer hai. Sirf tab ON karein jab aap chahte hain ki Sheet hi master ho.\n\nAage badhna hai?'
      : 'Sheet → Portal sync turn OFF karna hai? Aage Sheet edits HRMS me re-import nahi honge.'
    if (!window.confirm(confirmMsg)) return
    try {
      await api('/integrations/sheets/connect', {
        method: 'PATCH',
        body: JSON.stringify({ sheet_to_portal_enabled: next }),
      })
      pushToast('success', next ? 'Sheet → Portal sync enabled.' : 'Sheet → Portal sync disabled.')
      void sheetQ.refetch()
    } catch (ex) {
      pushToast('error', (ex as Error).message)
    }
  }

  async function copyScript() {
    const text = activeScript
    if (!text) {
      pushToast('error', 'Script not ready yet.')
      return
    }
    // Primary: secure-context Clipboard API
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
        setScriptCopied(true)
        pushToast('success', `${text.length} chars copied — paste into Apps Script editor.`)
        setTimeout(() => setScriptCopied(false), 2000)
        return
      }
    } catch {
      /* fall through to textarea fallback */
    }
    // Fallback: hidden textarea + execCommand (mobile / non-HTTPS / older browsers)
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.top = '0'
      ta.style.left = '0'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) {
        setScriptCopied(true)
        pushToast('success', `${text.length} chars copied.`)
        setTimeout(() => setScriptCopied(false), 2000)
      } else {
        throw new Error('execCommand failed')
      }
    } catch {
      pushToast('error', 'Copy failed — please long-press the code block and copy manually.')
    }
  }

  useEffect(() => {
    if (dailyQ.data) {
      setEnabled(!!dailyQ.data.enabled)
      const e = (dailyQ.data.recipients || []).join(', ')
      setEmails(e)
      setOrigEnabled(!!dailyQ.data.enabled)
      setOrigEmails(e)
    }
  }, [dailyQ.data])

  useEffect(() => {
    if (sheetQ.data) {
      setSheetWebhook(sheetQ.data.default_webhook_url || '')
      setSheetLink(sheetQ.data.google_sheet_link || '')
    }
  }, [sheetQ.data])

  const dirty = enabled !== origEnabled || emails !== origEmails
  const sheetConnected = !!(sheetQ.data?.enabled && sheetQ.data?.default_webhook_url)

  // Auto-run a silent Test Connection once when Sheet is connected, so the
  // user immediately sees whether their deployed Apps Script version is
  // current — without having to click anything.
  useEffect(() => {
    if (!sheetConnected) return
    if (lastTestResult) return
    if (testingConnection) return
    void testAppsScriptConnection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetConnected])

  function validateEmails(): string[] {
    const list = emails.split(',').map((x) => x.trim()).filter(Boolean)
    const bad: string[] = []
    for (const e of list) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) bad.push(e)
    return bad
  }

  async function saveDaily() {
    const bad = validateEmails()
    if (bad.length) {
      setEmailErrors(bad)
      pushToast('error', `Invalid email${bad.length > 1 ? 's' : ''}: ${bad.join(', ')}`)
      return
    }
    setEmailErrors([])
    const list = emails.split(',').map((x) => x.trim()).filter(Boolean)
    if (enabled && list.length === 0) {
      pushToast('error', 'Add at least one recipient email when enabled.')
      return
    }
    setSaving(true)
    try {
      await api('/settings/daily-report', { method: 'PATCH', body: JSON.stringify({ enabled, recipients: list }) })
      setOrigEnabled(enabled); setOrigEmails(list.join(', ')); setEmails(list.join(', '))
      pushToast('success', 'Daily report settings saved.')
    } catch (ex) {
      pushToast('error', `Failed: ${(ex as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  async function saveSheet() {
    if (!sheetWebhook.trim()) {
      pushToast('error', 'Webhook URL is required to connect.')
      return
    }
    setSheetSaving(true)
    try {
      await api('/integrations/sheets/connect', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true, mode: 'webhook', google_sheet_link: sheetLink.trim(), default_webhook_url: sheetWebhook.trim() }),
      })
      pushToast('success', 'Google Sheet connected.')
      setShowSheetModal(false)
      void sheetQ.refetch()
    } catch (ex) {
      pushToast('error', `Failed: ${(ex as Error).message}`)
    } finally {
      setSheetSaving(false)
    }
  }

  async function manualSync() {
    try {
      const r = await api<{ synced: number; failed: number }>('/integrations/sheets/manual-sync', { method: 'POST', body: '{}' })
      pushToast('success', `Sync done: ${r.synced} synced, ${r.failed} failed`)
      void sheetQ.refetch()
    } catch (ex) {
      pushToast('error', (ex as Error).message)
    }
  }

  if (!isSuper) {
    return (
      <div className="space-y-6 pb-4">
        <SectionHeader icon="🔔" title="Notification Settings" subtitle="Only Super Admin can configure notifications." onBack={onBack} />
        <div className="ph-card rounded-2xl p-8 text-center text-sm text-[#1f5e3b]/70">
          Please contact your Super Admin to change notification settings.
        </div>
      </div>
    )
  }

  if (dailyQ.isLoading) return <PageSkeleton rows={4} />

  return (
    <div className="space-y-6 pb-4">
      <SectionHeader icon="🔔" title="Notification Settings" subtitle="Email reports and Google Sheet sync." onBack={onBack} />

      {/* Daily Report */}
      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-base font-semibold text-[#1f5e3b]">📧 Daily Attendance Report</h2>
        <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Auto-emailed every evening at 7:00 PM IST with the day's attendance summary.</p>

        <SmtpStatusBanner />

        <div className="mt-4 space-y-4">
          <Toggle checked={enabled} onChange={setEnabled} label="Send daily email report" />

          <div>
            <label className="mb-1 block text-xs font-medium text-[#14261a]">Recipients (comma separated) {enabled && '*'}</label>
            <input
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              placeholder="hr@company.com, manager@company.com"
              className={emailErrors.length ? INPUT_ERR : INPUT}
            />
            {emailErrors.length > 0 && (
              <p className="mt-1 text-[11px] font-medium text-red-600">Invalid: {emailErrors.join(', ')}</p>
            )}
            <p className="mt-1 text-[10px] text-[#1f5e3b]/55">Separate multiple emails with commas. Leave empty and disable toggle to stop reports.</p>
          </div>

          <SendTestEmailButton recipients={emails} pushToast={pushToast} />
        </div>

        <DailyReportPreview />

        <StickyBar dirty={dirty} saving={saving} onSave={saveDaily} onReset={() => { setEnabled(origEnabled); setEmails(origEmails); setEmailErrors([]) }} />
      </div>

      {/* Google Sheet Sync */}
      <div className="ph-card rounded-2xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#1f5e3b]">📊 Google Sheet Sync</h2>
            <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Auto-export attendance to a Google Sheet on every punch.</p>
          </div>
          {sheetConnected ? (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> Connected
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-600">Not connected</span>
          )}
        </div>

        {/* Sheet → Portal direction now uses a SERVER-SIDE poll worker
            (every 5 min) instead of Apps Script's onSheetEdit. This needs
            ZERO manual OAuth grant — Apps Script only needs the spreadsheet
            scope, which Google auto-grants on first run. Show a live status
            badge so the admin sees freshness at a glance. */}
        {sheetConnected && (() => {
          const ap = appsScriptStatusQ.data?.auto_pull
          const intervalSec = appsScriptStatusQ.data?.auto_pull_interval_sec || 300
          if (!ap) {
            return (
              <div className="mt-3 rounded-xl border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900">
                ⏳ <strong>Auto-pull worker</strong> initializing — first sync runs ~15 sec after server boot, then every {Math.round(intervalSec / 60)} min.
              </div>
            )
          }
          return (
            <div className={`mt-3 rounded-xl border p-3 text-xs ${
              ap.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-400 bg-amber-50 text-amber-900'
            }`}>
              <p className="font-semibold">
                {ap.ok ? '✅ Sheet → Portal auto-sync chal raha hai' : '⚠ Auto-pull last attempt failed'}
              </p>
              <p className="mt-1">
                Server har <strong>{Math.round(intervalSec / 60)} minute</strong> me Sheet ke last 7 din ka data automatically pull karta hai
                — aapko Apps Script me Authorize / external_request permission grant <strong>nahi karni padti</strong>.
              </p>
              {ap.ok && ap.summary && (
                <p className="mt-1 opacity-90">Last pull: <span className="font-mono">{ap.summary}</span> ({ap.from} → {ap.to})</p>
              )}
              {!ap.ok && ap.error && (
                <p className="mt-1 opacity-90">Error: <span className="font-mono">{ap.error}</span></p>
              )}
              <p className="mt-1 text-[10px] opacity-60">Last run: {new Date(ap.at).toLocaleString('en-IN')}</p>
            </div>
          )
        })()}

        {/* Absent-push direction: live punches stream to Sheet immediately,
            but employees who DON'T punch leave a gap. A daily worker (23:30 IST)
            pushes synthetic "absent" rows so every active employee has a row
            in the sheet for every working day. Manual button is also exposed. */}
        {sheetConnected && (() => {
          const apx = appsScriptStatusQ.data?.absent_push
          const hour = appsScriptStatusQ.data?.absent_push_hour_ist || '23:30'
          return (
            <div className={`mt-3 rounded-xl border p-3 text-xs ${
              !apx ? 'border-sky-300 bg-sky-50 text-sky-900'
                : apx.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : apx.skipped ? 'border-gray-300 bg-gray-50 text-gray-700'
                : 'border-amber-400 bg-amber-50 text-amber-900'
            }`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {!apx ? '🌙 Daily absent-push: scheduled' :
                     apx.ok ? '✅ Daily absent-push: last run successful' :
                     apx.skipped ? `🌙 Daily absent-push: ${apx.reason || 'waiting'}` :
                     '⚠ Daily absent-push: failed'}
                  </p>
                  <p className="mt-1">
                    Live punches turant Sheet me jaate hain. Jo employees punch nahi karte
                    unki "absent" rows har raat <strong>{hour} IST</strong> ko automatically Sheet me push hoti hain —
                    isse koi din ya koi employee miss nahi hota.
                  </p>
                  {apx?.ok && (
                    <p className="mt-1 opacity-90">
                      Last push: <span className="font-mono">{apx.count ?? 0} absent rows for {apx.date}</span>
                    </p>
                  )}
                  {apx?.error && (
                    <p className="mt-1 opacity-90">Error: <span className="font-mono">{apx.error}</span></p>
                  )}
                  {apx?.at && (
                    <p className="mt-1 text-[10px] opacity-60">Last run: {new Date(apx.at).toLocaleString('en-IN')}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const r = await api<{ ok: boolean; count?: number; date?: string; error?: string }>(
                        '/integrations/apps-script/push-absents',
                        { method: 'POST', body: '{}' }
                      )
                      if (r?.ok) {
                        pushToast('success', `✅ Absent push complete: ${r.count ?? 0} rows for ${r.date}`)
                      } else {
                        pushToast('error', `⚠ Absent push: ${r?.error || 'failed'}`)
                      }
                      appsScriptStatusQ.refetch()
                    } catch (e: any) {
                      pushToast('error', `⚠ Absent push failed: ${e?.message || 'unknown'}`)
                    }
                  }}
                  className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-[#1f5e3b] shadow-sm hover:bg-gray-50"
                  title="Force push absent rows for today right now (don't wait for 23:30 IST)"
                >
                  🌙 Push Now
                </button>
              </div>
            </div>
          )
        })()}

        {sheetConnected && sheetQ.data?.last_sync_at && (
          <p className="mt-3 rounded-lg bg-[#f5faf6] px-3 py-2 text-xs text-[#1f5e3b]/80">
            Last sync: {new Date(sheetQ.data.last_sync_at).toLocaleString('en-IN')}
          </p>
        )}
        {sheetConnected && sheetQ.data?.last_error && (() => {
          const err = sheetQ.data.last_error;
          const isWrongUrl =
            /HTTP 404/.test(err) ||
            /Web word processing|Google Drive/i.test(err) ||
            /not a deployed Apps Script/i.test(err) ||
            /docs\.google\.com|script\.google\.com\/d\//i.test(err) ||
            /must look like/i.test(err);
          return (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <p className="font-semibold">⚠ Last error: {err.slice(0, 220)}</p>
              {isWrongUrl && (
                <div className="mt-2 rounded-md border border-red-300 bg-white/70 p-2 text-[11px] text-red-800">
                  <p className="font-semibold">यह URL galat है — Apps Script Web App का URL चाहिए:</p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                    <li>Open <a href="https://script.google.com" target="_blank" rel="noreferrer" className="font-semibold underline">script.google.com</a> → अपना project खोलें (या naya banayein और hrms_sync.gs paste करें).</li>
                    <li><strong>Deploy → New deployment</strong> → Type: <strong>Web app</strong>.</li>
                    <li>Execute as: <strong>Me</strong> | Who has access: <strong>Anyone</strong> → <strong>Deploy</strong>.</li>
                    <li>Jo URL दिखे वो <code>https://script.google.com/macros/s/<strong>...</strong>/exec</code> से end होना chahiye.</li>
                    <li>उस URL को copy करके <code>GOOGLE_APPS_SCRIPT_WEBAPP_URL</code> secret में update करें.</li>
                  </ol>
                  <p className="mt-1 text-red-700">⛔ Sheet ka <code>/edit</code> URL ya script editor ka <code>/d/</code> URL kaam nahi karega.</p>
                </div>
              )}
            </div>
          );
        })()}

        {/* Connection + setup row */}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={() => setShowSheetModal(true)} className={BTN_PRI}>
            {sheetConnected ? 'Edit Connection' : 'Connect Google Sheet'}
          </button>
          <button type="button" onClick={openScriptGuide} className={BTN_SEC}>📜 Apps Script Setup Guide</button>
          {sheetConnected && (
            <button
              type="button"
              onClick={testAppsScriptConnection}
              disabled={testingConnection}
              className={BTN_SEC}
              title="Apps Script ko ping karke verify karega ki URL + secret + Attendance tab sab sahi hain"
            >
              {testingConnection ? '⏳ Testing…' : '🧪 Test Connection'}
            </button>
          )}
        </div>

        {/* Persistent last-test result so the actionable hint doesn't vanish with the toast. */}
        {lastTestResult && (
          <div
            className={`mt-3 rounded-xl border p-3 text-xs ${
              lastTestResult.ok
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-amber-400 bg-amber-50 text-amber-900'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {lastTestResult.ok ? '✅ ' : '⚠ '}{lastTestResult.title}
                </p>
                {lastTestResult.detail && (
                  <p className="mt-1 opacity-90">{lastTestResult.detail}</p>
                )}
                {lastTestResult.hint && !/Unknown command/i.test(lastTestResult.title) && (
                  <div className="mt-2 rounded-md bg-white/70 p-2 text-[11px] leading-relaxed">
                    <p className="font-semibold">👉 Kya karna hai:</p>
                    <p className="mt-0.5">{lastTestResult.hint}</p>
                  </div>
                )}
                {/Unknown command/i.test(lastTestResult.title) && (
                  <div className="mt-2 rounded-md bg-white/70 p-2 text-[11px] leading-relaxed">
                    <p className="font-semibold">ℹ Yeh error harmless hai — sync chal raha hai</p>
                    <p className="mt-1">
                      "ping" ek health-check command hai jo Apps Script ke purane partial deploy me nahi hai.
                      Lekin <strong>actual sync (`fetch_attendance`) bilkul kaam kar rahi hai</strong> —
                      upar green badge dekho. Auto-pull har 5 min me Sheet se data laata hai.
                    </p>
                    <p className="mt-1 opacity-80">
                      Agar instant sync (5 min latency hatani hai) chahiye to optionally Apps Script ko
                      latest code se redeploy kar sakte ho — par <em>zaroori nahi</em>.
                    </p>
                  </div>
                )}
                <p className="mt-2 text-[10px] opacity-60">Last tested: {lastTestResult.at}</p>
              </div>
              <button
                type="button"
                onClick={() => setLastTestResult(null)}
                className="shrink-0 rounded p-1 text-xs opacity-60 hover:opacity-100"
                title="Hide"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* HRMS → Sheet (push) — always safe direction */}
        {sheetConnected && (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
            <h3 className="text-sm font-semibold text-emerald-900">⬆ HRMS → Sheet (push)</h3>
            <p className="mt-0.5 text-[11px] text-emerald-900/80">
              HRMS ka data Sheet par bhejta hai. HRMS master rehta hai — yeh direction hamesha safe hai.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={manualSync}
                disabled={bulkSyncing}
                className={BTN_SEC}
                title="Quick incremental push using the saved Apps Script URL"
              >
                🔄 Manual Sync
              </button>
              <button
                type="button"
                onClick={runPushToSheet}
                disabled={bulkSyncing}
                className={BTN_PRI}
                title="Full push: Attendance + Users + Leave + Branches + Notices, all chunks"
              >
                {bulkSyncing ? '⏳ Working…' : '🚀 Full Sync (HRMS → Sheet)'}
              </button>
            </div>
          </div>
        )}

        {/* ── Sheet → HRMS direction (locked down by default) ─────────────── */}
        {sheetConnected && (
          <div className="mt-5 rounded-2xl border-2 border-amber-300 bg-amber-50/60 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-amber-900">⬇ Sheet → HRMS direction (advanced)</h3>
                <p className="mt-0.5 text-[11px] text-amber-900/80">
                  One-time backfill ho chuka hai. Default <strong>OFF</strong> hai taaki Sheet ke purane/test rows accidentally HRMS me re-import na ho jaayein.
                  Deleted users ki rows automatically skip ho jaati hain.
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${sheetQ.data?.sheet_to_portal_enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'}`}>
                {sheetQ.data?.sheet_to_portal_enabled ? '🟢 ON' : '⚪ OFF (default)'}
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => toggleSheetToPortal(!sheetQ.data?.sheet_to_portal_enabled)}
                className={sheetQ.data?.sheet_to_portal_enabled ? BTN_DANGER : BTN_SEC}
              >
                {sheetQ.data?.sheet_to_portal_enabled ? 'Turn OFF Sheet→Portal' : 'Allow Sheet → Portal sync'}
              </button>
            </div>

            {/* Backfill section — only shown when sheet_to_portal_enabled is ON */}
            {sheetQ.data?.sheet_to_portal_enabled && (
              <div className="mt-4 space-y-3">
                {/* ── Option A: Date-range backfill (no arming needed, scoped, fast) ── */}
                <div className="rounded-xl border border-amber-300 bg-white p-3">
                  <p className="text-xs font-semibold text-amber-900">📅 Backfill by Date Range (recommended)</p>
                  <p className="mt-1 text-[11px] text-amber-900/80">
                    From-To dates select karke <strong>sirf un dino ka data</strong> Sheet se HRMS me import karega. Scoped hai isliye arming ki zaroorat nahi.
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="flex flex-col text-[11px] font-medium text-amber-900">
                      From
                      <input
                        type="date"
                        value={backfillFrom}
                        onChange={(e) => setBackfillFrom(e.target.value)}
                        max={backfillTo || undefined}
                        className={INPUT + ' w-40 py-1 text-xs'}
                      />
                    </label>
                    <label className="flex flex-col text-[11px] font-medium text-amber-900">
                      To
                      <input
                        type="date"
                        value={backfillTo}
                        onChange={(e) => setBackfillTo(e.target.value)}
                        min={backfillFrom || undefined}
                        className={INPUT + ' w-40 py-1 text-xs'}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        if (!backfillFrom || !backfillTo) {
                          pushToast('error', 'From aur To dono dates select karein.')
                          return
                        }
                        if (!window.confirm(`Sheet → HRMS backfill chalana hai for ${backfillFrom} → ${backfillTo}?\n\nIs range ke rows UPSERT honge. Deleted users ki rows skip ho jaayengi.`)) return
                        void runBackfillNow({ from: backfillFrom, to: backfillTo })
                      }}
                      disabled={bulkSyncing || !backfillFrom || !backfillTo}
                      className={BTN_PRI}
                    >
                      {bulkSyncing ? '⏳ Importing…' : '▶ Run Backfill (Date Range)'}
                    </button>
                  </div>
                </div>

                {/* ── Option B: Full backfill (arm + run, one-shot) ── */}
                <div className="rounded-xl border border-amber-300 bg-white p-3">
                  <p className="text-xs font-semibold text-amber-900">🔐 Full Backfill (advanced — entire sheet)</p>
                  <p className="mt-1 text-[11px] text-amber-900/80">
                    Entire Sheet ka data import karega. Two-step safety: pehle <strong>Arm</strong>, fir <strong>Run</strong>. Run hone ke baad arming auto-clear.
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {sheetQ.data?.backfill_armed ? (
                      <>
                        <span className="rounded-full bg-amber-200 px-3 py-1 text-[11px] font-semibold text-amber-900 animate-pulse">
                          🔓 ARMED {sheetQ.data?.backfill_armed_at && `at ${new Date(sheetQ.data.backfill_armed_at).toLocaleString('en-IN')}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => runBackfillNow()}
                          disabled={bulkSyncing}
                          className={BTN_PRI}
                        >
                          {bulkSyncing ? '⏳ Importing…' : '▶ Run Full Backfill'}
                        </button>
                        <button type="button" onClick={disarmBackfill} className={BTN_DANGER}>Cancel (Disarm)</button>
                      </>
                    ) : (
                      <button type="button" onClick={armBackfill} className={BTN_SEC}>🔒 Arm Full Backfill</button>
                    )}
                  </div>
                </div>

                {sheetQ.data?.last_backfill_at && (
                  <p className="text-[11px] text-amber-900/70">
                    Last backfill run: {new Date(sheetQ.data.last_backfill_at).toLocaleString('en-IN')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <details className="mt-4 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-3 text-xs text-[#14261a]">
          <summary className="cursor-pointer font-semibold text-[#1f5e3b]">📋 Quick Setup Steps (5 min)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[#14261a]/85">
            <li>Open <a href="https://script.google.com" target="_blank" rel="noreferrer" className="font-semibold text-[#1f5e3b] underline">script.google.com</a> → <strong>New Project</strong>.</li>
            <li>Click <strong>📜 View Apps Script Setup Guide</strong> above, hit <strong>Copy</strong>, and paste the entire code into the script editor.</li>
            <li>Press <strong>Save</strong> (Ctrl+S), name the project (e.g. "Prakriti HRMS Sync").</li>
            <li>Click <strong>Deploy → New deployment</strong> → choose type <strong>Web app</strong>.</li>
            <li>Set <em>Execute as</em>: <strong>Me</strong>, <em>Who has access</em>: <strong>Anyone</strong> → Deploy.</li>
            <li>Copy the generated <strong>Web app URL</strong>.</li>
            <li>Click <strong>Connect Google Sheet</strong> above and paste the URL into <em>Apps Script Webhook URL</em>. Save.</li>
            <li className="rounded-md bg-amber-50 p-2 text-amber-900">
              <strong>★ One-time authorize:</strong> Open the Sheet → menu <strong>HRMS Sync → 🔑 Authorize Sync (run once)</strong>. Google will ask for permission to <em>"Connect to an external service"</em> — click <strong>Allow</strong>. Without this, Sheet → Portal edits fail with <code>You do not have permission to call UrlFetchApp.fetch</code>.
            </li>
            <li>Hit <strong>🔄 Manual Sync Now</strong> to push existing data and confirm everything is wired up.</li>
          </ol>
        </details>
      </div>

      {showScriptGuide && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-2 sm:p-4" onClick={(e) => e.target === e.currentTarget && setShowScriptGuide(false)}>
          <div className="my-4 w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-t-2xl border-b border-[#1f5e3b]/10 bg-white px-5 py-4">
              <div className="min-w-0">
                <h3 className="font-semibold text-[#1f5e3b]">📜 Google Apps Script</h3>
                <p className="text-[11px] font-semibold text-[#1f5e3b]">
                  Copy this code and paste in Google Apps Script → Deploy as Web App
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={copyScript} disabled={!activeScript} className={BTN_PRI}>
                  {scriptCopied ? '✅ Copied' : '📋 Copy Code'}
                </button>
                <button type="button" onClick={() => setShowScriptGuide(false)} className="rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#14261a]">Close ✕</button>
              </div>
            </div>

            <div className="space-y-4 p-5">
              {/* Variant selector */}
              <div className="flex flex-wrap gap-1 rounded-xl border border-[#1f5e3b]/15 bg-[#f7fbf8] p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setScriptVariant('full')}
                  className={`flex-1 rounded-lg px-3 py-2 text-center font-semibold transition ${scriptVariant === 'full' ? 'bg-[#1f5e3b] text-white shadow-sm' : 'text-[#1f5e3b] hover:bg-[#1f5e3b]/5'}`}
                >
                  🧰 Advanced — Multi-tab + Full Sync (recommended)
                </button>
                <button
                  type="button"
                  onClick={() => setScriptVariant('simple')}
                  className={`flex-1 rounded-lg px-3 py-2 text-center font-semibold transition ${scriptVariant === 'simple' ? 'bg-[#1f5e3b] text-white shadow-sm' : 'text-[#1f5e3b] hover:bg-[#1f5e3b]/5'}`}
                >
                  ⚡ Simple — Attendance only
                </button>
              </div>

              <div className="rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-4 text-xs text-[#14261a]/85">
                <p className="mb-2 font-semibold text-[#1f5e3b]">Setup steps</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>Open the Google Sheet you want to sync to (or create a new one). For the Simple script, ensure the first tab is named <strong>Attendance</strong> with header row containing <code>unique_key</code>.</li>
                  <li>Extensions → <strong>Apps Script</strong> → delete any existing code.</li>
                  <li>Click <strong>📋 Copy Code</strong> above and paste it into the editor.</li>
                  <li>Press <strong>Ctrl+S</strong>, name the project, then <strong>Deploy → New deployment → Web app</strong>.</li>
                  <li><em>Execute as</em>: <strong>Me</strong> · <em>Access</em>: <strong>Anyone</strong> → Deploy → Copy the <code>/exec</code> URL.</li>
                  <li>Paste the URL into HRMS Settings → <strong>Connect Google Sheet</strong> dialog.</li>
                  {scriptVariant === 'full' && (
                    <li className="rounded-md bg-amber-50 p-2 text-amber-900">
                      <strong>★ Important (Advanced only):</strong> In Apps Script editor click <strong>⚙ Project Settings</strong> → scroll to <strong>Script properties</strong> → <strong>Add script property</strong> twice:
                      <div className="mt-1 ml-2 font-mono text-[11px]">
                        <div>HRMS_API_URL = <span className="text-blue-700">https://YOUR-BACKEND.onrender.com/api/attendance/sheet-sync</span></div>
                        <div>HRMS_SHEET_SYNC_SECRET = <span className="text-blue-700">(value of SHEET_SYNC_SECRET secret)</span></div>
                      </div>
                      Without these, "Run Full Sync" and reverse-sync (Sheet → HRMS) will fail.
                    </li>
                  )}
                  <li className="rounded-md bg-amber-50 p-2 text-amber-900">
                    <strong>★ Authorize once:</strong> Reload the Sheet, then open menu <strong>HRMS Sync → 🔑 Authorize Sync (run once)</strong>. Google will prompt for two permissions — click <strong>Allow</strong> on both, especially <em>"Connect to an external service"</em>. Without this, the <code>Sync_Log</code> tab will fill with <em>"You do not have permission to call UrlFetchApp.fetch"</em> errors and Sheet → Portal autosync silently breaks.
                  </li>
                  <li>If you re-deploy the Apps Script later (new code), Google may give you a <strong>new /exec URL</strong> — paste the new one back into HRMS or "Run Full Sync" will fail with a 404.</li>
                </ol>
                {scriptVariant === 'simple' ? (
                  <p className="mt-2 rounded-md bg-white/70 p-2 text-[11px] text-[#14261a]/80">
                    <strong>Simple script:</strong> 12-column Attendance upsert by <code>unique_key</code> — exactly the columns
                    {' '}<code>unique_key, employee_name, employee_id, branch, role, date, attendance_mode, punch_in, punch_out, total_hours, status, notes</code>.
                    Other syncs (Users, Leave, Logs) will be ignored by this script.
                    {' '}<em>For bulk backfill of old rows or reverse-sync from Sheet edits, switch to <strong>Advanced</strong> — it adds an <code>HRMS Sync → Run Full Sync</code> menu inside the spreadsheet.</em>
                  </p>
                ) : (
                  <p className="mt-2 rounded-md bg-white/70 p-2 text-[11px] text-[#14261a]/80">
                    <strong>Advanced script:</strong> handles every HRMS tab — Attendance, Users, Leave Requests, Branches, Logs, Notices — with auto-header management.
                    Includes <code>onSheetEdit</code> reverse-sync trigger and a <code>bulkSyncAllData()</code> backfill function exposed via the <strong>HRMS Sync</strong> menu in your spreadsheet.
                    Configure <code>HRMS_API_URL</code> + <code>HRMS_SHEET_SYNC_SECRET</code> via <strong>⚙ Project Settings → Script properties</strong> (recommended — safer than editing code, survives re-paste).
                  </p>
                )}
              </div>

              {scriptVariant === 'full' && scriptLoading && <PageSkeleton rows={6} />}
              {(scriptVariant === 'simple' || !scriptLoading) && (
                <pre className="max-h-[55vh] overflow-auto rounded-xl border border-[#1f5e3b]/15 bg-[#0f1c14] p-4 text-[11px] leading-relaxed text-[#d6f5e1]">
                  <code>{activeScript || '// Loading…'}</code>
                </pre>
              )}

              <details className="rounded-xl border border-[#1f5e3b]/10 bg-white p-3 text-xs text-[#14261a]/85">
                <summary className="cursor-pointer font-semibold text-[#1f5e3b]">🧪 Minimal test snippet (for a quick sanity check)</summary>
                <pre className="mt-2 overflow-auto rounded-lg bg-[#0f1c14] p-3 text-[11px] text-[#d6f5e1]"><code>{`function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  sheet.appendRow([
    new Date(),
    data.name      || "UNKNOWN",
    data.mobile    || "",
    data.city      || "",
    data.status    || "",
    data.punchIn   || "",
    data.punchOut  || "",
    data.late      || "",
    data.totalHours|| ""
  ]);

  return ContentService
    .createTextOutput(JSON.stringify({status: "success"}))
    .setMimeType(ContentService.MimeType.JSON);
}`}</code></pre>
                <p className="mt-2 text-[11px] text-[#14261a]/65">
                  Use the snippet above only to confirm Apps Script can receive a POST. The full <code>hrms_sync.gs</code> script (above) is what the HRMS actually expects in production — it handles every tab (Attendance, Users, Leave, Branches, Audit, Notices) with proper upsert logic.
                </p>
              </details>
            </div>
          </div>
        </div>
      )}

      {showSheetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(e) => e.target === e.currentTarget && setShowSheetModal(false)}>
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold text-[#1f5e3b]">Connect Google Sheet</h3>
              <button type="button" onClick={() => setShowSheetModal(false)} className="text-[#1f5e3b]/50 hover:text-[#1f5e3b]">✕</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-[#14261a]">Apps Script Webhook URL *</label>
                <input value={sheetWebhook} onChange={(e) => setSheetWebhook(e.target.value)} placeholder="https://script.google.com/macros/s/..." className={INPUT} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#14261a]">Google Sheet URL (optional)</label>
                <input value={sheetLink} onChange={(e) => setSheetLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." className={INPUT} />
              </div>
              <div className="flex justify-end gap-2 pt-3">
                <button type="button" onClick={() => setShowSheetModal(false)} className={BTN_SEC}>Cancel</button>
                <button type="button" onClick={saveSheet} disabled={sheetSaving} className={BTN_PRI}>{sheetSaving ? 'Saving…' : 'Save & Connect'}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// ROLES SECTION
// ────────────────────────────────────────────────────────────────────────────
function RolesSection({ onBack, pushToast }: { onBack: () => void; pushToast: (k: ToastKind, t: string) => void }) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const isSuper = user?.role === 'SUPER_ADMIN'

  const visQ = useQuery({
    queryKey: ['module-visibility'],
    queryFn: () => api<RoleVisibility>('/settings/module-visibility'),
    enabled: isSuper,
  })
  const customRolesQ = useQuery({
    queryKey: ['custom-roles'],
    queryFn: () => api<{ roles: CustomRole[] }>('/roles/custom'),
    enabled: isSuper,
  })
  const branchAccess = useBranchAccess()

  const [vis, setVis] = useState<RoleVisibility>({})
  const [origVis, setOrigVis] = useState<RoleVisibility>({})
  const [savingVis, setSavingVis] = useState(false)
  const [activeRoleTab, setActiveRoleTab] = useState<string>('USER')

  const [newRoleName, setNewRoleName] = useState('')
  const [newRolePerms, setNewRolePerms] = useState('')

  useEffect(() => {
    if (visQ.data) {
      setVis(visQ.data)
      setOrigVis(visQ.data)
    }
  }, [visQ.data])

  const visDirty = JSON.stringify(vis) !== JSON.stringify(origVis)

  async function saveVis() {
    setSavingVis(true)
    try {
      await api('/settings/module-visibility', { method: 'POST', body: JSON.stringify(vis) })
      setOrigVis(vis)
      pushToast('success', 'Role visibility updated.')
    } catch (ex) {
      pushToast('error', `Failed: ${(ex as Error).message}`)
    } finally {
      setSavingVis(false)
    }
  }

  async function createRole() {
    if (!newRoleName.trim()) {
      pushToast('error', 'Role name is required.')
      return
    }
    try {
      const permissions = newRolePerms.split(',').map((x) => x.trim()).filter(Boolean)
      await api('/roles/custom', { method: 'POST', body: JSON.stringify({ name: newRoleName.trim(), permissions }) })
      setNewRoleName(''); setNewRolePerms('')
      pushToast('success', `Custom role "${newRoleName.trim()}" created.`)
      await customRolesQ.refetch()
    } catch (ex) {
      pushToast('error', (ex as Error).message)
    }
  }

  async function toggleRoleActive(r: CustomRole) {
    try {
      await api(`/roles/custom/${r.id}`, { method: 'PATCH', body: JSON.stringify({ active: r.active ? 0 : 1 }) })
      pushToast('success', `Role "${r.name}" ${r.active ? 'disabled' : 'enabled'}.`)
      await customRolesQ.refetch()
    } catch (ex) { pushToast('error', (ex as Error).message) }
  }

  async function deleteRole(r: CustomRole) {
    if (!confirm(`Delete role "${r.name}"? This cannot be undone.`)) return
    try {
      await api(`/roles/custom/${r.id}`, { method: 'DELETE' })
      pushToast('success', `Role "${r.name}" deleted.`)
      await customRolesQ.refetch()
    } catch (ex) { pushToast('error', (ex as Error).message) }
  }

  async function saveBranchAccess(role: string, branchId: number, accessible: boolean) {
    try {
      const newRules = { ...branchAccess.rules, [role]: { ...(branchAccess.rules[role] || {}), [branchId]: accessible } }
      await branchAccess.saveBranchAccess(newRules)
      qc.invalidateQueries({ queryKey: ['branch-access'] })
      pushToast('success', 'Branch access updated.')
    } catch (ex) { pushToast('error', (ex as Error).message) }
  }

  if (!isSuper) {
    return (
      <div className="space-y-6 pb-4">
        <SectionHeader icon="👥" title="Role & Permission Settings" subtitle="Only Super Admin can manage roles." onBack={onBack} />
        <div className="ph-card rounded-2xl p-8 text-center text-sm text-[#1f5e3b]/70">
          Please contact your Super Admin to manage roles and permissions.
        </div>
      </div>
    )
  }

  if (visQ.isLoading) return <PageSkeleton rows={5} />

  return (
    <div className="space-y-6 pb-4">
      <SectionHeader icon="👥" title="Role & Permission Settings" subtitle="Control what each role can see and access." onBack={onBack} />

      {/* Module Visibility per Role */}
      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-base font-semibold text-[#1f5e3b]">🔐 Module Visibility per Role</h2>
        <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Choose which dashboard widgets and menu items each role can see.</p>

        <div className="mt-4 flex flex-wrap gap-2 border-b border-[#1f5e3b]/10 pb-3">
          {CONFIGURABLE_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setActiveRoleTab(r)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                activeRoleTab === r ? 'bg-[#1f5e3b] text-white' : 'border border-[#1f5e3b]/20 text-[#1f5e3b] hover:bg-[#1f5e3b]/5'
              }`}
            >
              {r.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-4">
          {Object.entries(MODULE_GROUPS).map(([group, keys]) => (
            <div key={group}>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-[#1f5e3b]/70">{group}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {keys.map((k) => (
                  <Toggle
                    key={k}
                    checked={!!vis[activeRoleTab]?.[k]}
                    onChange={(v) => setVis({ ...vis, [activeRoleTab]: { ...(vis[activeRoleTab] || {}), [k]: v } })}
                    label={MODULE_LABELS[k] || k}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <StickyBar dirty={visDirty} saving={savingVis} onSave={saveVis} onReset={() => setVis(origVis)} />
      </div>

      {/* Branch Access */}
      {branchAccess.branches.length > 0 && (
        <div className="ph-card rounded-2xl p-6">
          <h2 className="text-base font-semibold text-[#1f5e3b]">🏬 Branch Access (per role)</h2>
          <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Hide specific branches from non-super-admin roles. Changes save instantly.</p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[#1f5e3b]/10 text-left">
                  <th className="py-2 pr-3 font-semibold text-[#1f5e3b]">Branch</th>
                  {CONFIGURABLE_ROLES.map((r) => (
                    <th key={r} className="px-2 py-2 text-center font-semibold text-[#1f5e3b]">{r.replace(/_/g, ' ')}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {branchAccess.branches.map((b) => (
                  <tr key={b.id} className="border-b border-[#1f5e3b]/5">
                    <td className="py-2 pr-3 font-medium text-[#14261a]">{b.name}</td>
                    {CONFIGURABLE_ROLES.map((r) => {
                      const rule = branchAccess.rules[r]?.[b.id]
                      const accessible = rule == null ? true : !!rule
                      return (
                        <td key={r} className="px-2 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => saveBranchAccess(r, b.id, !accessible)}
                            className={`rounded-md px-2 py-1 text-[10px] font-semibold transition ${
                              accessible ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-red-100 text-red-700 hover:bg-red-200'
                            }`}
                          >
                            {accessible ? '✓ Allowed' : '✕ Hidden'}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Custom Roles */}
      <div className="ph-card rounded-2xl p-6">
        <h2 className="text-base font-semibold text-[#1f5e3b]">🎭 Custom Roles</h2>
        <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Create custom permission groups for specialized access.</p>

        <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
          <input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="Role name (e.g. Regional Manager)" className={INPUT} />
          <input value={newRolePerms} onChange={(e) => setNewRolePerms(e.target.value)} placeholder="Permissions (comma separated, e.g. leave:read_all, users:read)" className={INPUT} />
          <button type="button" onClick={createRole} className={BTN_PRI}>+ Create</button>
        </div>

        {(customRolesQ.data?.roles || []).length > 0 && (
          <div className="mt-4 space-y-2">
            {(customRolesQ.data?.roles || []).map((r) => (
              <div key={r.id} className="rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-semibold text-[#14261a]">
                      <span>{r.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.active ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-200 text-gray-600'}`}>
                        {r.active ? 'Active' : 'Disabled'}
                      </span>
                      <span className="text-[10px] text-[#1f5e3b]/55">ID: {r.id}</span>
                    </p>
                    <p className="mt-0.5 truncate text-xs text-[#1f5e3b]/65">
                      {(r.permissions || []).join(', ') || 'No permissions set'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => toggleRoleActive(r)} className={BTN_SEC}>{r.active ? 'Disable' : 'Enable'}</button>
                    <button type="button" onClick={() => deleteRole(r)} className={BTN_DANGER}>Delete</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ────────────────────────────────────────────────────────────────────────────
export function SettingsPage() {
  const { user } = useAuth()
  const can = canPerm(user, 'settings:read')
  const [section, setSection] = useState<SectionKey>('home')
  const [toasts, setToasts] = useState<Toast[]>([])

  function pushToast(kind: ToastKind, text: string) {
    const id = Date.now() + Math.random()
    setToasts((p) => [...p, { id, kind, text }])
    window.setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4500)
  }
  function dismissToast(id: number) { setToasts((p) => p.filter((t) => t.id !== id)) }

  // Reset to hub on mount
  useEffect(() => { setSection('home') }, [])

  if (!can) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center text-sm text-[#1f5e3b]">
        Settings are visible to HR / Admin roles.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[860px] px-4 pb-8 sm:px-6">
      {section === 'home' && <SettingsHub onPick={setSection} />}
      {section === 'general'       && <GeneralSection       onBack={() => setSection('home')} pushToast={pushToast} />}
      {section === 'attendance'    && <AttendanceSection    onBack={() => setSection('home')} pushToast={pushToast} />}
      {section === 'notifications' && <NotificationsSection onBack={() => setSection('home')} pushToast={pushToast} />}
      {section === 'roles'         && <RolesSection         onBack={() => setSection('home')} pushToast={pushToast} />}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
