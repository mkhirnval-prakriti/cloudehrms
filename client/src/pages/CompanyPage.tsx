import { useQuery } from '@tanstack/react-query'
import { api, apiFetchUrl, getToken } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { PageSkeleton } from '../components/PageSkeleton'
import { useEffect, useState } from 'react'

type SheetStatus = {
  enabled: boolean
  mode: string
  google_sheet_link: string
  api_key: string
  default_webhook_url: string
  branch_map: Record<string, string>
  last_sync_at: string
  last_error: string
  branches: { id: number; name: string }[]
  snippet: string
  guide: string[]
}
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
type WifiNetwork = { ssid: string; password: string }
type CustomRole = { id: number; name: string; permissions?: string[]; active: number }

const INPUT = 'w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/20'
const BTN_PRI = 'rounded-lg bg-[#1f5e3b] px-4 py-2 text-xs font-semibold text-white transition hover:bg-[#17472d] disabled:opacity-60'
const BTN_SEC = 'rounded-lg border border-[#1f5e3b]/20 px-4 py-2 text-xs font-semibold text-[#1f5e3b] transition hover:bg-[#1f5e3b]/5'

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-xl border border-[#1f5e3b]/12 px-4 py-3">
      <span className="text-sm font-medium text-[#14261a] capitalize">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-[#1f5e3b]' : 'bg-gray-200'}`}
      >
        <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </label>
  )
}

export function CompanyPage() {
  const { user } = useAuth()
  const can = canPerm(user, 'settings:read')
  const isSuper = user?.role === 'SUPER_ADMIN'

  const [emails, setEmails] = useState('')
  const [msg, setMsg] = useState('')
  const [sheetMsg, setSheetMsg] = useState('')
  const [sheetLink, setSheetLink] = useState('')
  const [webhook, setWebhook] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [branchMap, setBranchMap] = useState<Record<string, string>>({})
  const [showSheetModal, setShowSheetModal] = useState(false)
  const [sheetModalTab, setSheetModalTab] = useState<'setup' | 'guide'>('setup')
  const [modules, setModules] = useState<Record<string, boolean>>({
    attendance: true, leave: true, kiosk: true, staff: true,
    documents: true, payroll: true, notices: true,
  })
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [profile, setProfile] = useState<CompanyProfile>({
    company_name: 'PRAKRITI HERBS PRIVATE LIMITED',
    legal_name: 'PRAKRITI HERBS PRIVATE LIMITED',
    gstin: '08AAQCP4095D1Z2',
    cin: 'U46497RJ2025PTC109202',
    email: '',
    address: 'Building No. 30 & 31, South Part, Bilochi Nagar A, Amer, Jaipur, Rajasthan - 302012',
    legal_address: 'Building No. 30 & 31, South Part, Bilochi Nagar A, Amer, Jaipur, Rajasthan - 302012',
    city: 'Jaipur', state: 'Rajasthan', pincode: '302012',
    authorized_signatory: 'Mandeep Kumar', director: 'Mandeep Kumar',
  })
  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[]>([])
  const [wifiEnabled, setWifiEnabled] = useState(false)
  const [newRoleName, setNewRoleName] = useState('')
  const [newRolePerms, setNewRolePerms] = useState('')
  const [assignRoleId, setAssignRoleId] = useState('')
  const [assignUserId, setAssignUserId] = useState('')

  const apkQ = useQuery({
    queryKey: ['mobile-apk'],
    queryFn: () => api<{ apk_url: string; note: string }>('/mobile/apk'),
    enabled: can,
  })
  const q = useQuery({
    queryKey: ['settings', 'company'],
    queryFn: () => api<Record<string, unknown>>('/settings'),
    enabled: can, retry: 2, staleTime: 60_000,
  })
  const sheetQ = useQuery({
    queryKey: ['sheet-status'],
    queryFn: () => api<SheetStatus>('/integrations/sheets/status'),
    enabled: isSuper,
  })
  const companyQ = useQuery({
    queryKey: ['company-profile'],
    queryFn: () => api<{ profile: CompanyProfile }>('/company/profile'),
    enabled: can,
  })
  const wifiQ = useQuery({
    queryKey: ['wifi-config'],
    queryFn: () => api<{ enabled: boolean; networks: WifiNetwork[] }>('/attendance/wifi-config'),
    enabled: isSuper,
  })
  const customRolesQ = useQuery({
    queryKey: ['custom-roles'],
    queryFn: () => api<{ roles: CustomRole[] }>('/roles/custom'),
    enabled: isSuper,
  })

  useEffect(() => {
    const f = (q.data?.features || {}) as Record<string, boolean>
    if (Object.keys(f).length > 0) setModules((prev) => ({ ...prev, ...f }))
  }, [q.data])
  useEffect(() => {
    if (sheetQ.data) {
      setSyncEnabled(!!sheetQ.data.enabled)
      setSheetLink(sheetQ.data.google_sheet_link || '')
      setWebhook(sheetQ.data.default_webhook_url || '')
      setApiKey(sheetQ.data.api_key || '')
      setBranchMap(sheetQ.data.branch_map || {})
    }
  }, [sheetQ.data])
  useEffect(() => {
    if (isSuper) void loadDailyReportRecipients()
  }, [isSuper])
  useEffect(() => { if (companyQ.data?.profile) setProfile(companyQ.data.profile) }, [companyQ.data])
  useEffect(() => {
    if (wifiQ.data) {
      setWifiEnabled(!!wifiQ.data.enabled)
      setWifiNetworks(Array.isArray(wifiQ.data.networks) ? wifiQ.data.networks : [])
    }
  }, [wifiQ.data])

  if (!can) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center text-sm text-[#1f5e3b]">
        Company settings are visible to HR / Admin roles.
      </div>
    )
  }

  async function saveDailyRecipients() {
    setMsg('')
    try {
      const list = emails.split(',').map((x) => x.trim()).filter(Boolean)
      await api('/settings/daily-report', { method: 'PATCH', body: JSON.stringify({ enabled: true, recipients: list }) })
      setMsg('Daily report recipients updated.')
    } catch (e) { setMsg((e as Error).message) }
  }

  async function connectSheet() {
    setSheetMsg('')
    try {
      await api('/integrations/sheets/connect', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true, mode: 'webhook', google_sheet_link: sheetLink.trim(), default_webhook_url: webhook.trim(), api_key: apiKey.trim(), branch_map: branchMap }),
      })
      setSheetMsg('Sheet connected successfully.')
      await sheetQ.refetch()
      setShowSheetModal(false)
    } catch (e) { setSheetMsg((e as Error).message) }
  }

  async function testConnection() {
    setSheetMsg('')
    try {
      await api('/integrations/sheets/test-connection', { method: 'POST', body: JSON.stringify({ webhook_url: webhook.trim() }) })
      setSheetMsg('Test connection successful.')
    } catch (e) { setSheetMsg((e as Error).message) }
  }

  async function manualSync() {
    setSheetMsg('')
    try {
      console.log('[CompanyPage] manual sync clicked')
      const r = await api<{ synced: number; failed: number }>('/integrations/sheets/manual-sync', { method: 'POST', body: JSON.stringify({}) })
      setSheetMsg(`Sync done. Synced: ${r.synced}, Failed: ${r.failed}`)
      await sheetQ.refetch()
    } catch (e) { setSheetMsg((e as Error).message) }
  }

  function copySnippet() {
    const text = sheetQ.data?.snippet || ''
    console.log('[CompanyPage] copy integration code clicked', { hasSnippet: !!text, length: text.length })
    navigator.clipboard.writeText(text).then(() => setSheetMsg('Integration code copied.'))
  }

  async function downloadSystemExport(path: '/system/export.xlsx' | '/system/export.pdf', name: string) {
    console.log('[CompanyPage] export clicked', { path, name })
    setMsg('')
    try {
      // CRITICAL: must use apiFetchUrl() so URL points at the API server, AND
      // must attach the Bearer token from getToken() — otherwise the SUPER_ADMIN
      // route returns 401 silently and the download appears "broken".
      const token = getToken()
      const url = apiFetchUrl(path)
      const res = await fetch(url, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      console.log('[CompanyPage] export response', { url, status: res.status, ok: res.ok, contentType: res.headers.get('content-type') })
      if (!res.ok) {
        // Try to extract a useful error message from JSON body
        let detail = ''
        try { const j = await res.json(); detail = j?.error || '' } catch { /* not json */ }
        if (res.status === 401) throw new Error('Session expired — please log in again.')
        if (res.status === 403) throw new Error('Only Super Admin can export full system data.')
        throw new Error(detail || `Export failed (HTTP ${res.status})`)
      }
      const blob = await res.blob()
      if (blob.size === 0) throw new Error('Export returned empty file.')
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objUrl)
      setMsg(`✅ Downloaded "${name}" (${Math.round(blob.size / 1024)} KB)`)
      setTimeout(() => setMsg(''), 5000)
    } catch (e) {
      console.error('[CompanyPage] export error', e)
      setMsg(`❌ ${(e as Error).message}`)
    }
  }

  async function loadDailyReportRecipients() {
    try {
      const cfg = await api<{ enabled?: boolean; recipients?: string[] }>('/settings/daily-report')
      if (Array.isArray(cfg.recipients)) setEmails(cfg.recipients.join(', '))
    } catch (e) {
      console.warn('[CompanyPage] failed to load daily report recipients', e)
    }
  }

  async function saveModules() {
    setMsg('')
    try {
      await api('/settings', { method: 'PATCH', body: JSON.stringify({ features: modules }) })
      setMsg('Module settings saved.')
      await q.refetch()
    } catch (e) { setMsg((e as Error).message) }
  }

  async function updateSyncToggle(enabled: boolean) {
    setSheetMsg('')
    try {
      await api('/integrations/sheets/connect', { method: 'PATCH', body: JSON.stringify({ enabled }) })
      setSyncEnabled(enabled)
      setSheetMsg(enabled ? 'Auto sync enabled.' : 'Auto sync disabled.')
      await sheetQ.refetch()
    } catch (e) { setSheetMsg((e as Error).message) }
  }

  async function saveCompanyProfile() {
    setMsg('')
    try {
      await api('/company/profile', { method: 'PATCH', body: JSON.stringify(profile) })
      setMsg('Company profile saved.')
      await companyQ.refetch()
    } catch (e) { setMsg((e as Error).message) }
  }

  async function saveWifiConfig() {
    setMsg('')
    try {
      await api('/attendance/wifi-config', { method: 'PATCH', body: JSON.stringify({ enabled: wifiEnabled, networks: wifiNetworks }) })
      setMsg('WiFi settings saved.')
      await wifiQ.refetch()
    } catch (e) { setMsg((e as Error).message) }
  }

  async function createRole() {
    setMsg('')
    try {
      const permissions = newRolePerms.split(',').map((x) => x.trim()).filter(Boolean)
      await api('/roles/custom', { method: 'POST', body: JSON.stringify({ name: newRoleName.trim(), permissions }) })
      setNewRoleName(''); setNewRolePerms('')
      setMsg('Custom role created.')
      await customRolesQ.refetch()
    } catch (e) { setMsg((e as Error).message) }
  }

  async function assignRoleToUser() {
    setMsg('')
    try {
      await api(`/roles/custom/${Number(assignRoleId)}/assign-user`, { method: 'POST', body: JSON.stringify({ user_id: Number(assignUserId) }) })
      setMsg('Custom role assigned to user.')
    } catch (e) { setMsg((e as Error).message) }
  }

  const sheetConnected = sheetQ.data?.enabled && (sheetQ.data?.default_webhook_url || sheetQ.data?.google_sheet_link)

  return (
    <div className="mx-auto max-w-[760px] space-y-6 pb-8">
      <div>
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Company</h1>
        <p className="mt-1 text-sm text-[#1f5e3b]/60">Company profile, settings, and integrations</p>
      </div>

      {q.error && (
        <div className="rounded-xl border border-red-200 bg-red-50/80 p-4 text-sm text-red-800">
          <p className="font-medium">Failed to load config</p>
          <p className="mt-1">{(q.error as Error).message}</p>
          <button type="button" onClick={() => q.refetch()} className={BTN_PRI + ' mt-3'}>Retry</button>
        </div>
      )}
      {q.isLoading && <PageSkeleton rows={4} />}
      {q.data && !q.isLoading && (
        <>
          {/* Company Profile */}
          {isSuper && (
            <div className="ph-card space-y-4 rounded-2xl p-6">
              <div>
                <h2 className="text-base font-semibold text-[#1f5e3b]">Company Profile</h2>
                <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Basic legal and contact information</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">Legal Name</label>
                  <input value={profile.legal_name || ''} onChange={(e) => setProfile((p) => ({ ...p, legal_name: e.target.value, company_name: e.target.value }))} placeholder="Legal Name" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">GSTIN</label>
                  <input value={profile.gstin || ''} onChange={(e) => setProfile((p) => ({ ...p, gstin: e.target.value }))} placeholder="GSTIN" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">CIN</label>
                  <input value={profile.cin || ''} onChange={(e) => setProfile((p) => ({ ...p, cin: e.target.value }))} placeholder="CIN" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">Company Email</label>
                  <input value={profile.email || ''} onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))} placeholder="Email" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">Authorised Signatory</label>
                  <input value={profile.authorized_signatory || ''} onChange={(e) => setProfile((p) => ({ ...p, authorized_signatory: e.target.value, director: e.target.value }))} placeholder="Signatory" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">Pincode</label>
                  <input value={profile.pincode || ''} onChange={(e) => setProfile((p) => ({ ...p, pincode: e.target.value }))} placeholder="Pincode" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">City</label>
                  <input value={profile.city || ''} onChange={(e) => setProfile((p) => ({ ...p, city: e.target.value }))} placeholder="City" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">State</label>
                  <input value={profile.state || ''} onChange={(e) => setProfile((p) => ({ ...p, state: e.target.value }))} placeholder="State" className={INPUT} />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">Full Address</label>
                  <input value={profile.legal_address || profile.address || ''} onChange={(e) => setProfile((p) => ({ ...p, legal_address: e.target.value, address: e.target.value }))} placeholder="Address" className={INPUT} />
                </div>
              </div>
              {msg && <p className="text-xs font-medium text-[#2e7d32]">{msg}</p>}
              <button type="button" onClick={saveCompanyProfile} className={BTN_PRI}>Save Profile</button>
            </div>
          )}

          {/* Attendance Controls */}
          {isSuper && (
            <div className="ph-card space-y-4 rounded-2xl p-6">
              <div>
                <h2 className="text-base font-semibold text-[#1f5e3b]">Attendance Controls</h2>
                <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Face, GPS, and WiFi attendance settings. Per-user controls are in Staff Edit.</p>
              </div>
              <Toggle checked={wifiEnabled} onChange={setWifiEnabled} label="Enable WiFi attendance restriction" />
              {wifiEnabled && (
                <div className="space-y-2">
                  {wifiNetworks.map((n, i) => (
                    <div key={`${n.ssid}-${i}`} className="grid gap-2 sm:grid-cols-[1fr,1fr,auto]">
                      <input value={n.ssid} onChange={(e) => setWifiNetworks((prev) => prev.map((x, idx) => idx === i ? { ...x, ssid: e.target.value } : x))} placeholder="WiFi SSID" className={INPUT} />
                      <input value={n.password} onChange={(e) => setWifiNetworks((prev) => prev.map((x, idx) => idx === i ? { ...x, password: e.target.value } : x))} placeholder="Password" className={INPUT} type="password" />
                      <button type="button" onClick={() => setWifiNetworks((prev) => prev.filter((_, idx) => idx !== i))} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50">Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setWifiNetworks((prev) => [...prev, { ssid: '', password: '' }])} className={BTN_SEC}>+ Add WiFi Network</button>
                </div>
              )}
              {msg && <p className="text-xs font-medium text-[#2e7d32]">{msg}</p>}
              <button type="button" onClick={saveWifiConfig} className={BTN_PRI}>Save WiFi Settings</button>
            </div>
          )}

          {/* Feature Modules */}
          {isSuper && (
            <div className="ph-card space-y-4 rounded-2xl p-6">
              <div>
                <h2 className="text-base font-semibold text-[#1f5e3b]">Feature Modules</h2>
                <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Turn individual modules on or off across the system</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.keys(modules).map((k) => (
                  <Toggle key={k} checked={!!modules[k]} onChange={(v) => setModules((prev) => ({ ...prev, [k]: v }))} label={k} />
                ))}
              </div>
              {msg && <p className="text-xs font-medium text-[#2e7d32]">{msg}</p>}
              <button type="button" onClick={saveModules} className={BTN_PRI}>Save Module Settings</button>
            </div>
          )}

          {/* Custom Roles */}
          {isSuper && (
            <div className="ph-card space-y-4 rounded-2xl p-6">
              <div>
                <h2 className="text-base font-semibold text-[#1f5e3b]">Custom Roles</h2>
                <p className="mt-0.5 text-xs text-[#1f5e3b]/60">Create and assign custom permission roles</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">Role Name</label>
                  <input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} placeholder="e.g. Regional Manager" className={INPUT} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[#14261a]">Permissions (comma separated)</label>
                  <input value={newRolePerms} onChange={(e) => setNewRolePerms(e.target.value)} placeholder="leave:read_all, users:read" className={INPUT} />
                </div>
              </div>
              <button type="button" onClick={createRole} className={BTN_PRI}>Create Role</button>
              {(customRolesQ.data?.roles || []).length > 0 && (
                <div className="space-y-2">
                  {(customRolesQ.data?.roles || []).map((r) => (
                    <div key={r.id} className="rounded-xl border border-[#1f5e3b]/12 p-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-[#14261a]">{r.name}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${r.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>{r.active ? 'Active' : 'Disabled'}</span>
                      </div>
                      <p className="mt-1 text-xs text-[#1f5e3b]/70">{(r.permissions || []).join(', ') || 'No permissions set'}</p>
                      <div className="mt-2 flex gap-2">
                        <button type="button" onClick={async () => { await api(`/roles/custom/${r.id}`, { method: 'PATCH', body: JSON.stringify({ active: r.active ? 0 : 1 }) }); await customRolesQ.refetch() }} className={BTN_SEC}>{r.active ? 'Disable' : 'Enable'}</button>
                        <button type="button" onClick={async () => { await api(`/roles/custom/${r.id}`, { method: 'DELETE' }); await customRolesQ.refetch() }} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-xl bg-[#f5faf6] p-3">
                <p className="mb-2 text-xs font-medium text-[#1f5e3b]">Assign role to user</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <input value={assignRoleId} onChange={(e) => setAssignRoleId(e.target.value)} placeholder="Role ID" className={INPUT} />
                  <input value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)} placeholder="User ID" className={INPUT} />
                  <button type="button" onClick={assignRoleToUser} className={BTN_PRI}>Assign</button>
                </div>
              </div>
              {msg && <p className="text-xs font-medium text-[#2e7d32]">{msg}</p>}
            </div>
          )}

          {/* System Automation Settings */}
          {isSuper && (
            <div className="ph-card space-y-4 rounded-2xl p-6">
              <div>
                <h2 className="text-base font-semibold text-[#1f5e3b]">System Automation Settings</h2>
                <p className="mt-0.5 text-xs text-[#1f5e3b]/60">यह सिस्टम के automatic काम (daily report आदि) को control करता है</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[#14261a]">Daily Report Recipients</label>
                <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="email1@domain.com, email2@domain.com" className={INPUT} />
                <p className="mt-1 text-[10px] text-[#1f5e3b]/55">Separate multiple emails with commas</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={saveDailyRecipients} className={BTN_PRI}>Save Recipients</button>
                <button type="button" onClick={() => { void downloadSystemExport('/system/export.xlsx', `full-system-${new Date().toISOString().slice(0, 10)}.xlsx`) }} className={BTN_SEC}>Export All Data (Excel)</button>
                <button type="button" onClick={() => { void downloadSystemExport('/system/export.pdf', `full-system-${new Date().toISOString().slice(0, 10)}.pdf`) }} className={BTN_SEC}>Export All Data (PDF)</button>
                {apkQ.data?.apk_url && (
                  <a href={apkQ.data.apk_url} className={BTN_SEC}>Download HRMS App</a>
                )}
              </div>
              {msg && <p className="text-xs font-medium text-[#2e7d32]">{msg}</p>}
            </div>
          )}

          {/* Excel / Google Sheet Integration */}
          {isSuper && (
            <div className="ph-card space-y-4 rounded-2xl p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-[#1f5e3b]">Excel / Google Sheet Sync</h2>
                  <p className="mt-0.5 text-xs text-[#1f5e3b]/60">
                    Attendance records automatically sync to your Google Sheet on every punch
                  </p>
                </div>
                {sheetConnected && (
                  <span className="flex items-center gap-1.5 rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-800">
                    <span className="h-2 w-2 rounded-full bg-green-500" />
                    Connected
                  </span>
                )}
              </div>

              {/* Connection status banner */}
              {sheetQ.data && !sheetConnected && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-amber-500 flex-shrink-0" />
                    <p className="font-semibold text-amber-800">Google Sheet Disconnected</p>
                  </div>
                  {sheetQ.data.last_error && (
                    <p className="text-amber-700 leading-relaxed">
                      <span className="font-medium">Last error:</span>{' '}
                      {sheetQ.data.last_error.startsWith('HTTP 404')
                        ? 'Apps Script URL expired or deleted (HTTP 404). आपको Google Apps Script में जाकर फिर से Deploy करना होगा और नया URL यहाँ save करना होगा।'
                        : sheetQ.data.last_error.startsWith('HTTP 403')
                          ? 'Apps Script access denied (HTTP 403). Script को "Execute as: Me" और "Who has access: Anyone" पर redeploy करें।'
                          : sheetQ.data.last_error.slice(0, 200)}
                    </p>
                  )}
                  <p className="text-amber-600 font-medium">→ नीचे "Connect Google Sheet" पर click करें और नया Apps Script URL डालें।</p>
                </div>
              )}

              {/* Status summary if connected */}
              {sheetQ.data && sheetConnected && (
                <div className="rounded-xl bg-[#f5faf6] p-4 text-xs text-[#1f5e3b]/80 space-y-2">
                  <Toggle checked={syncEnabled} onChange={updateSyncToggle} label="Auto Sync on every punch" />
                  {sheetQ.data.last_sync_at && (
                    <p className="px-1">Last sync: {new Date(sheetQ.data.last_sync_at).toLocaleString('en-IN')}</p>
                  )}
                  {sheetQ.data.last_error && (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                      <p className="font-medium text-red-700">Last error:</p>
                      <p className="mt-0.5 text-red-600">{sheetQ.data.last_error.slice(0, 200)}</p>
                    </div>
                  )}
                  {sheetQ.data.default_webhook_url && (
                    <p className="truncate px-1">Webhook: {sheetQ.data.default_webhook_url.slice(0, 50)}…</p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { setSheetMsg(''); setShowSheetModal(true) }}
                  className={BTN_PRI}
                >
                  {sheetConnected ? 'Edit Connection' : 'Connect Google Sheet'}
                </button>
                {sheetConnected && (
                  <button type="button" onClick={manualSync} className={BTN_SEC}>Manual Sync Now</button>
                )}
              </div>
              {sheetMsg && <p className="text-xs font-medium text-[#2e7d32]">{sheetMsg}</p>}
            </div>
          )}
        </>
      )}

      {/* Google Sheet Modal */}
      {showSheetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(e) => e.target === e.currentTarget && setShowSheetModal(false)}>
          <div className="ph-card w-full max-w-xl overflow-hidden rounded-2xl shadow-2xl">
            {/* Modal header */}
            <div className="border-b border-[#1f5e3b]/10 px-6 py-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-[#1f5e3b]">Connect Google Sheet</h3>
                <button type="button" onClick={() => setShowSheetModal(false)} className="text-[#1f5e3b]/50 hover:text-[#1f5e3b]">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={() => setSheetModalTab('setup')} className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${sheetModalTab === 'setup' ? 'bg-[#1f5e3b] text-white' : 'text-[#1f5e3b] hover:bg-[#1f5e3b]/8'}`}>Setup</button>
                <button type="button" onClick={() => setSheetModalTab('guide')} className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${sheetModalTab === 'guide' ? 'bg-[#1f5e3b] text-white' : 'text-[#1f5e3b] hover:bg-[#1f5e3b]/8'}`}>Setup Guide</button>
              </div>
            </div>

            <div className="max-h-[65vh] overflow-y-auto px-6 py-5">
              {sheetModalTab === 'setup' ? (
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[#14261a]">Google Sheet URL <span className="text-[#1f5e3b]/50">(optional, for reference)</span></label>
                    <input value={sheetLink} onChange={(e) => setSheetLink(e.target.value)} className={INPUT} placeholder="https://docs.google.com/spreadsheets/d/..." />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[#14261a]">Webhook / Apps Script URL <span className="text-red-500">*</span></label>
                    <input value={webhook} onChange={(e) => setWebhook(e.target.value)} className={INPUT} placeholder="https://script.google.com/macros/s/..." />
                    <p className="mt-1 text-[10px] text-[#1f5e3b]/55">Get this URL from Google Apps Script → Deploy as web app</p>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-[#14261a]">API Key <span className="text-[#1f5e3b]/50">(optional)</span></label>
                    <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} className={INPUT} placeholder="Bearer token if your webhook requires auth" type="password" />
                  </div>

                  {/* Branch-wise mapping */}
                  {(sheetQ.data?.branches || []).length > 0 && (
                    <div>
                      <label className="mb-2 block text-xs font-medium text-[#14261a]">Branch-wise Webhook URLs <span className="text-[#1f5e3b]/50">(optional — overrides default)</span></label>
                      <div className="space-y-2">
                        {(sheetQ.data?.branches || []).map((b) => (
                          <div key={b.id} className="grid gap-2 sm:grid-cols-[140px,1fr]">
                            <span className="flex items-center rounded-lg bg-[#f5faf6] px-3 py-2 text-xs font-semibold text-[#1f5e3b]">{b.name}</span>
                            <input
                              value={branchMap[String(b.id)] || ''}
                              onChange={(e) => setBranchMap((prev) => ({ ...prev, [String(b.id)]: e.target.value }))}
                              className={INPUT}
                              placeholder={`Webhook for ${b.name} (optional)`}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Auto-sync data preview */}
                  <div className="rounded-xl bg-[#f5faf6] p-4">
                    <p className="mb-2 text-xs font-semibold text-[#1f5e3b]">Data sent automatically on each punch:</p>
                    <div className="grid grid-cols-2 gap-1 text-xs text-[#1f5e3b]/80">
                      {['Employee Name', 'Employee ID', 'Branch', 'Role', 'Punch In', 'Punch Out', 'Total Hours', 'Date', 'Status'].map((h) => (
                        <span key={h} className="flex items-center gap-1">
                          <span className="text-[#2e7d32]">✓</span> {h}
                        </span>
                      ))}
                    </div>
                  </div>

                  {sheetMsg && (
                    <p className={`text-xs font-medium ${sheetMsg.includes('error') || sheetMsg.includes('Error') ? 'text-red-700' : 'text-[#2e7d32]'}`}>{sheetMsg}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm font-medium text-[#1f5e3b]">Google Sheet को HRMS से connect करने के steps:</p>
                  <ol className="space-y-3">
                    {[
                      { step: '1', title: 'Google Sheet खोलें', desc: 'sheets.google.com पर एक new spreadsheet बनाएं' },
                      { step: '2', title: 'Apps Script खोलें', desc: 'Extensions → Apps Script menu पर click करें' },
                      { step: '3', title: 'Code paste करें', desc: '"Copy Integration Code" button से latest code copy करें और Apps Script editor में paste करें' },
                      { step: '4', title: 'Web App deploy करें', desc: 'Deploy → New deployment → Web app select करें। "Anyone" access दें' },
                      { step: '5', title: 'URL copy करें', desc: 'Deploy के बाद मिला Webhook URL copy करें' },
                      { step: '6', title: 'HRMS में paste करें', desc: 'Setup tab में Webhook URL paste करें और Connect करें' },
                    ].map((s) => (
                      <li key={s.step} className="flex gap-3">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#1f5e3b] text-[10px] font-bold text-white">{s.step}</span>
                        <div>
                          <p className="text-sm font-medium text-[#14261a]">{s.title}</p>
                          <p className="text-xs text-[#1f5e3b]/70">{s.desc}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <button type="button" onClick={copySnippet} className={BTN_SEC + ' w-full justify-center'}>
                    Copy Integration Code
                  </button>
                  {sheetMsg && <p className="text-xs font-medium text-[#2e7d32]">{sheetMsg}</p>}
                </div>
              )}
            </div>

            <div className="border-t border-[#1f5e3b]/10 px-6 py-4">
              <div className="flex flex-wrap gap-2">
                {sheetModalTab === 'setup' && (
                  <>
                    <button type="button" onClick={connectSheet} className={BTN_PRI}>Save & Connect</button>
                    <button type="button" onClick={testConnection} className={BTN_SEC}>Test Connection</button>
                  </>
                )}
                <button type="button" onClick={() => setShowSheetModal(false)} className={BTN_SEC + ' ml-auto'}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
