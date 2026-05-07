import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { CONFIGURABLE_ROLES, MODULE_LABELS, MODULE_GROUPS, useBranchAccess } from '../lib/useModuleVisibility'

type AppSettings = {
  app_name?: string
  session_ttl_days?: number
  features?: {
    kiosk?: boolean
    geo_fence?: boolean
    face_recognition?: boolean
    wifi_restriction?: boolean
    manual_entry?: boolean
    pin_login?: boolean
    qr_code?: boolean
    fingerprint?: boolean
  }
  attendance_wifi?: { enabled?: boolean; allowed_ssids?: string[] }
  daily_report?: { enabled?: boolean; recipients?: string[] }
}

type Company = {
  name?: string
  address?: string
  phone?: string
  email?: string
  timezone?: string
  working_hours_start?: string
  working_hours_end?: string
}

type Tab = 'general' | 'attendance' | 'notifications' | 'system' | 'visibility' | 'guide'

const TABS: { key: Tab; label: string; icon: string; superOnly?: boolean }[] = [
  { key: 'general', label: 'General', icon: '🏢' },
  { key: 'attendance', label: 'Attendance', icon: '👆' },
  { key: 'notifications', label: 'Notifications', icon: '🔔' },
  { key: 'system', label: 'System', icon: '⚙️' },
  { key: 'visibility', label: 'Role Visibility', icon: '👁️', superOnly: true },
  { key: 'guide', label: 'सिस्टम गाइड', icon: '📖' },
]

type VisibilityMap = Record<string, Record<string, boolean>>

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${checked ? 'bg-[#1f5e3b]' : 'bg-gray-200'} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  )
}

export function GuidePage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const canRead = canPerm(user, 'settings:read')
  const canWrite = canPerm(user, 'settings:write')
  const isSuperAdmin = user?.role === 'SUPER_ADMIN'

  const [tab, setTab] = useState<Tab>('general')
  const [settings, setSettings] = useState<AppSettings>({})
  const [company, setCompany] = useState<Company>({})
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Notification: daily report
  const [reportRecipients, setReportRecipients] = useState('')

  // Visibility settings (Super Admin only)
  const { data: visibilityData } = useQuery<VisibilityMap>({
    queryKey: ['module-visibility'],
    queryFn: () => api<VisibilityMap>('/settings/module-visibility'),
    enabled: isSuperAdmin && canRead,
    staleTime: 60000,
  })
  const [visibilityDraft, setVisibilityDraft] = useState<VisibilityMap>({})
  const [visSaving, setVisSaving] = useState(false)

  useEffect(() => {
    if (visibilityData) setVisibilityDraft(JSON.parse(JSON.stringify(visibilityData)))
  }, [visibilityData])

  async function saveVisibility() {
    setVisSaving(true)
    try {
      await api('/settings/module-visibility', { method: 'POST', body: JSON.stringify(visibilityDraft) })
      await qc.invalidateQueries({ queryKey: ['module-visibility'] })
      flash('Role visibility updated.')
    } catch (e) { setErr((e as Error).message) } finally { setVisSaving(false) }
  }

  function toggleVisibility(role: string, module: string, val: boolean) {
    setVisibilityDraft((prev) => ({
      ...prev,
      [role]: { ...(prev[role] ?? {}), [module]: val },
    }))
  }

  // Branch access control
  const { branches, rules: branchRules, saveBranchAccess } = useBranchAccess()
  const [branchDraft, setBranchDraft] = useState<Record<string, Record<number, boolean>>>({})
  const [branchSaving, setBranchSaving] = useState(false)
  const BRANCH_ROLES = ['ADMIN', 'ATTENDANCE_MANAGER', 'LOCATION_MANAGER'] as const

  useEffect(() => {
    if (Object.keys(branchRules).length > 0) {
      setBranchDraft(JSON.parse(JSON.stringify(branchRules)))
    }
  }, [branchRules])

  function isBranchAccessible(role: string, branchId: number): boolean {
    if (role in branchDraft && branchId in branchDraft[role]) {
      return !!branchDraft[role][branchId]
    }
    return true
  }

  function toggleBranchAccess(role: string, branchId: number, val: boolean) {
    setBranchDraft((prev) => ({
      ...prev,
      [role]: { ...(prev[role] ?? {}), [branchId]: val },
    }))
  }

  async function saveBranches() {
    setBranchSaving(true)
    try {
      await saveBranchAccess(branchDraft)
      flash('Branch access rules saved.')
    } catch (e) { setErr((e as Error).message) } finally { setBranchSaving(false) }
  }

  useEffect(() => {
    if (!canRead) return
    Promise.all([
      api<AppSettings>('/settings'),
      api<{ profile: Company }>('/company/profile').catch(() => ({ profile: {} as Company })),
    ]).then(([s, cp]) => {
      setSettings(s)
      setCompany(cp.profile || {})
      setReportRecipients((s.daily_report?.recipients || []).join(', '))
    }).catch((e) => setErr((e as Error).message))
  }, [canRead])

  function flash(msg: string) { setOk(msg); setTimeout(() => setOk(null), 3000) }

  async function saveSettings(patch: Partial<AppSettings>) {
    if (!canWrite) return
    setSaving(true); setErr(null)
    try {
      const updated = await api<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) })
      setSettings(updated)
      flash('Settings saved successfully.')
    } catch (e) { setErr((e as Error).message) } finally { setSaving(false) }
  }

  async function toggleFeature(key: keyof NonNullable<AppSettings['features']>, val: boolean) {
    await saveSettings({ features: { ...settings.features, [key]: val } })
  }

  async function saveCompany() {
    if (!canWrite) return
    setSaving(true); setErr(null)
    try {
      await api('/company/profile', { method: 'PATCH', body: JSON.stringify(company) })
      flash('Company profile updated.')
    } catch (e) { setErr((e as Error).message) } finally { setSaving(false) }
  }

  async function saveReport() {
    if (!canWrite || !isSuperAdmin) return
    setSaving(true); setErr(null)
    try {
      const recipients = reportRecipients.split(',').map(s => s.trim()).filter(Boolean)
      await api('/settings/daily-report', { method: 'PATCH', body: JSON.stringify({ enabled: settings.daily_report?.enabled, recipients }) })
      flash('Report settings saved.')
    } catch (e) { setErr((e as Error).message) } finally { setSaving(false) }
  }

  if (!canRead) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center">
        <p className="text-4xl mb-3">🔒</p>
        <p className="text-[#1f5e3b] font-semibold">Settings restricted to Admin and Super Admin.</p>
      </div>
    )
  }

  const features = settings.features || {}

  return (
    <div className="mx-auto max-w-[1000px] pb-10">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-[#1f5e3b]">⚙️ Settings</h1>
        <p className="text-sm text-[#1f5e3b]/60">Manage system configuration for Prakriti Herbs HRMS</p>
      </div>

      {err && <div className="mb-4 rounded-xl bg-red-50 px-4 py-2 text-sm text-red-700">{err}</div>}
      {ok && <div className="mb-4 rounded-xl bg-green-50 px-4 py-2 text-sm text-green-700">✅ {ok}</div>}

      <div className="flex gap-5">
        {/* Sidebar tabs */}
        <div className="w-44 shrink-0 space-y-1">
          {TABS.filter((t) => !t.superOnly || isSuperAdmin).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${tab === t.key ? 'bg-[#1f5e3b] text-white' : 'text-[#1f5e3b] hover:bg-[#1f5e3b]/8'}`}
            >
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 space-y-5">

          {/* GENERAL */}
          {tab === 'general' && (
            <div className="ph-card rounded-2xl p-6 space-y-5">
              <h2 className="text-base font-bold text-[#1f5e3b]">🏢 General Settings</h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Company Name</label>
                  <input
                    value={company.name || ''}
                    onChange={(e) => setCompany((p) => ({ ...p, name: e.target.value }))}
                    disabled={!canWrite}
                    className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
                    placeholder="Prakriti Herbs Private Limited"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Phone</label>
                    <input value={company.phone || ''} onChange={(e) => setCompany((p) => ({ ...p, phone: e.target.value }))}
                      disabled={!canWrite} className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Email</label>
                    <input value={company.email || ''} onChange={(e) => setCompany((p) => ({ ...p, email: e.target.value }))}
                      disabled={!canWrite} className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm" />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Address</label>
                  <textarea value={company.address || ''} onChange={(e) => setCompany((p) => ({ ...p, address: e.target.value }))}
                    disabled={!canWrite} rows={2}
                    className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm resize-none" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Working Hours Start</label>
                    <input type="time" value={company.working_hours_start || '09:00'}
                      onChange={(e) => setCompany((p) => ({ ...p, working_hours_start: e.target.value }))}
                      disabled={!canWrite} className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Working Hours End</label>
                    <input type="time" value={company.working_hours_end || '18:00'}
                      onChange={(e) => setCompany((p) => ({ ...p, working_hours_end: e.target.value }))}
                      disabled={!canWrite} className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm" />
                  </div>
                </div>
              </div>

              <hr className="border-[#1f5e3b]/10" />

              <div className="space-y-3">
                <h3 className="text-sm font-bold text-[#1f5e3b]">App Settings</h3>
                <div>
                  <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">App Name</label>
                  <input
                    value={settings.app_name || ''}
                    onChange={(e) => setSettings((p) => ({ ...p, app_name: e.target.value }))}
                    disabled={!canWrite}
                    className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Session TTL (days)</label>
                  <input
                    type="number" min={1} max={365}
                    value={settings.session_ttl_days ?? 7}
                    onChange={(e) => setSettings((p) => ({ ...p, session_ttl_days: Number(e.target.value) || 7 }))}
                    disabled={!canWrite}
                    className="w-28 rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              {canWrite && (
                <div className="flex gap-3">
                  <button onClick={() => void saveCompany()} disabled={saving}
                    className="rounded-xl bg-[#1f5e3b] px-5 py-2 text-sm font-semibold text-white hover:bg-[#174d30] disabled:opacity-50">
                    {saving ? 'Saving…' : 'Save Company Profile'}
                  </button>
                  <button onClick={() => void saveSettings({ app_name: settings.app_name, session_ttl_days: settings.session_ttl_days })}
                    disabled={saving}
                    className="rounded-xl border border-[#1f5e3b]/30 px-5 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5 disabled:opacity-50">
                    Save App Settings
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ATTENDANCE */}
          {tab === 'attendance' && (
            <div className="ph-card rounded-2xl p-6 space-y-5">
              <h2 className="text-base font-bold text-[#1f5e3b]">👆 Attendance Settings</h2>
              <p className="text-xs text-[#1f5e3b]/60">Control which attendance methods are active system-wide.</p>

              <div className="space-y-3">
                {[
                  { key: 'face_recognition' as const, label: 'Face Recognition', icon: '📷', desc: 'Allow face-scan based attendance' },
                  { key: 'fingerprint' as const, label: 'Fingerprint', icon: '👆', desc: 'Allow fingerprint scanner attendance' },
                  { key: 'geo_fence' as const, label: 'GPS / Geo-fence', icon: '📍', desc: 'Enable GPS-based check-in/out with location boundary' },
                  { key: 'manual_entry' as const, label: 'Manual Entry', icon: '✍️', desc: 'Allow managers to manually enter attendance' },
                  { key: 'pin_login' as const, label: 'PIN Login', icon: '🔢', desc: 'Allow Employee ID + PIN attendance in Kiosk' },
                  { key: 'qr_code' as const, label: 'QR Code', icon: '📱', desc: 'QR code scan based attendance' },
                  { key: 'kiosk' as const, label: 'Kiosk Mode', icon: '🖥️', desc: 'Enable shared kiosk terminal for attendance' },
                  { key: 'wifi_restriction' as const, label: 'WiFi Restriction', icon: '📶', desc: 'Restrict attendance to whitelisted WiFi networks only' },
                ].map(({ key, label, icon, desc }) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-xl border border-[#1f5e3b]/10 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-[#1f5e3b]">{icon} {label}</p>
                      <p className="text-xs text-[#1f5e3b]/50">{desc}</p>
                    </div>
                    <Toggle
                      checked={!!features[key]}
                      onChange={(v) => void toggleFeature(key, v)}
                      disabled={!canWrite || saving}
                    />
                  </div>
                ))}
              </div>

              {/* ── Priority Mode Status Panel ── */}
              {(() => {
                const geoOn = !!features.geo_fence
                const wifiOn = !!features.wifi_restriction
                const mode = geoOn ? 'gps' : wifiOn ? 'wifi' : 'open'
                return (
                  <div className="rounded-2xl border-2 border-[#1f5e3b]/20 bg-[#f7fbf8] p-4 space-y-3">
                    <p className="text-xs font-bold uppercase tracking-widest text-[#1f5e3b]/50">
                      📊 Active Attendance Mode (Priority Order)
                    </p>
                    <div className="space-y-2">
                      {[
                        {
                          num: '1',
                          label: 'GPS Mode',
                          icon: '📍',
                          active: mode === 'gps',
                          desc: 'Staff must be within GPS radius to punch. सबसे secure।',
                          color: 'emerald',
                        },
                        {
                          num: '2',
                          label: 'WiFi Mode',
                          icon: '📶',
                          active: mode === 'wifi',
                          desc: 'GPS OFF है — Staff को office WiFi से connect होना जरूरी है।',
                          color: 'blue',
                        },
                        {
                          num: '3',
                          label: 'Admin / Manual',
                          icon: '✍️',
                          active: mode === 'open',
                          desc: 'GPS और WiFi दोनों OFF — केवल Admin manual attendance लगा सकते हैं।',
                          color: 'amber',
                        },
                      ].map((m) => (
                        <div key={m.num} className={`flex items-start gap-3 rounded-xl px-4 py-3 border ${
                          m.active
                            ? m.color === 'emerald' ? 'border-emerald-300 bg-emerald-50'
                              : m.color === 'blue' ? 'border-blue-300 bg-blue-50'
                              : 'border-amber-300 bg-amber-50'
                            : 'border-[#1f5e3b]/10 bg-white opacity-50'
                        }`}>
                          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                            m.active
                              ? m.color === 'emerald' ? 'bg-emerald-500'
                                : m.color === 'blue' ? 'bg-blue-500'
                                : 'bg-amber-500'
                              : 'bg-gray-300'
                          }`}>{m.num}</span>
                          <div className="min-w-0">
                            <p className={`text-sm font-bold ${m.active ? 'text-[#1f5e3b]' : 'text-[#1f5e3b]/40'}`}>
                              {m.icon} {m.label}
                              {m.active && <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-emerald-700 border border-emerald-200">● ACTIVE</span>}
                            </p>
                            <p className={`text-xs mt-0.5 ${m.active ? 'text-[#1f5e3b]/60' : 'text-[#1f5e3b]/30'}`}>{m.desc}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-[#1f5e3b]/40">
                      💡 GPS toggle करें ऊपर से। WiFi networks Settings → System में configure करें।
                    </p>
                  </div>
                )
              })()}

              {!canWrite && (
                <p className="text-xs text-[#1f5e3b]/50">Contact Super Admin to change attendance settings.</p>
              )}
            </div>
          )}

          {/* NOTIFICATIONS */}
          {tab === 'notifications' && (
            <div className="ph-card rounded-2xl p-6 space-y-5">
              <h2 className="text-base font-bold text-[#1f5e3b]">🔔 Notification Settings</h2>

              <div className="space-y-4">
                <div className="rounded-xl border border-[#1f5e3b]/10 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-[#1f5e3b]">📧 Daily Report Email</p>
                      <p className="text-xs text-[#1f5e3b]/50">Send daily attendance summary to recipients</p>
                    </div>
                    <Toggle
                      checked={!!settings.daily_report?.enabled}
                      onChange={(v) => setSettings((p) => ({ ...p, daily_report: { ...p.daily_report, enabled: v } }))}
                      disabled={!isSuperAdmin || saving}
                    />
                  </div>
                  {isSuperAdmin && (
                    <>
                      <div>
                        <label className="block text-xs font-semibold text-[#1f5e3b]/70 mb-1">Recipients (comma-separated emails)</label>
                        <textarea
                          value={reportRecipients}
                          onChange={(e) => setReportRecipients(e.target.value)}
                          rows={2}
                          className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm resize-none"
                          placeholder="email@example.com, another@example.com"
                        />
                      </div>
                      <button onClick={() => void saveReport()} disabled={saving}
                        className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white hover:bg-[#174d30] disabled:opacity-50">
                        Save Report Settings
                      </button>
                    </>
                  )}
                  {!isSuperAdmin && (
                    <p className="text-xs text-[#1f5e3b]/50">Only Super Admin can edit report recipients.</p>
                  )}
                </div>

                <div className="rounded-xl border border-[#1f5e3b]/10 p-4 opacity-60">
                  <p className="text-sm font-medium text-[#1f5e3b]">📱 WhatsApp Alerts</p>
                  <p className="text-xs text-[#1f5e3b]/50 mt-1">Coming soon — integration pending.</p>
                </div>

                <div className="rounded-xl border border-[#1f5e3b]/10 p-4 opacity-60">
                  <p className="text-sm font-medium text-[#1f5e3b]">🔊 Sound Alerts</p>
                  <p className="text-xs text-[#1f5e3b]/50 mt-1">Browser notification sounds — configurable per role.</p>
                </div>
              </div>
            </div>
          )}

          {/* SYSTEM */}
          {tab === 'system' && (
            <div className="space-y-5">
              <div className="ph-card rounded-2xl p-6 space-y-4">
                <h2 className="text-base font-bold text-[#1f5e3b]">⚙️ System Settings</h2>

                <div className="grid grid-cols-2 gap-3">
                  <a
                    href="/portal/#/trash"
                    className="rounded-xl border border-[#1f5e3b]/15 p-4 hover:bg-[#1f5e3b]/5 transition-colors"
                  >
                    <p className="text-sm font-semibold text-[#1f5e3b]">🗑️ Trash & Audit</p>
                    <p className="text-xs text-[#1f5e3b]/60 mt-1">View deleted staff, restore or permanently remove, audit logs</p>
                  </a>
                  <a
                    href="/portal/#/monitor"
                    className="rounded-xl border border-[#1f5e3b]/15 p-4 hover:bg-[#1f5e3b]/5 transition-colors"
                  >
                    <p className="text-sm font-semibold text-[#1f5e3b]">📊 Live Monitor</p>
                    <p className="text-xs text-[#1f5e3b]/60 mt-1">Real-time activity feed and alert panel (Super Admin)</p>
                  </a>
                  <a
                    href="/portal/#/company"
                    className="rounded-xl border border-[#1f5e3b]/15 p-4 hover:bg-[#1f5e3b]/5 transition-colors"
                  >
                    <p className="text-sm font-semibold text-[#1f5e3b]">🔗 Integrations</p>
                    <p className="text-xs text-[#1f5e3b]/60 mt-1">Google Sheets sync, WiFi config, sheet integration</p>
                  </a>
                  <a
                    href="/portal/#/reports"
                    className="rounded-xl border border-[#1f5e3b]/15 p-4 hover:bg-[#1f5e3b]/5 transition-colors"
                  >
                    <p className="text-sm font-semibold text-[#1f5e3b]">📄 Reports & Export</p>
                    <p className="text-xs text-[#1f5e3b]/60 mt-1">Download attendance, payroll, leave reports as Excel/PDF</p>
                  </a>
                </div>
              </div>

              {isSuperAdmin && (
                <div className="ph-card rounded-2xl p-6 space-y-4">
                  <h2 className="text-base font-bold text-[#1f5e3b]">🔐 Security Settings</h2>
                  <div className="space-y-3">
                    <div className="rounded-xl border border-[#1f5e3b]/10 p-3">
                      <p className="text-sm font-medium text-[#1f5e3b]">Password Policy</p>
                      <p className="text-xs text-[#1f5e3b]/50 mt-1">Minimum 8 characters enforced. Password reset by Admin available in Employee profile.</p>
                    </div>
                    <div className="rounded-xl border border-[#1f5e3b]/10 p-3">
                      <p className="text-sm font-medium text-[#1f5e3b]">Session Expiry</p>
                      <p className="text-xs text-[#1f5e3b]/50 mt-1">
                        Current: <strong>{settings.session_ttl_days ?? 7} days</strong>. Change in General tab.
                      </p>
                    </div>
                    <div className="rounded-xl border border-[#1f5e3b]/10 p-3">
                      <p className="text-sm font-medium text-[#1f5e3b]">Account Lock</p>
                      <p className="text-xs text-[#1f5e3b]/50 mt-1">Admins can lock employee accounts from the Employee Management page.</p>
                    </div>
                    <div className="rounded-xl border border-[#1f5e3b]/10 p-3">
                      <p className="text-sm font-medium text-[#1f5e3b]">Role Hierarchy</p>
                      <p className="text-xs text-[#1f5e3b]/50 mt-1">Super Admin → Admin → Branch Manager / Attendance Manager → Staff</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ROLE VISIBILITY */}
          {tab === 'visibility' && isSuperAdmin && (
            <div className="space-y-5">
              <div className="ph-card rounded-2xl p-6 space-y-5">
                <div>
                  <h2 className="text-base font-bold text-[#1f5e3b]">👁️ Role Visibility Control</h2>
                  <p className="text-xs text-[#1f5e3b]/60 mt-1">
                    Control which dashboard sections are visible per role. Changes take effect immediately after saving.
                  </p>
                </div>

                <div className="overflow-x-auto space-y-4">
                  {Object.entries(MODULE_GROUPS).map(([groupName, mods]) => (
                    <div key={groupName}>
                      <p className="text-xs font-bold text-[#1f5e3b]/55 uppercase tracking-wide mb-1 px-1">{groupName}</p>
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="border-b-2 border-[#1f5e3b]/15">
                            <th className="text-left py-2 pr-4 text-xs font-bold text-[#1f5e3b]/60 uppercase tracking-wide w-56">Module</th>
                            {CONFIGURABLE_ROLES.map((role) => (
                              <th key={role} className="text-center py-2 px-3 text-xs font-bold text-[#1f5e3b]/60 uppercase tracking-wide">
                                {role === 'USER' ? 'Staff'
                                  : role === 'ATTENDANCE_MANAGER' ? 'Att. Mgr'
                                  : role === 'LOCATION_MANAGER' ? 'Loc. Mgr'
                                  : role}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#1f5e3b]/8">
                          {mods.map((mod) => (
                            <tr key={mod} className="hover:bg-[#1f5e3b]/3">
                              <td className="py-3 pr-4">
                                <p className="font-medium text-[#14261a] text-xs">{MODULE_LABELS[mod]}</p>
                                <p className="text-[10px] text-[#1f5e3b]/45 font-mono">{mod}</p>
                              </td>
                              {CONFIGURABLE_ROLES.map((role) => {
                                const val = visibilityDraft[role]?.[mod] ?? false
                                return (
                                  <td key={role} className="text-center py-3 px-3">
                                    <Toggle
                                      checked={val}
                                      onChange={(v) => toggleVisibility(role, mod, v)}
                                      disabled={visSaving}
                                    />
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-4 pt-2 border-t border-[#1f5e3b]/10">
                  <button
                    type="button"
                    onClick={() => void saveVisibility()}
                    disabled={visSaving}
                    className="rounded-xl bg-[#1f5e3b] px-5 py-2 text-sm font-semibold text-white hover:bg-[#174d30] disabled:opacity-50"
                  >
                    {visSaving ? 'Saving…' : '💾 Save Visibility Settings'}
                  </button>
                  <button
                    type="button"
                    onClick={() => visibilityData && setVisibilityDraft(JSON.parse(JSON.stringify(visibilityData)))}
                    disabled={visSaving}
                    className="rounded-xl border border-[#1f5e3b]/30 px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/5 disabled:opacity-50"
                  >
                    Reset
                  </button>
                  <span className="text-xs text-[#1f5e3b]/50">Super Admin always sees all sections regardless of this setting.</span>
                </div>
              </div>

              {/* Branch Access Control */}
              <div className="ph-card rounded-2xl p-5 space-y-4">
                <div>
                  <h3 className="font-bold text-[#1f5e3b] text-sm">🏢 Branch Access Control</h3>
                  <p className="text-xs text-[#1f5e3b]/55 mt-0.5">Control which branches each role can view data for. Unchecked = hidden from that role's data scope.</p>
                </div>
                {branches.length === 0 ? (
                  <p className="text-xs text-[#1f5e3b]/40 italic">No branches loaded.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b-2 border-[#1f5e3b]/15">
                          <th className="text-left py-2 pr-4 text-xs font-bold text-[#1f5e3b]/60 uppercase tracking-wide w-44">Branch</th>
                          {BRANCH_ROLES.map((role) => (
                            <th key={role} className="text-center py-2 px-3 text-xs font-bold text-[#1f5e3b]/60 uppercase tracking-wide">
                              {role === 'ATTENDANCE_MANAGER' ? 'Att. Mgr'
                                : role === 'LOCATION_MANAGER' ? 'Loc. Mgr'
                                : role}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1f5e3b]/8">
                        {branches.map((branch) => (
                          <tr key={branch.id} className="hover:bg-[#1f5e3b]/3">
                            <td className="py-3 pr-4">
                              <p className="font-medium text-[#14261a] text-xs">{branch.name}</p>
                              <p className="text-[10px] text-[#1f5e3b]/40">ID {branch.id}</p>
                            </td>
                            {BRANCH_ROLES.map((role) => (
                              <td key={role} className="text-center py-3 px-3">
                                <Toggle
                                  checked={isBranchAccessible(role, branch.id)}
                                  onChange={(v) => toggleBranchAccess(role, branch.id, v)}
                                  disabled={branchSaving}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex items-center gap-4 pt-2 border-t border-[#1f5e3b]/10">
                  <button
                    type="button"
                    onClick={() => void saveBranches()}
                    disabled={branchSaving || branches.length === 0}
                    className="rounded-xl bg-[#1f5e3b] px-5 py-2 text-sm font-semibold text-white hover:bg-[#174d30] disabled:opacity-50"
                  >
                    {branchSaving ? 'Saving…' : '💾 Save Branch Access'}
                  </button>
                  <span className="text-xs text-[#1f5e3b]/50">SUPER_ADMIN and own-branch-scoped roles always retain their default access.</span>
                </div>
              </div>

              <div className="ph-card rounded-2xl p-5 border-l-4 border-blue-300 bg-blue-50/30 space-y-2">
                <p className="text-sm font-bold text-blue-800">ℹ️ How this works</p>
                <ul className="text-xs text-blue-700/80 space-y-1 list-disc pl-4">
                  <li>Module toggles hide/show dashboard sections and sidebar nav items for each role</li>
                  <li>Staff (USER role) by default only sees their own attendance status</li>
                  <li>Branch access control limits which branch data a role can see in lists and reports</li>
                  <li>Admin sees all company data; Super Admin always has full access</li>
                  <li>Hiding a section does not delete data — it only hides the UI panel</li>
                </ul>
              </div>
            </div>
          )}

          {/* HINDI GUIDE */}
          {tab === 'guide' && (
            <div className="space-y-4 text-sm leading-relaxed text-[#14261a]">
              <div className="ph-card rounded-2xl p-5 border-l-4 border-green-400">
                <h2 className="font-bold text-[#1f5e3b] text-base mb-3">📖 सिस्टम गाइड — Settings कैसे बदलें</h2>
                <ol className="list-decimal pl-5 space-y-2">
                  <li>बाईं तरफ जो category चाहिए उसे click करें (General, Attendance, etc.)</li>
                  <li>जो setting बदलनी है उसे ON/OFF toggle करें या value भरें</li>
                  <li><strong>Save</strong> button दबाएँ — बदलाव तुरंत apply हो जाएगा</li>
                </ol>
                <div className="mt-3 rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-2 text-xs text-yellow-800">
                  ⚠️ ध्यान रखें: गलत setting से पूरे system पर असर पड़ सकता है। बदलाव केवल Admin / Super Admin ही करें।
                </div>
              </div>

              <div className="ph-card rounded-2xl p-5">
                <h2 className="font-bold text-[#1f5e3b] mb-3">👆 Attendance System</h2>
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>Dashboard से Attendance या Kiosk page खोलें</li>
                  <li>Field staff: GPS check-in/out use करें</li>
                  <li>Office staff: Office location button से punch करें</li>
                  <li>PIN enabled है तो Kiosk में Employee ID + PIN से punch करें</li>
                  <li>गलत entry हो तो manager Manual Override से record सही करे</li>
                </ol>
              </div>

              <div className="ph-card rounded-2xl p-5">
                <h2 className="font-bold text-[#1f5e3b] mb-3">📋 Leave System</h2>
                <ol className="list-decimal pl-5 space-y-1.5">
                  <li>Staff future date के लिए leave apply करे (reason mandatory)</li>
                  <li>Manager/Admin request खोलकर thread में reply कर सकते हैं</li>
                  <li>Pending stage में staff भी chat thread में जवाब दे सकता है</li>
                  <li>Approve होने पर leave attendance में reflect होती है</li>
                </ol>
              </div>

              <div className="ph-card rounded-2xl p-5">
                <h2 className="font-bold text-[#1f5e3b] mb-3">👥 Staff Management</h2>
                <ul className="list-disc pl-5 space-y-1.5">
                  <li>Employee edit में attendance modes (GPS/Face/Thumb/Manual) control करें</li>
                  <li>Super Admin reset password और secure temporary reveal कर सकता है</li>
                  <li>Documents upload के बाद Admin approve/reject status update करे</li>
                  <li>Delete करने पर employee Trash में जाता है, 30 दिन बाद auto-remove</li>
                </ul>
              </div>

              <div className="ph-card rounded-2xl p-5">
                <h2 className="font-bold text-[#1f5e3b] mb-3">🛠️ Troubleshooting</h2>
                <ul className="list-disc pl-5 space-y-1.5">
                  <li>Check-in fail हो तो GPS permission और internet on रखें</li>
                  <li>PIN fail हो तो manager से PIN reset/register करवाएं</li>
                  <li>Face issue हो तो Identity page में "face update" flow follow करें</li>
                  <li>Data sync issue हो तो Company/Config panel में Google Sheet test run करें</li>
                </ul>
              </div>

              <div className="ph-card rounded-2xl p-5 border-l-4 border-blue-400">
                <h2 className="font-bold text-[#1f5e3b] mb-3">📌 Role Permissions</h2>
                <div className="space-y-2 text-xs">
                  <div className="flex gap-2 items-center"><span className="w-36 font-semibold">Super Admin</span><span className="text-[#1f5e3b]/70">सब कुछ — Create, Edit, Delete, Settings, Monitor</span></div>
                  <div className="flex gap-2 items-center"><span className="w-36 font-semibold">Admin</span><span className="text-[#1f5e3b]/70">Create, Edit, Delete, Settings (limited)</span></div>
                  <div className="flex gap-2 items-center"><span className="w-36 font-semibold">Branch Manager</span><span className="text-[#1f5e3b]/70">अपनी branch — Create, Edit (Delete नहीं)</span></div>
                  <div className="flex gap-2 items-center"><span className="w-36 font-semibold">Attendance Mgr</span><span className="text-[#1f5e3b]/70">केवल attendance manage</span></div>
                  <div className="flex gap-2 items-center"><span className="w-36 font-semibold">Staff</span><span className="text-[#1f5e3b]/70">केवल अपना dashboard देख सकते हैं</span></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
