import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'
import { LocationPickerMap } from '../components/LocationPickerMap'

type Branch = {
  id: number
  name: string
  lat: number | null
  lng: number | null
  radius_meters: number
  address?: string | null
  city?: string | null
  state?: string | null
  wifi_enabled?: number
  wifi_ssids?: string | null
}

function parseSsids(raw?: string | null) {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map((x) => String(x)) : []
  } catch {
    return []
  }
}

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  return useCallback(
    (...args: Parameters<T>) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => fn(...args), delay)
    },
    [fn, delay],
  )
}

interface FormState {
  name: string
  lat: number | null
  lng: number | null
  radius: number
  address: string
  city: string
  state: string
  wifiEnabled: boolean
  wifiSsids: string
}

const emptyForm = (): FormState => ({
  name: '',
  lat: null,
  lng: null,
  radius: 300,
  address: '',
  city: '',
  state: '',
  wifiEnabled: false,
  wifiSsids: '',
})

export function OfficePage() {
  const { user } = useAuth()
  const [branches, setBranches] = useState<Branch[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [gpsLoading, setGpsLoading] = useState(false)
  const [gpsErr, setGpsErr] = useState<string | null>(null)
  const [geocodeLoading, setGeocodeLoading] = useState(false)
  const [centerTrigger, setCenterTrigger] = useState(0)
  const [saving, setSaving] = useState(false)

  const can = canPerm(user, 'branches:read')
  const canWrite = canPerm(user, 'branches:write')

  const refresh = useCallback(() => {
    if (!can) return
    api<{ branches: Branch[] }>('/branches')
      .then((d) => setBranches(d.branches || []))
      .catch((e) => setErr((e as Error).message))
  }, [can])

  useEffect(() => { refresh() }, [refresh])

  async function fetchGeocode(lat: number, lng: number) {
    setGeocodeLoading(true)
    try {
      const g = await api<{ address: string | null; city: string | null; state: string | null }>(
        `/geocode/reverse?lat=${lat}&lng=${lng}`,
      )
      setForm((f) => ({
        ...f,
        address: g.address || f.address,
        city: g.city || f.city,
        state: g.state || f.state,
      }))
    } catch {
      // silent — user can fill manually
    } finally {
      setGeocodeLoading(false)
    }
  }

  const debouncedGeocode = useDebounce(fetchGeocode, 800)

  function handleMapMove(lat: number, lng: number) {
    setForm((f) => ({ ...f, lat, lng }))
    debouncedGeocode(lat, lng)
  }

  async function useCurrentLocation() {
    setGpsErr(null)
    if (!navigator.geolocation) {
      setGpsErr('इस browser में GPS सपोर्ट नहीं है।')
      return
    }
    setGpsLoading(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude
        const lng = pos.coords.longitude
        setForm((f) => ({ ...f, lat, lng }))
        setCenterTrigger((n) => n + 1)
        setGpsLoading(false)
        await fetchGeocode(lat, lng)
      },
      (err) => {
        setGpsLoading(false)
        if (err.code === 1) setGpsErr('लोकेशन परमिशन दें — browser settings में Allow करें।')
        else if (err.code === 2) setGpsErr('GPS सिग्नल नहीं मिला। दोबारा कोशिश करें।')
        else setGpsErr('Location fetch failed.')
      },
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  function openNew() {
    setForm(emptyForm())
    setEditingId(null)
    setGpsErr(null)
    setErr(null)
    setFormOpen(true)
  }

  function openEdit(b: Branch) {
    setForm({
      name: b.name,
      lat: b.lat,
      lng: b.lng,
      radius: b.radius_meters || 300,
      address: b.address || '',
      city: b.city || '',
      state: b.state || '',
      wifiEnabled: Number(b.wifi_enabled || 0) === 1,
      wifiSsids: parseSsids(b.wifi_ssids).join(', '),
    })
    setEditingId(b.id)
    setGpsErr(null)
    setErr(null)
    setFormOpen(true)
    setCenterTrigger((n) => n + 1)
  }

  function cancelForm() {
    setFormOpen(false)
    setEditingId(null)
    setGpsErr(null)
    setErr(null)
  }

  async function submitBranch(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (!form.name.trim()) { setErr('Location name required'); return }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        lat: form.lat,
        lng: form.lng,
        radius_meters: form.radius,
        address: form.address.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        wifi_enabled: form.wifiEnabled,
        wifi_ssids: form.wifiSsids
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      }
      if (editingId) await api(`/branches/${editingId}`, { method: 'PATCH', body: JSON.stringify(payload) })
      else await api('/branches', { method: 'POST', body: JSON.stringify(payload) })
      setFormOpen(false)
      setEditingId(null)
      refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function deleteBranch(id: number) {
    if (!confirm('इस location को delete करें?')) return
    setErr(null)
    try {
      await api(`/branches/${id}`, { method: 'DELETE' })
      refresh()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  if (!can) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center text-sm text-[#1f5e3b]">
        Office / branch directory is available to managers. Your assigned branch is managed by HR.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[960px] space-y-6 pb-10">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#1f5e3b]">Office Locations</h1>
        {canWrite && !formOpen && (
          <button
            type="button"
            onClick={openNew}
            className="flex items-center gap-2 rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[#17492e] transition-colors"
          >
            + Add Location
          </button>
        )}
      </div>

      {err && <p className="rounded-xl bg-red-50 px-4 py-2 text-sm text-red-600">{err}</p>}

      {/* ── Add / Edit Form ── */}
      {canWrite && formOpen && (
        <form
          onSubmit={submitBranch}
          className="ph-card rounded-2xl p-5 space-y-5"
        >
          <h2 className="text-lg font-semibold text-[#1f5e3b]">
            {editingId ? 'Edit Location' : 'New Location'}
          </h2>

          {/* Name */}
          <div>
            <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">
              Location Name *
            </label>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Amritsar Branch"
              className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
              required
            />
          </div>

          {/* GPS Button */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={useCurrentLocation}
              disabled={gpsLoading}
              className="flex items-center gap-2 rounded-xl border-2 border-[#1f5e3b] px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#1f5e3b]/10 transition-colors disabled:opacity-50"
            >
              {gpsLoading ? (
                <>
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#1f5e3b] border-t-transparent" />
                  Detecting…
                </>
              ) : (
                <>📍 Use Current Location</>
              )}
            </button>
            {form.lat != null && form.lng != null && (
              <span className="text-xs text-[#14261a]/60 font-mono">
                {form.lat.toFixed(6)}, {form.lng.toFixed(6)}
              </span>
            )}
            {geocodeLoading && (
              <span className="text-xs text-[#1f5e3b]/60 animate-pulse">Fetching address…</span>
            )}
          </div>
          {gpsErr && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 border border-amber-200">
              ⚠️ {gpsErr}
            </p>
          )}

          {/* Map */}
          <div>
            <label className="block mb-2 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">
              Map — click or drag marker to set location
            </label>
            <LocationPickerMap
              lat={form.lat}
              lng={form.lng}
              radius={form.radius}
              onMove={handleMapMove}
              centerTrigger={centerTrigger}
            />
            {form.lat == null && (
              <p className="mt-2 text-xs text-[#14261a]/50 text-center">
                📍 Click on the map or use "Use Current Location" to place the marker
              </p>
            )}
          </div>

          {/* Radius Slider */}
          <div>
            <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">
              Attendance Radius
            </label>
            <div className="flex items-center gap-3 mb-2">
              <input
                type="range"
                min={0}
                max={500}
                step={1}
                value={Math.min(form.radius, 500)}
                onChange={(e) => setForm((f) => ({ ...f, radius: Number(e.target.value) }))}
                className="flex-1 accent-[#1f5e3b]"
              />
              <div className="flex items-center gap-1 shrink-0">
                <input
                  type="number"
                  min={0}
                  max={5000}
                  value={form.radius}
                  onChange={(e) => {
                    const v = Math.max(0, Math.floor(Number(e.target.value) || 0))
                    setForm((f) => ({ ...f, radius: v }))
                  }}
                  className="w-20 rounded-xl border border-[#1f5e3b]/20 px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                />
                <span className="text-sm text-[#14261a]/60">m</span>
              </div>
            </div>
            <div className="flex justify-between text-xs text-[#14261a]/40">
              <span>0 m</span><span>100 m</span><span>250 m</span><span>500 m</span>
            </div>
            {form.radius === 0 && (
              <p className="mt-2 rounded-lg bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs text-blue-700">
                ℹ️ Radius 0m = strict match. A 5m GPS tolerance is applied internally to account for device accuracy.
              </p>
            )}
            {form.radius > 0 && form.radius < 20 && (
              <p className="mt-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 text-xs text-amber-700">
                ⚠️ Low radius ({form.radius}m) may cause attendance failures due to GPS accuracy limits (typically 3–15m).
              </p>
            )}
          </div>

          {/* Address fields — auto-filled, manually editable */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">
                Address {geocodeLoading && <span className="font-normal text-[#1f5e3b]/50">(auto-filling…)</span>}
              </label>
              <input
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="Street / locality (auto-filled)"
                className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
              />
            </div>
            <div>
              <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">City</label>
              <input
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                placeholder="City (auto-filled)"
                className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
              />
            </div>
            <div>
              <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">State</label>
              <input
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                placeholder="State (auto-filled)"
                className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
              />
            </div>
          </div>

          {/* WiFi */}
          <div className="rounded-xl border border-[#1f5e3b]/15 p-4 space-y-3 bg-[#f4faf7]">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.wifiEnabled}
                onChange={(e) => setForm((f) => ({ ...f, wifiEnabled: e.target.checked }))}
                className="h-4 w-4 accent-[#1f5e3b]"
              />
              <span className="text-sm font-medium text-[#1f5e3b]">Enable WiFi-based attendance restriction</span>
            </label>
            {form.wifiEnabled && (
              <div>
                <label className="block mb-1 text-xs font-semibold text-[#1f5e3b]/70 uppercase tracking-wide">
                  Allowed SSIDs (comma separated)
                </label>
                <input
                  value={form.wifiSsids}
                  onChange={(e) => setForm((f) => ({ ...f, wifiSsids: e.target.value }))}
                  placeholder="Office_WiFi, Branch_5G"
                  className="w-full rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                />
              </div>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-[#1f5e3b] px-6 py-2 text-sm font-semibold text-white hover:bg-[#17492e] transition-colors disabled:opacity-60"
            >
              {saving ? 'Saving…' : editingId ? 'Update Location' : 'Save Location'}
            </button>
            <button
              type="button"
              onClick={cancelForm}
              className="rounded-xl border border-[#1f5e3b]/20 px-5 py-2 text-sm font-medium text-[#1f5e3b] hover:bg-[#1f5e3b]/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── Branch Cards ── */}
      <div className="grid gap-4 sm:grid-cols-2">
        {branches.length === 0 && !formOpen && (
          <p className="col-span-2 text-center text-sm text-[#14261a]/50 py-8">
            No locations added yet. Click "Add Location" to get started.
          </p>
        )}
        {branches.map((b) => (
          <div key={b.id} className="ph-card rounded-2xl p-5 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <h2 className="font-semibold text-[#1f5e3b] text-base">{b.name}</h2>
              {canWrite && (
                <div className="flex gap-3 shrink-0">
                  <button
                    type="button"
                    className="text-xs font-semibold text-[#2e7d32] hover:underline"
                    onClick={() => openEdit(b)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-xs font-semibold text-red-700 hover:underline"
                    onClick={() => void deleteBranch(b.id)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>

            {/* Mini map preview if coords exist */}
            {b.lat != null && b.lng != null && (
              <div className="mt-2 overflow-hidden rounded-xl border border-[#1f5e3b]/10" style={{ height: 140 }}>
                <LocationPickerMap
                  lat={b.lat}
                  lng={b.lng}
                  radius={b.radius_meters}
                  onMove={() => {}}
                />
              </div>
            )}

            <p className="text-sm text-[#14261a]/75 pt-1">
              📍 {b.lat != null && b.lng != null ? `${b.lat.toFixed(5)}, ${b.lng.toFixed(5)}` : 'Location not set'}
            </p>
            <p className="text-sm text-[#14261a]/75">⭕ Radius: {b.radius_meters} m</p>
            {(b.address || b.city || b.state) && (
              <p className="text-sm text-[#14261a]/70">
                🏢 {[b.address, b.city, b.state].filter(Boolean).join(', ')}
              </p>
            )}
            <p className="text-xs text-[#14261a]/50">
              WiFi: {Number(b.wifi_enabled || 0) ? `Enabled (${parseSsids(b.wifi_ssids).join(', ') || 'no SSIDs'})` : 'Disabled'}
            </p>
          </div>
        ))}
      </div>

      {/* Add button at bottom when form is closed and branches exist */}
      {canWrite && !formOpen && branches.length > 0 && (
        <div className="text-center">
          <button
            type="button"
            onClick={openNew}
            className="rounded-xl border-2 border-dashed border-[#1f5e3b]/30 px-8 py-3 text-sm font-medium text-[#1f5e3b]/60 hover:border-[#1f5e3b]/60 hover:text-[#1f5e3b] transition-colors"
          >
            + Add another location
          </button>
        </div>
      )}

      {/* Initial state — no branches, no form */}
      {canWrite && !formOpen && branches.length === 0 && (
        <div className="text-center py-12">
          <p className="text-4xl mb-3">📍</p>
          <p className="text-[#14261a]/50 text-sm mb-4">
            Set up your office locations to enable GPS-based attendance
          </p>
          <button
            type="button"
            onClick={openNew}
            className="rounded-xl bg-[#1f5e3b] px-6 py-2.5 text-sm font-semibold text-white shadow hover:bg-[#17492e] transition-colors"
          >
            📍 Add First Location
          </button>
        </div>
      )}
    </div>
  )
}
