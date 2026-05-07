import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, apiFetchUrl, getToken } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

type Emp = {
  id: number
  name: string
  role: string
  rbacRole: string
  department: string | null
  mobile: string | null
  email: string
  branch_id: number | null
  login_id?: string | null
  dob?: string | null
  joining_date?: string | null
  address?: string | null
  account_number?: string | null
  ifsc?: string | null
  bank_name?: string | null
  document_count?: number
  shift_start?: string
  shift_end?: string
  grace_minutes?: number
  profile_photo?: string | null
  active?: number
  allow_gps?: number
  allow_face?: number
  allow_manual?: number
  allow_biometric?: number
}

type Branch = { id: number; name: string }
type Department = { id: number; name: string; active?: number }

type UserRow = {
  id: number
  email: string
  full_name: string
  login_id?: string | null
  mobile?: string | null
  department?: string | null
  dob?: string | null
  joining_date?: string | null
  address?: string | null
  account_number?: string | null
  ifsc?: string | null
  bank_name?: string | null
  role: string
  branch_id: number | null
  active: number
}

type PasswordResetPerson = {
  id: number
  name?: string
  full_name?: string
  login_id?: string | null
}

type DocRow = {
  id: number
  user_id: number
  doc_type: string
  file_name: string
  file_path: string
  verified: number
}

const ROLE_OPTIONS = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'admin', label: 'Admin' },
  { value: 'branch_manager', label: 'Branch Manager' },
  { value: 'attendance_manager', label: 'Attendance Manager' },
  { value: 'staff', label: 'Staff' },
]

const RBAC_ROLE_OPTIONS = [
  { value: 'USER', label: 'Staff' },
  { value: 'ATTENDANCE_MANAGER', label: 'Attendance Manager' },
  { value: 'LOCATION_MANAGER', label: 'Branch Manager' },
  { value: 'ADMIN', label: 'Admin' },
  { value: 'SUPER_ADMIN', label: 'Super Admin' },
]

/** Returns the subset of ROLE_OPTIONS the actor may assign when creating a user */
function getAllowedSimpleRoles(actorRole: string | undefined) {
  if (actorRole === 'SUPER_ADMIN') return ROLE_OPTIONS
  if (actorRole === 'ADMIN') return ROLE_OPTIONS.filter((o) => !['super_admin', 'admin'].includes(o.value))
  return ROLE_OPTIONS.filter((o) => o.value === 'staff')
}

/** Returns the subset of RBAC_ROLE_OPTIONS the actor may assign when editing a user */
function getAllowedRbacRoles(actorRole: string | undefined) {
  if (actorRole === 'SUPER_ADMIN') return RBAC_ROLE_OPTIONS
  if (actorRole === 'ADMIN') return RBAC_ROLE_OPTIONS.filter((o) => !['ADMIN', 'SUPER_ADMIN'].includes(o.value))
  return RBAC_ROLE_OPTIONS.filter((o) => o.value === 'USER')
}

function roleLabel(emp: Emp) {
  const key = String(emp.rbacRole || emp.role || '').toUpperCase()
  const map: Record<string, string> = {
    SUPER_ADMIN: 'Super Admin',
    ADMIN: 'Admin',
    LOCATION_MANAGER: 'Branch Manager',
    ATTENDANCE_MANAGER: 'Attendance Manager',
    USER: 'Staff',
  }
  return map[key] || emp.role || key
}

function formatTime(t?: string | null) {
  if (!t) return '—'
  const [h, m] = t.split(':').map(Number)
  if (isNaN(h)) return t
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hh = h % 12 || 12
  return `${hh}:${String(m || 0).padStart(2, '0')} ${ampm}`
}

function completionPercent(r: Emp) {
  let p = 0
  if (r.name?.trim()) p += 10
  if (r.mobile?.trim()) p += 10
  if (r.dob?.trim()) p += 10
  if (r.address?.trim()) p += 10
  if (r.profile_photo?.trim()) p += 10
  if (Number(r.document_count || 0) > 0) p += 20
  const bankBits = [r.account_number, r.ifsc, r.bank_name].filter((x) => String(x || '').trim()).length
  p += Math.round((bankBits / 3) * 30)
  return Math.min(100, p)
}

export function EmployeesPage() {
  const params = useParams()
  const selectedEmployeeId = Number(params.id || 0) || null
  const { user } = useAuth()
  const [list, setList] = useState<Emp[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const canCreate = canPerm(user, 'users:create')
  const canUpdate = canPerm(user, 'users:update')
  const canBranches = canPerm(user, 'branches:read')
  const canTimings = canPerm(user, 'timings:write')
  const canManageDepartments = user?.role === 'SUPER_ADMIN'
  const isSuperAdmin = user?.role === 'SUPER_ADMIN'

  // ── Add Employee form ─────────────────────────────────────────────
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [roleSimple, setRoleSimple] = useState('staff')
  const [employeeId, setEmployeeId] = useState('')
  const [idPreview, setIdPreview] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [mobile, setMobile] = useState('')
  const [department, setDepartment] = useState('')
  const [staffSubType, setStaffSubType] = useState('Sales Executive')
  const [departments, setDepartments] = useState<Department[]>([])
  const [newDepartment, setNewDepartment] = useState('')
  const [dob, setDob] = useState('')
  const [joiningDate, setJoiningDate] = useState('')
  const [address, setAddress] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [ifsc, setIfsc] = useState('')
  const [bankName, setBankName] = useState('')
  const [createBranch, setCreateBranch] = useState<number | ''>('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [generatedPwInfo, setGeneratedPwInfo] = useState<{ name: string; login_id: string; password: string } | null>(null)

  // ── Filters / search ──────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [filterBranch, setFilterBranch] = useState<number | ''>('')
  const [filterDept, setFilterDept] = useState('')
  const [filterRole, setFilterRole] = useState('')
  const [dateFilter, setDateFilter] = useState<'all' | 'today' | 'yesterday' | 'custom'>('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  // ── Edit modal ────────────────────────────────────────────────────
  const [edit, setEdit] = useState<UserRow | null>(null)
  const [editName, setEditName] = useState('')
  const [editEmployeeId, setEditEmployeeId] = useState('')
  const [editMobile, setEditMobile] = useState('')
  const [editDepartment, setEditDepartment] = useState('')
  const [editRole, setEditRole] = useState('USER')
  const [editDob, setEditDob] = useState('')
  const [editJoiningDate, setEditJoiningDate] = useState('')
  const [editAddress, setEditAddress] = useState('')
  const [editAccountNumber, setEditAccountNumber] = useState('')
  const [editIfsc, setEditIfsc] = useState('')
  const [editBankName, setEditBankName] = useState('')
  const [editBranch, setEditBranch] = useState<number | ''>('')
  const [editActive, setEditActive] = useState(true)
  const [editAllowGps, setEditAllowGps] = useState(false)
  const [editAllowFace, setEditAllowFace] = useState(true)
  const [editAllowManual, setEditAllowManual] = useState(false)
  const [editAllowFingerprint, setEditAllowFingerprint] = useState(true)
  const [editPassword, setEditPassword] = useState('')
  const [showEditPassword, setShowEditPassword] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  const [editSaveMsg, setEditSaveMsg] = useState<string | null>(null)
  const [securityMsg, setSecurityMsg] = useState('')

  // ── Password Reset Modal ──────────────────────────────────────────
  const [pwResetTarget, setPwResetTarget] = useState<{ id: number; name: string; login_id: string } | null>(null)
  const [pwResetCustom, setPwResetCustom] = useState('')
  const [pwResetShow, setPwResetShow] = useState(false)
  const [pwResetResult, setPwResetResult] = useState<{ name: string; login_id: string; password: string } | null>(null)
  const [pwResetLoading, setPwResetLoading] = useState(false)
  const [pwResetErr, setPwResetErr] = useState<string | null>(null)

  // ── View Profile modal ────────────────────────────────────────────
  const [viewProfile, setViewProfile] = useState<Emp | null>(null)
  const [profileDocs, setProfileDocs] = useState<DocRow[]>([])

  // ── Change Shift modal ────────────────────────────────────────────
  const [shiftTarget, setShiftTarget] = useState<Emp | null>(null)
  const [shiftStart, setShiftStart] = useState('09:00')
  const [shiftEnd, setShiftEnd] = useState('18:00')
  const [shiftGrace, setShiftGrace] = useState(15)
  const [bulkMode, setBulkMode] = useState(false)
  const [bulkIds, setBulkIds] = useState<Set<number>>(new Set())
  const [shiftSaving, setShiftSaving] = useState(false)
  const [shiftMsg, setShiftMsg] = useState('')

  // ── View state ────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'table' | 'cards'>(() => {
    try { return localStorage.getItem('hrms-employees-view') === 'cards' ? 'cards' : 'table' } catch { return 'table' }
  })
  const [highlightEmployeeId, setHighlightEmployeeId] = useState<number | null>(null)
  const [lastAutoOpenedId, setLastAutoOpenedId] = useState<number | null>(null)
  const [autoOpenRetries, setAutoOpenRetries] = useState<Record<number, number>>({})

  // ── Derived ───────────────────────────────────────────────────────
  const branchById = useMemo(() => {
    const m = new Map<number, string>()
    branches.forEach((b) => m.set(b.id, b.name))
    return m
  }, [branches])

  const departmentNames = useMemo(() => departments.map((d) => d.name), [departments])

  const filteredList = useMemo(() => {
    let result = list
    const q = search.trim().toLowerCase()
    if (q) result = result.filter((r) => `${r.name} ${r.login_id || ''} ${r.mobile || ''}`.toLowerCase().includes(q))
    if (filterBranch !== '') result = result.filter((r) => r.branch_id === Number(filterBranch))
    if (filterDept) result = result.filter((r) => (r.department || '').toLowerCase() === filterDept.toLowerCase())
    if (filterRole) result = result.filter((r) => (r.rbacRole || r.role || '').toUpperCase() === filterRole.toUpperCase())
    return result
  }, [list, search, filterBranch, filterDept, filterRole])

  function branchLabel(emp: Emp) {
    if (emp.branch_id == null) return '—'
    return branchById.get(emp.branch_id) ?? `ID ${emp.branch_id}`
  }

  // ── Data fetching ─────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    setErr(null)
    setLoading(true)
    try {
      const employeesRes = await api<{ employees: Emp[] }>('/employees')
      setList(employeesRes.employees || [])
      if (canBranches) {
        const b = await api<{ branches: Branch[] }>('/branches')
        setBranches(b.branches || [])
      }
      const depRes = await api<{ departments: Department[] }>('/departments')
      setDepartments(depRes.departments || [])
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [canBranches])

  useEffect(() => {
    if (selectedEmployeeId) {
      void refresh()
    }
  }, [selectedEmployeeId, refresh])

  useEffect(() => { void refresh() }, [refresh])

  // Auto-open employee from URL param
  useEffect(() => {
    if (!selectedEmployeeId || loading) return
    if (lastAutoOpenedId === selectedEmployeeId) return
    const target = list.find((emp) => Number(emp.id) === Number(selectedEmployeeId))
    if (!target) {
      const retries = autoOpenRetries[selectedEmployeeId] || 0
      if (retries < 2) {
        setAutoOpenRetries((prev) => ({ ...prev, [selectedEmployeeId]: retries + 1 }))
        void refresh()
      }
      return
    }
    setHighlightEmployeeId(target.id)
    window.setTimeout(() => {
      const el = document.getElementById(`emp-row-${target.id}`) || document.getElementById(`emp-card-${target.id}`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    if (canUpdate) openEdit(target)
    setAutoOpenRetries((prev) => ({ ...prev, [selectedEmployeeId]: 99 }))
    setLastAutoOpenedId(selectedEmployeeId)
  }, [selectedEmployeeId, loading, list, canUpdate, lastAutoOpenedId, autoOpenRetries, refresh])

  // ID preview when branch changes in Add form
  useEffect(() => {
    if (!createBranch || !canCreate) { setIdPreview(null); return }
    api<{ preview: string }>(`/employees/preview-id?branch_id=${createBranch}`)
      .then((r) => setIdPreview(r.preview))
      .catch(() => setIdPreview(null))
  }, [createBranch, canCreate])

  // ── Add Employee ──────────────────────────────────────────────────
  async function createEmp(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const created = await api<{ employee?: Emp; user?: Emp; generated_password?: string }>('/employees', {
        method: 'POST',
        body: JSON.stringify({
          name, password: password || undefined,
          role: roleSimple,
          staff_sub_type: roleSimple === 'staff' ? staffSubType : undefined,
          login_id: employeeId.trim() || undefined,
          email: email.trim() || undefined,
          mobile: mobile || undefined,
          department: department || (roleSimple === 'staff' ? staffSubType : undefined),
          branch_id: createBranch !== '' ? Number(createBranch) : undefined,
          dob: dob || undefined,
          joining_date: joiningDate || undefined,
          address: address || undefined,
          account_number: accountNumber || undefined,
          ifsc: ifsc || undefined,
          bank_name: bankName || undefined,
        }),
      })
      const createdEmp = created.employee || created.user
      if (createdEmp?.id) {
        setList((prev) => [createdEmp, ...prev.filter((x) => Number(x.id) !== Number(createdEmp.id))])
      }
      // If system auto-generated a password, show it once so admin can share with staff
      if (created.generated_password && createdEmp) {
        setGeneratedPwInfo({
          name: createdEmp.name,
          login_id: createdEmp.login_id ?? '',
          password: created.generated_password,
        })
      }
      setName(''); setPassword(''); setEmployeeId(''); setEmail(''); setMobile('')
      setDepartment(''); setStaffSubType('Sales Executive'); setDob('')
      setJoiningDate(''); setAddress(''); setAccountNumber(''); setIfsc('')
      setBankName(''); setCreateBranch(''); setShowAddForm(false)
      await refresh()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  // ── Edit Employee ─────────────────────────────────────────────────
  function openEdit(emp: Emp) {
    if (!canUpdate) return
    setEdit({
      id: emp.id, email: emp.email, full_name: emp.name,
      login_id: emp.login_id ?? null, mobile: emp.mobile ?? null,
      department: emp.department ?? null, dob: emp.dob ?? null,
      joining_date: emp.joining_date ?? null, address: emp.address ?? null,
      account_number: emp.account_number ?? null, ifsc: emp.ifsc ?? null,
      bank_name: emp.bank_name ?? null, role: emp.rbacRole, branch_id: emp.branch_id,
      active: emp.active !== 0 ? 1 : 0,
    })
    setEditName(emp.name); setEditEmployeeId(emp.login_id || '')
    setEditMobile(emp.mobile || ''); setEditDepartment(emp.department || '')
    setEditRole(emp.rbacRole || 'USER'); setEditDob(emp.dob || '')
    setEditJoiningDate(emp.joining_date || ''); setEditAddress(emp.address || '')
    setEditAccountNumber(emp.account_number || ''); setEditIfsc(emp.ifsc || '')
    setEditBankName(emp.bank_name || ''); setEditBranch(emp.branch_id ?? '')
    setEditActive(emp.active !== 0)
    setEditAllowGps(Number(emp.allow_gps ?? 0) !== 0)
    setEditAllowFace(Number(emp.allow_face ?? 1) !== 0)
    setEditAllowManual(Number(emp.allow_manual ?? 0) !== 0)
    setEditAllowFingerprint(Number(emp.allow_biometric ?? 1) !== 0)
    setEditPassword(''); setShowEditPassword(false); setEditSaveMsg(null); setSecurityMsg('')
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!edit) return
    setErr(null)
    setEditSaveMsg(null)
    setEditSaving(true)
    try {
      await api(`/users/${edit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          full_name: editName, login_id: editEmployeeId || undefined,
          mobile: editMobile || undefined, department: editDepartment || undefined,
          role: editRole || undefined, dob: editDob || undefined,
          joining_date: editJoiningDate || undefined, address: editAddress || undefined,
          account_number: editAccountNumber || undefined, ifsc: editIfsc || undefined,
          bank_name: editBankName || undefined,
          branch_id: editBranch === '' ? null : Number(editBranch),
          active: editActive, allow_gps: editAllowGps, allow_face: editAllowFace,
          allow_manual: editAllowManual, allow_biometric: editAllowFingerprint,
          password: user?.role === 'SUPER_ADMIN' && editPassword.trim() ? editPassword.trim() : undefined,
        }),
      })
      setEditSaveMsg('✅ Employee updated successfully')
      await refresh()
      setTimeout(() => { setEdit(null); setEditSaveMsg(null) }, 1200)
    } catch (e) {
      setEditSaveMsg('❌ ' + ((e as Error).message || 'Save failed — please try again'))
    } finally {
      setEditSaving(false)
    }
  }

  // ── Delete Employee ───────────────────────────────────────────────
  async function deleteEmp(id: number, name: string) {
    if (!window.confirm(`Delete ${name}? This will soft-delete the employee.`)) return
    setErr(null)
    try {
      await api(`/staff/${id}`, { method: 'DELETE' })
      setList((prev) => prev.filter((x) => x.id !== id))
    } catch (e) { setErr((e as Error).message) }
  }

  // ── View Profile ──────────────────────────────────────────────────
  async function openProfile(emp: Emp) {
    setViewProfile(emp)
    try {
      const d = await api<{ documents: DocRow[] }>('/documents')
      setProfileDocs((d.documents || []).filter((x) => Number(x.user_id) === Number(emp.id)))
    } catch { setProfileDocs([]) }
  }

  // ── Change Shift ──────────────────────────────────────────────────
  function openShift(emp: Emp) {
    setShiftTarget(emp)
    setShiftStart(emp.shift_start || '09:00')
    setShiftEnd(emp.shift_end || '18:00')
    setShiftGrace(emp.grace_minutes ?? 15)
    setBulkMode(false)
    setBulkIds(new Set())
    setShiftMsg('')
  }

  function openBulkShift() {
    setShiftTarget(null)
    setShiftStart('09:00')
    setShiftEnd('18:00')
    setShiftGrace(15)
    setBulkMode(true)
    setBulkIds(new Set())
    setShiftMsg('')
  }

  function toggleBulkId(id: number) {
    setBulkIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function saveShift(e: React.FormEvent) {
    e.preventDefault()
    setShiftSaving(true)
    setShiftMsg('')
    setErr(null)
    try {
      if (bulkMode) {
        const ids = Array.from(bulkIds)
        if (ids.length === 0) throw new Error('Select at least one employee')
        await api('/timings/bulk', {
          method: 'PATCH',
          body: JSON.stringify({ ids, shift_start: shiftStart, shift_end: shiftEnd, grace_minutes: shiftGrace }),
        })
        setShiftMsg(`Shift updated for ${ids.length} employee(s)`)
      } else if (shiftTarget) {
        await api(`/timings/${shiftTarget.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ shift_start: shiftStart, shift_end: shiftEnd, grace_minutes: shiftGrace }),
        })
        setShiftMsg('Shift updated successfully')
      }
      await refresh()
      setTimeout(() => { setShiftTarget(null); setBulkMode(false); setShiftMsg('') }, 1200)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setShiftSaving(false)
    }
  }

  // ── Password Reset Modal helpers ──────────────────────────────────
  function openPwResetModal(emp: PasswordResetPerson) {
    const displayName = emp.name || emp.full_name || ''
    setPwResetTarget({ id: emp.id, name: displayName, login_id: emp.login_id ?? '' })
    setPwResetCustom('')
    setPwResetShow(false)
    setPwResetResult(null)
    setPwResetErr(null)
  }

  async function submitPwReset(useRandom = false) {
    if (!pwResetTarget) return
    setPwResetLoading(true)
    setPwResetErr(null)
    try {
      const body: Record<string, string> = {}
      if (!useRandom && pwResetCustom.trim()) body.new_password = pwResetCustom.trim()
      const r = await api<{ new_password?: string; staff_name?: string; message?: string }>(`/users/${pwResetTarget.id}/reset-password`, {
        method: 'POST', body: JSON.stringify(body),
      })
      if (r.new_password) {
        setPwResetResult({ name: pwResetTarget.name, login_id: pwResetTarget.login_id, password: r.new_password })
        setPwResetCustom('')
      }
    } catch (e) {
      setPwResetErr((e as Error).message)
    } finally {
      setPwResetLoading(false)
    }
  }

  async function lockUser(id: number) {
    try {
      await api(`/users/${id}/lock`, { method: 'POST', body: JSON.stringify({}) })
      setSecurityMsg('User locked.')
      await refresh()
    } catch (e) { setErr((e as Error).message) }
  }

  async function unlockUser(id: number) {
    try {
      await api(`/users/${id}/unlock`, { method: 'POST', body: JSON.stringify({}) })
      setSecurityMsg('User unlocked.')
      await refresh()
    } catch (e) { setErr((e as Error).message) }
  }

  async function uploadPhoto(id: number, file: File) {
    try {
      const body = new FormData(); body.append('photo', file)
      await api(`/staff/${id}/photo`, { method: 'POST', body })
      await refresh()
    } catch (e) { setErr((e as Error).message) }
  }

  async function createDepartment() {
    const n = newDepartment.trim(); if (!n) return
    try {
      await api('/departments', { method: 'POST', body: JSON.stringify({ name: n }) })
      setNewDepartment(''); await refresh()
    } catch (e) { setErr((e as Error).message) }
  }

  async function deleteDepartment(id: number) {
    try { await api(`/departments/${id}`, { method: 'DELETE' }); await refresh() }
    catch (e) { setErr((e as Error).message) }
  }

  function setView(next: 'table' | 'cards') {
    setViewMode(next)
    try { localStorage.setItem('hrms-employees-view', next) } catch { /* ignore */ }
  }

  async function exportEmployees(format: 'csv' | 'xlsx' | 'pdf') {
    const qs = new URLSearchParams(); qs.set('date_filter', dateFilter)
    if (dateFilter === 'custom') { if (fromDate) qs.set('from', fromDate); if (toDate) qs.set('to', toDate) }
    const token = getToken()
    const url = `${apiFetchUrl('/employees/export.' + format)}?${qs.toString()}`
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined, credentials: 'include' })
    if (!res.ok) throw new Error(`Export failed (${res.status})`)
    const blob = await res.blob()
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = href; a.download = `employees.${format}`
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href)
  }

  const activeCount = list.filter((e) => e.active !== 0).length

  // ════════════════════════════════════════════════════════════════
  return (
    <div className="mx-auto max-w-[1200px] space-y-6 pb-10">

      {/* ── Auto-generated Password Dialog ── */}
      {generatedPwInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-2xl">🔑</span>
              <h2 className="text-lg font-bold text-[#1f5e3b]">Auto-Generated Password</h2>
            </div>
            <p className="mb-4 text-sm text-gray-600">
              Password was not set manually, so the system generated one. <strong>Note this down now</strong> — यह password दोबारा नहीं दिखेगा।
            </p>
            <div className="mb-2 rounded-xl bg-[#f0f9f2] p-3 text-sm">
              <div className="mb-1"><span className="font-medium text-gray-500">Employee:</span> <span className="font-semibold text-gray-800">{generatedPwInfo.name}</span></div>
              <div className="mb-1"><span className="font-medium text-gray-500">Login ID:</span> <span className="font-mono font-semibold text-[#1f5e3b]">{generatedPwInfo.login_id}</span></div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-500">Password:</span>
                <span className="font-mono font-bold text-[#d32f2f] text-base tracking-wider">{generatedPwInfo.password}</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(generatedPwInfo.password)}
                  className="ml-1 rounded-lg border border-[#1f5e3b]/20 px-2 py-0.5 text-xs text-[#1f5e3b] hover:bg-[#e8f5e9]"
                >Copy</button>
              </div>
            </div>
            <p className="mb-4 text-xs text-amber-700 bg-amber-50 rounded-lg p-2">
              Staff को यह password share करें। बाद में उन्हें login करके खुद बदलने को कहें।
            </p>
            <button
              type="button"
              onClick={() => setGeneratedPwInfo(null)}
              className="w-full rounded-xl bg-[#1f5e3b] py-2 text-sm font-semibold text-white hover:bg-[#174d30]"
            >
              समझ गया (OK)
            </button>
          </div>
        </div>
      )}

      {/* ── Password Reset Modal ── */}
      {pwResetTarget && !pwResetResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">🔑</span>
                <h2 className="text-lg font-bold text-[#1f5e3b]">Password Reset करें</h2>
              </div>
              <button type="button" onClick={() => setPwResetTarget(null)} className="text-gray-400 hover:text-gray-600 text-xl font-bold">×</button>
            </div>
            <p className="mb-4 text-sm text-gray-500">
              <span className="font-semibold text-gray-700">{pwResetTarget.name}</span> &nbsp;·&nbsp; <span className="font-mono text-[#1f5e3b]">{pwResetTarget.login_id}</span>
            </p>

            <div className="mb-3 rounded-xl border border-[#1f5e3b]/15 p-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">नया Password टाइप करें</p>
              <div className="flex gap-2">
                <input
                  type={pwResetShow ? 'text' : 'password'}
                  value={pwResetCustom}
                  onChange={e => setPwResetCustom(e.target.value)}
                  placeholder="कम से कम 6 characters"
                  className="flex-1 rounded-xl border border-[#1f5e3b]/20 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
                />
                <button type="button" onClick={() => setPwResetShow(v => !v)}
                  className="shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50">
                  {pwResetShow ? 'छुपाएं' : 'दिखाएं'}
                </button>
              </div>
              <button
                type="button"
                disabled={pwResetLoading || !pwResetCustom.trim() || pwResetCustom.trim().length < 6}
                onClick={() => void submitPwReset(false)}
                className="w-full rounded-xl bg-[#1f5e3b] py-2 text-sm font-semibold text-white hover:bg-[#174d30] disabled:opacity-40"
              >
                {pwResetLoading ? 'Setting...' : '✓ यह Password Set करें'}
              </button>
            </div>

            <div className="relative my-2 flex items-center gap-2">
              <div className="flex-1 border-t border-gray-200" />
              <span className="text-xs text-gray-400">OR</span>
              <div className="flex-1 border-t border-gray-200" />
            </div>

            <button
              type="button"
              disabled={pwResetLoading}
              onClick={() => void submitPwReset(true)}
              className="w-full rounded-xl border border-[#1f5e3b]/25 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#f0f9f2] disabled:opacity-40"
            >
              {pwResetLoading ? 'Generating...' : '🎲 Random Password Generate करें'}
            </button>

            {pwResetErr && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{pwResetErr}</p>}

            <p className="mt-3 text-[10px] text-gray-400">
              नोट: Passwords one-way encryption में store होते हैं — पुराना password देखना technically impossible है। नया password set करके staff को बताएं।
            </p>
          </div>
        </div>
      )}

      {/* ── Password Reset Success ── */}
      {pwResetResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-2xl">✅</span>
              <h2 className="text-lg font-bold text-[#1f5e3b]">Password Set हो गया!</h2>
            </div>
            <p className="mb-4 text-sm text-gray-600">
              नीचे दिया password <strong>अभी note करें</strong> और staff को share करें — यह screen बंद होने के बाद दोबारा नहीं दिखेगा।
            </p>
            <div className="mb-4 rounded-xl bg-[#f0f9f2] p-4 space-y-2">
              <div className="flex gap-2 text-sm">
                <span className="w-24 font-medium text-gray-500 shrink-0">Staff:</span>
                <span className="font-semibold text-gray-800">{pwResetResult.name}</span>
              </div>
              <div className="flex gap-2 text-sm">
                <span className="w-24 font-medium text-gray-500 shrink-0">Login ID:</span>
                <span className="font-mono font-semibold text-[#1f5e3b]">{pwResetResult.login_id}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="w-24 font-medium text-gray-500 shrink-0">New Password:</span>
                <span className="font-mono font-bold text-[#d32f2f] text-lg tracking-widest">{pwResetResult.password}</span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(pwResetResult!.password)}
                  className="ml-auto shrink-0 rounded-lg border border-[#1f5e3b]/20 px-2.5 py-1 text-xs text-[#1f5e3b] hover:bg-[#e8f5e9]"
                >📋 Copy</button>
              </div>
            </div>
            <p className="mb-4 text-xs text-amber-700 bg-amber-50 rounded-lg p-2">
              Staff को यह password share करें। Login के बाद वे खुद नया password set कर सकते हैं।
            </p>
            <button
              type="button"
              onClick={() => { setPwResetResult(null); setPwResetTarget(null) }}
              className="w-full rounded-xl bg-[#1f5e3b] py-2 text-sm font-semibold text-white hover:bg-[#174d30]"
            >
              ठीक है (Close)
            </button>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1f5e3b]">Employee Management</h1>
          <p className="text-sm text-[#1f5e3b]/70">
            {activeCount} active · {list.length} total · Prakriti Herbs HRMS
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canTimings && (
            <button
              type="button"
              onClick={openBulkShift}
              className="rounded-xl border border-[#1f5e3b]/25 px-4 py-2 text-sm font-semibold text-[#1f5e3b] hover:bg-[#f0f9f2]"
            >
              Bulk Shift Change
            </button>
          )}
          {canCreate && (
            <button
              type="button"
              onClick={() => setShowAddForm((v) => !v)}
              className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white hover:bg-[#17472e]"
            >
              {showAddForm ? '✕ Cancel' : '+ Add Employee'}
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {err}
          <button type="button" className="ml-3 underline text-xs" onClick={() => setErr(null)}>Dismiss</button>
        </div>
      )}

      {/* ── Add Employee Form ── */}
      {canCreate && showAddForm && (
        <form onSubmit={createEmp} className="ph-card space-y-4 rounded-2xl border border-[#1f5e3b]/10 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-[#1f5e3b]">Add New Employee</h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Full Name <span className="text-red-500">*</span></span>
              <input required value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Mobile <span className="text-[#90a4ae] text-xs font-normal">(optional)</span></span>
              <input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="Leave blank if not available" className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Password <span className="text-[#90a4ae] text-xs font-normal">(auto-generated if blank)</span></span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Leave blank to auto-generate" className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Branch</span>
              <select value={createBranch} onChange={(e) => setCreateBranch(e.target.value === '' ? '' : Number(e.target.value))} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30">
                <option value="">Select branch</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Role</span>
              <select value={roleSimple} onChange={(e) => setRoleSimple(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30">
                {getAllowedSimpleRoles(user?.role).map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
            {roleSimple === 'staff' && (
              <label className="text-sm">
                <span className="mb-1 block font-medium">Designation</span>
                <select value={staffSubType} onChange={(e) => setStaffSubType(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30">
                  {departmentNames.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            )}
            <label className="text-sm">
              <span className="mb-1 block font-medium">
                Employee ID
                {idPreview && <span className="ml-2 text-[#1f5e3b]/60 font-normal text-xs">(auto: {idPreview})</span>}
              </span>
              <input
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                placeholder={idPreview || 'Leave blank to auto-generate'}
                className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Email (optional)</span>
              <input value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Department</span>
              <input list="dept-options-add" value={department} onChange={(e) => setDepartment(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/30" />
              <datalist id="dept-options-add">{departmentNames.map((d) => <option key={d} value={d} />)}</datalist>
            </label>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-sm text-[#1f5e3b] underline font-medium"
          >
            {showAdvanced ? '▲ Hide advanced fields' : '▼ Show advanced fields (DOB, Address, Bank)'}
          </button>

          {showAdvanced && (
            <div className="grid gap-4 rounded-xl bg-[#f7fbf8] p-4 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Date of Birth</span>
                <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Joining Date</span>
                <input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block font-medium">Address</span>
                <input value={address} onChange={(e) => setAddress(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Bank Account</span>
                <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">IFSC</span>
                <input value={ifsc} onChange={(e) => setIfsc(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block font-medium">Bank Name</span>
                <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
            </div>
          )}

          <div className="flex gap-3">
            <button type="submit" className="rounded-xl bg-[#1f5e3b] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#17472e]">
              Create Employee
            </button>
            <button type="button" onClick={() => setShowAddForm(false)} className="rounded-xl border border-[#1f5e3b]/20 px-4 py-2.5 text-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── Department Control ── */}
      {canManageDepartments && false && (
        <div className="ph-card rounded-2xl border border-[#1f5e3b]/10 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-[#1f5e3b]">Departments</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input value={newDepartment} onChange={(e) => setNewDepartment(e.target.value)} placeholder="New department name" className="rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-sm" />
            <button type="button" onClick={() => void createDepartment()} className="rounded-xl bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white">Add</button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {departments.map((d) => (
              <button key={d.id} type="button" onClick={() => void deleteDepartment(d.id)} className="rounded-full bg-[#e8f5e9] px-2.5 py-1 text-xs font-semibold text-[#1f5e3b]" title="Delete">
                {d.name} ×
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Employee Directory ── */}
      <div className="rounded-2xl border border-[#1f5e3b]/10 bg-white shadow-sm">

        {/* Search + Filters bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[#1f5e3b]/8 px-5 py-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name / ID / mobile…"
            className="min-w-[180px] flex-1 rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/25"
          />
          {canBranches && branches.length > 0 && (
            <select value={filterBranch} onChange={(e) => setFilterBranch(e.target.value === '' ? '' : Number(e.target.value))} className="rounded-xl border border-[#1f5e3b]/15 px-2.5 py-1.5 text-xs">
              <option value="">All Branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)} className="rounded-xl border border-[#1f5e3b]/15 px-2.5 py-1.5 text-xs">
            <option value="">All Depts</option>
            {departmentNames.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)} className="rounded-xl border border-[#1f5e3b]/15 px-2.5 py-1.5 text-xs">
            <option value="">All Roles</option>
            {RBAC_ROLE_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {(search || filterBranch !== '' || filterDept || filterRole) && (
            <button type="button" onClick={() => { setSearch(''); setFilterBranch(''); setFilterDept(''); setFilterRole('') }} className="text-xs text-red-500 underline">Clear</button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value as 'all')} className="rounded-xl border border-[#1f5e3b]/15 px-2 py-1.5 text-xs">
              <option value="all">All Time</option>
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="custom">Custom</option>
            </select>
            {dateFilter === 'custom' && (
              <>
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="rounded-xl border border-[#1f5e3b]/15 px-2 py-1.5 text-xs" />
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="rounded-xl border border-[#1f5e3b]/15 px-2 py-1.5 text-xs" />
              </>
            )}
            <button type="button" onClick={() => void exportEmployees('xlsx')} className="rounded-lg border border-[#1f5e3b]/20 px-2 py-1 text-xs font-semibold text-[#1f5e3b]">Excel</button>
            <button type="button" onClick={() => void exportEmployees('pdf')} className="rounded-lg border border-[#1f5e3b]/20 px-2 py-1 text-xs font-semibold text-[#1f5e3b]">PDF</button>
            <div className="inline-flex rounded-xl border border-[#1f5e3b]/15 p-0.5 text-xs font-semibold">
              {(['table', 'cards'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setView(m)}
                  className={`rounded-lg px-3 py-1.5 capitalize transition ${viewMode === m ? 'bg-[#1f5e3b] text-white' : 'text-[#1f5e3b]/70'}`}>
                  {m}
                </button>
              ))}
            </div>
            <button type="button" onClick={refresh} className="text-xs font-medium text-[#1f5e3b] underline">Refresh</button>
          </div>
        </div>

        {/* Results count */}
        <div className="px-5 pt-3 text-xs text-[#1f5e3b]/60">
          Showing {filteredList.length} of {list.length} employees
        </div>

        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-[#1f5e3b]/60">Loading…</div>
        ) : filteredList.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-[#1f5e3b]/50">No employees match your filters.</div>
        ) : viewMode === 'table' ? (

          /* ── Table View ── */
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr className="border-b border-[#1f5e3b]/8 text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/60">
                  <th className="px-5 py-3 w-10"></th>
                  <th className="px-3 py-3">Employee</th>
                  <th className="px-3 py-3">Designation</th>
                  <th className="px-3 py-3">Branch</th>
                  <th className="px-3 py-3">Shift</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Complete</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f5e3b]/5">
                {filteredList.map((r) => (
                  <tr key={r.id} id={`emp-row-${r.id}`} className={`group transition ${highlightEmployeeId === r.id ? 'bg-[#e8f5e9]/70' : 'hover:bg-[#f7fbf8]'}`}>
                    <td className="px-5 py-3">
                      {r.profile_photo ? (
                        <img src={r.profile_photo} alt="" className="h-9 w-9 rounded-full object-cover ring-2 ring-[#1f5e3b]/10" />
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-[#1f5e3b] to-[#2e7d52] text-xs font-bold text-white">
                          {r.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="font-semibold text-[#14261a]">{r.name}</div>
                      <div className="mt-0.5 font-mono text-xs text-[#546e7a]">{r.login_id || `#${r.id}`}</div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-sm text-[#37474f]">{roleLabel(r)}</div>
                      {r.department && <div className="mt-0.5 text-xs text-[#78909c]">{r.department}</div>}
                    </td>
                    <td className="px-3 py-3 text-sm text-[#37474f]">{branchLabel(r)}</td>
                    <td className="px-3 py-3">
                      <div className="text-xs tabular-nums text-[#37474f]">
                        {r.shift_start && r.shift_end
                          ? <><span className="font-medium">{formatTime(r.shift_start)}</span><span className="text-[#90a4ae]"> – </span><span className="font-medium">{formatTime(r.shift_end)}</span></>
                          : <span className="text-[#90a4ae]">Not set</span>
                        }
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {r.active === 0
                        ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">Inactive</span>
                        : <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">Active</span>
                      }
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[#e8f5e9]">
                          <div className="h-full rounded-full bg-[#1f5e3b]" style={{ width: `${completionPercent(r)}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-[#78909c]">{completionPercent(r)}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button type="button" onClick={() => void openProfile(r)} className="rounded-lg border border-[#1f5e3b]/20 px-2.5 py-1 text-xs font-semibold text-[#1f5e3b] hover:bg-[#f0f9f2]">View</button>
                        {canUpdate && <button type="button" onClick={() => openEdit(r)} className="rounded-lg border border-blue-200 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">Edit</button>}
                        {canTimings && <button type="button" onClick={() => openShift(r)} className="rounded-lg border border-amber-200 px-2.5 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50">Shift</button>}
                        {canUpdate && isSuperAdmin && (
                          <button type="button" onClick={() => void deleteEmp(r.id, r.name)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">Delete</button>
                        )}
                        {canUpdate && !isSuperAdmin && !['ADMIN', 'SUPER_ADMIN'].includes(r.rbacRole || '') && (
                          <button type="button" onClick={() => void deleteEmp(r.id, r.name)} className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">Delete</button>
                        )}
                        {canUpdate && (
                          <button type="button" onClick={() => openPwResetModal(r)} className="rounded-lg border border-orange-200 px-2.5 py-1 text-xs font-semibold text-orange-700 hover:bg-orange-50">🔑 Password</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        ) : (

          /* ── Card View ── */
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {filteredList.map((r) => (
              <div
                key={r.id}
                id={`emp-card-${r.id}`}
                className={`flex flex-col rounded-2xl border p-4 shadow-sm transition ${
                  highlightEmployeeId === r.id ? 'border-[#2e7d32] bg-[#e8f5e9]/60' : 'border-[#1f5e3b]/10 bg-white hover:shadow-md'
                }`}
              >
                <div className="flex items-start gap-3">
                  {r.profile_photo ? (
                    <img src={r.profile_photo} alt="" className="h-14 w-14 shrink-0 rounded-2xl object-cover ring-1 ring-[#1f5e3b]/10" />
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#1f5e3b] to-[#2e7d52] text-xl font-bold text-white ring-1 ring-[#1f5e3b]/10">
                      {r.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate font-semibold text-[#14261a]">{r.name}</h3>
                      {r.active === 0
                        ? <span className="shrink-0 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">Inactive</span>
                        : <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700">Active</span>
                      }
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-[#546e7a]">{r.login_id || `#${r.id}`}</p>
                    <p className="text-xs text-[#78909c]">{roleLabel(r)}{r.department ? ` · ${r.department}` : ''}</p>
                  </div>
                </div>
                <dl className="mt-3 space-y-1.5 text-xs text-[#37474f]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#90a4ae]">Branch</dt>
                    <dd className="font-medium text-right">{branchLabel(r)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#90a4ae]">Shift</dt>
                    <dd className="tabular-nums font-medium text-right">
                      {r.shift_start && r.shift_end ? `${formatTime(r.shift_start)} – ${formatTime(r.shift_end)}` : '—'}
                    </dd>
                  </div>
                  {r.mobile && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-[#90a4ae]">Mobile</dt>
                      <dd className="font-medium">{r.mobile}</dd>
                    </div>
                  )}
                </dl>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-[#90a4ae]">Profile</span>
                    <span className="font-semibold text-[#1f5e3b]">{completionPercent(r)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[#e8f5e9]">
                    <div className="h-full rounded-full bg-gradient-to-r from-[#1f5e3b] to-[#66bb6a]" style={{ width: `${completionPercent(r)}%` }} />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5 border-t border-[#1f5e3b]/8 pt-3">
                  <button type="button" onClick={() => void openProfile(r)} className="rounded-lg bg-[#1f5e3b] px-3 py-1.5 text-xs font-semibold text-white">View</button>
                  {canUpdate && <button type="button" onClick={() => openEdit(r)} className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-semibold text-blue-700">Edit</button>}
                  {canTimings && <button type="button" onClick={() => openShift(r)} className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-semibold text-amber-700">Shift</button>}
                  {canUpdate && isSuperAdmin && (
                    <button type="button" onClick={() => void deleteEmp(r.id, r.name)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600">Delete</button>
                  )}
                  {canUpdate && !isSuperAdmin && !['ADMIN', 'SUPER_ADMIN'].includes(r.rbacRole || '') && (
                    <button type="button" onClick={() => void deleteEmp(r.id, r.name)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600">Delete</button>
                  )}
                  {canUpdate && (
                    <label className="cursor-pointer rounded-lg border border-[#1f5e3b]/20 px-3 py-1.5 text-xs font-semibold text-[#1f5e3b]">
                      Photo
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadPhoto(r.id, f); e.currentTarget.value = '' }} />
                    </label>
                  )}
                  {canUpdate && (
                    <button type="button" onClick={() => openPwResetModal(r)} className="rounded-lg border border-orange-200 px-3 py-1.5 text-xs font-semibold text-orange-700 hover:bg-orange-50">
                      🔑 Password
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════
          VIEW PROFILE MODAL
      ══════════════════════════════════════════════════════════════ */}
      {viewProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" onClick={(e) => { if (e.target === e.currentTarget) setViewProfile(null) }}>
          <div className="ph-card max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white shadow-2xl">
            {/* Header */}
            <div className="flex items-start gap-4 border-b border-[#1f5e3b]/10 p-6">
              {viewProfile.profile_photo ? (
                <img src={viewProfile.profile_photo} alt="" className="h-20 w-20 shrink-0 rounded-2xl object-cover ring-2 ring-[#1f5e3b]/15" />
              ) : (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#1f5e3b] to-[#2e7d52] text-3xl font-bold text-white">
                  {viewProfile.name.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-bold text-[#14261a]">{viewProfile.name}</h2>
                <p className="mt-0.5 font-mono text-sm text-[#546e7a]">{viewProfile.login_id || `Employee #${viewProfile.id}`}</p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase ${viewProfile.active === 0 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
                    {viewProfile.active === 0 ? 'Inactive' : 'Active'}
                  </span>
                  <span className="rounded-full bg-[#e8f5e9] px-2.5 py-0.5 text-xs font-semibold text-[#1f5e3b]">{roleLabel(viewProfile)}</span>
                </div>
              </div>
              <button type="button" onClick={() => setViewProfile(null)} className="shrink-0 rounded-xl border border-[#1f5e3b]/15 px-3 py-1.5 text-xs text-[#1f5e3b]">✕ Close</button>
            </div>

            {/* Details grid */}
            <div className="p-6">
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  { label: 'Mobile', value: viewProfile.mobile },
                  { label: 'Email', value: viewProfile.email },
                  { label: 'Branch', value: branchLabel(viewProfile) },
                  { label: 'Department', value: viewProfile.department },
                  { label: 'Shift', value: viewProfile.shift_start && viewProfile.shift_end ? `${formatTime(viewProfile.shift_start)} – ${formatTime(viewProfile.shift_end)}` : null },
                  { label: 'Grace (min)', value: viewProfile.grace_minutes != null ? String(viewProfile.grace_minutes) : null },
                  { label: 'Joining Date', value: viewProfile.joining_date },
                  { label: 'Date of Birth', value: viewProfile.dob },
                  { label: 'Address', value: viewProfile.address },
                ].map(({ label, value }) => value ? (
                  <div key={label} className="rounded-xl bg-[#f7fbf8] px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[#78909c]">{label}</p>
                    <p className="mt-0.5 text-sm font-medium text-[#263238]">{value}</p>
                  </div>
                ) : null)}
              </div>

              {/* Bank details */}
              {(viewProfile.account_number || viewProfile.ifsc || viewProfile.bank_name) && (
                <div className="mt-4 rounded-xl border border-[#1f5e3b]/10 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/70">Bank Details</p>
                  <div className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                    {viewProfile.bank_name && <div><span className="text-xs text-[#90a4ae]">Bank</span><p className="font-medium">{viewProfile.bank_name}</p></div>}
                    {viewProfile.account_number && <div><span className="text-xs text-[#90a4ae]">Account</span><p className="font-medium font-mono">{viewProfile.account_number}</p></div>}
                    {viewProfile.ifsc && <div><span className="text-xs text-[#90a4ae]">IFSC</span><p className="font-medium font-mono">{viewProfile.ifsc}</p></div>}
                  </div>
                </div>
              )}

              {/* Documents */}
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/70">Documents ({profileDocs.length})</p>
                {profileDocs.length === 0
                  ? <p className="mt-2 text-xs text-[#90a4ae]">No documents uploaded.</p>
                  : (
                    <div className="mt-2 space-y-1">
                      {profileDocs.map((d) => (
                        <a key={d.id} href={d.file_path} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-[#1f5e3b]/10 bg-white px-3 py-2 text-xs hover:bg-[#f7fbf8]">
                          <span className="rounded bg-[#e8f5e9] px-1.5 py-0.5 font-semibold uppercase text-[#1f5e3b]">{d.doc_type}</span>
                          <span className="truncate text-[#546e7a]">{d.file_name}</span>
                          {d.verified === 1 && <span className="ml-auto shrink-0 text-emerald-600">✓ Verified</span>}
                        </a>
                      ))}
                    </div>
                  )
                }
              </div>

              {/* Action buttons */}
              <div className="mt-6 flex flex-wrap gap-2 border-t border-[#1f5e3b]/10 pt-4">
                {canUpdate && (
                  <button type="button" onClick={() => { openEdit(viewProfile); setViewProfile(null) }}
                    className="rounded-xl bg-[#1f5e3b] px-4 py-2 text-sm font-semibold text-white">
                    Edit Profile
                  </button>
                )}
                {canTimings && (
                  <button type="button" onClick={() => { openShift(viewProfile); setViewProfile(null) }}
                    className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-700">
                    Change Shift
                  </button>
                )}
                {canUpdate && (
                  <label className="cursor-pointer rounded-xl border border-[#1f5e3b]/20 px-4 py-2 text-sm font-semibold text-[#1f5e3b]">
                    Upload Photo
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { void uploadPhoto(viewProfile.id, f); setViewProfile(null) }; e.currentTarget.value = '' }} />
                  </label>
                )}
                <button type="button" onClick={() => setViewProfile(null)} className="rounded-xl border border-[#1f5e3b]/15 px-4 py-2 text-sm text-[#546e7a]">Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          CHANGE SHIFT MODAL
      ══════════════════════════════════════════════════════════════ */}
      {(shiftTarget || bulkMode) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" onClick={(e) => { if (e.target === e.currentTarget) { setShiftTarget(null); setBulkMode(false) } }}>
          <form onSubmit={(e) => void saveShift(e)} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-[#1f5e3b]">
              {bulkMode ? 'Bulk Shift Change' : `Shift — ${shiftTarget?.name}`}
            </h3>
            {!bulkMode && shiftTarget && (
              <p className="mt-0.5 font-mono text-xs text-[#78909c]">{shiftTarget.login_id || `#${shiftTarget.id}`} · {branchLabel(shiftTarget)}</p>
            )}

            {/* Quick presets */}
            <div className="mt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/60">Quick Presets</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Jaipur (9:00–18:00)', start: '09:00', end: '18:00' },
                  { label: 'Amritsar (8:30–17:30)', start: '08:30', end: '17:30' },
                  { label: 'Meerut (9:00–17:00)', start: '09:00', end: '17:00' },
                  { label: 'Morning (8:00–16:00)', start: '08:00', end: '16:00' },
                  { label: 'Evening (12:00–21:00)', start: '12:00', end: '21:00' },
                ].map((p) => (
                  <button key={p.label} type="button" onClick={() => { setShiftStart(p.start); setShiftEnd(p.end) }}
                    className={`rounded-lg border px-2.5 py-1 text-xs font-semibold transition ${shiftStart === p.start && shiftEnd === p.end ? 'border-[#1f5e3b] bg-[#e8f5e9] text-[#1f5e3b]' : 'border-[#1f5e3b]/20 text-[#546e7a] hover:bg-[#f7fbf8]'}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Time inputs */}
            <div className="mt-4 grid grid-cols-3 gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-[#78909c]">In Time</span>
                <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} required className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/25" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-[#78909c]">Out Time</span>
                <input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} required className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/25" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-xs font-medium text-[#78909c]">Grace (min)</span>
                <input type="number" min={0} max={120} value={shiftGrace} onChange={(e) => setShiftGrace(Number(e.target.value))} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/25" />
              </label>
            </div>

            {/* Bulk employee selection */}
            {bulkMode && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/60">
                  Select Employees ({bulkIds.size} selected)
                </p>
                <div className="flex gap-2 mb-2">
                  <button type="button" onClick={() => setBulkIds(new Set(filteredList.map((e) => e.id)))} className="text-xs text-[#1f5e3b] underline">Select all</button>
                  <button type="button" onClick={() => setBulkIds(new Set())} className="text-xs text-red-500 underline">Clear</button>
                </div>
                <div className="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-[#1f5e3b]/10 p-2">
                  {list.filter((e) => e.active !== 0).map((emp) => (
                    <label key={emp.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#f7fbf8]">
                      <input type="checkbox" checked={bulkIds.has(emp.id)} onChange={() => toggleBulkId(emp.id)} className="accent-[#1f5e3b]" />
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#e8f5e9] text-xs font-bold text-[#1f5e3b]">
                        {emp.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-[#263238]">{emp.name}</p>
                        <p className="text-[10px] text-[#90a4ae]">{emp.login_id || `#${emp.id}`} · {branchLabel(emp)}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {shiftMsg && <p className="mt-3 text-sm font-semibold text-emerald-700">✓ {shiftMsg}</p>}

            <div className="mt-5 flex gap-3">
              <button type="submit" disabled={shiftSaving} className="rounded-xl bg-[#1f5e3b] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {shiftSaving ? 'Saving…' : 'Save Shift'}
              </button>
              <button type="button" onClick={() => { setShiftTarget(null); setBulkMode(false) }} className="rounded-xl border border-[#1f5e3b]/15 px-4 py-2 text-sm">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          EDIT EMPLOYEE MODAL
      ══════════════════════════════════════════════════════════════ */}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" onClick={(e) => { if (e.target === e.currentTarget) setEdit(null) }}>
          <form onSubmit={saveEdit} className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-[#1f5e3b]">Edit Employee</h3>

            {/* ── Section 1: Basic Info ── */}
            <p className="mt-4 text-[10px] font-bold uppercase tracking-widest text-[#1f5e3b]/50">Basic Info</p>
            <label className="mt-2 block text-sm">
              <span className="mb-1 block font-medium">Full Name</span>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
            </label>
            <div className="mt-3">
              <span className="mb-1 block text-sm font-medium">Employee ID</span>
              <div className="flex items-center gap-2 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] px-3 py-2 text-sm">
                <span className="font-mono font-semibold text-[#1f5e3b]">{editEmployeeId || `#${edit?.id}`}</span>
                <span className="ml-auto text-[10px] text-[#90a4ae]">Auto-generated · not editable</span>
              </div>
            </div>
            {/* ── Section 2: Job Details ── */}
            <p className="mt-5 text-[10px] font-bold uppercase tracking-widest text-[#1f5e3b]/50">Job Details</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Role</span>
                {/* If current user can't assign target's current role (e.g. ADMIN editing ADMIN), show read-only */}
                {getAllowedRbacRoles(user?.role).some((r) => r.value === editRole) ? (
                  <select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm">
                    {getAllowedRbacRoles(user?.role).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] px-3 py-2 text-sm">
                    <span className="font-semibold text-[#1f5e3b]">
                      {RBAC_ROLE_OPTIONS.find((r) => r.value === editRole)?.label || editRole}
                    </span>
                    <span className="ml-auto text-[10px] text-[#90a4ae]">Role locked</span>
                  </div>
                )}
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Branch</span>
                <select value={editBranch} onChange={(e) => setEditBranch(e.target.value === '' ? '' : Number(e.target.value))} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm">
                  <option value="">—</option>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            </div>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block font-medium">Mobile</span>
              <input value={editMobile} onChange={(e) => setEditMobile(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
            </label>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block font-medium">Department</span>
              <input list="dept-options-edit" value={editDepartment} onChange={(e) => setEditDepartment(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              <datalist id="dept-options-edit">{departmentNames.map((d) => <option key={d} value={d} />)}</datalist>
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">DOB</span>
                <input type="date" value={editDob} onChange={(e) => setEditDob(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Joining Date</span>
                <input type="date" value={editJoiningDate} onChange={(e) => setEditJoiningDate(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
            </div>
            <label className="mt-3 block text-sm">
              <span className="mb-1 block font-medium">Address</span>
              <input value={editAddress} onChange={(e) => setEditAddress(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Account</span>
                <input value={editAccountNumber} onChange={(e) => setEditAccountNumber(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">IFSC</span>
                <input value={editIfsc} onChange={(e) => setEditIfsc(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Bank</span>
                <input value={editBankName} onChange={(e) => setEditBankName(e.target.value)} className="w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm" />
              </label>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} className="accent-[#1f5e3b]" />
              Active
            </label>

            <div className="mt-4 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/70">Attendance Methods</p>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { label: 'Face', icon: '📷', val: editAllowFace, set: setEditAllowFace },
                  { label: 'Fingerprint', icon: '👆', val: editAllowFingerprint, set: setEditAllowFingerprint },
                  { label: 'GPS', icon: '📍', val: editAllowGps, set: setEditAllowGps },
                  { label: 'Manual', icon: '✍️', val: editAllowManual, set: setEditAllowManual },
                ] as { label: string; icon: string; val: boolean; set: (v: boolean) => void }[]).map(({ label, icon, val, set }) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => set(!val)}
                    className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${
                      val
                        ? 'border-[#1f5e3b]/30 bg-[#1f5e3b] text-white'
                        : 'border-[#1f5e3b]/15 bg-white text-[#546e7a] opacity-60'
                    }`}
                  >
                    <span>{icon} {label}</span>
                    <span className="text-xs">{val ? 'ON' : 'OFF'}</span>
                  </button>
                ))}
              </div>
            </div>

            {(user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN') && (
              <div className="mt-4 rounded-xl border border-[#1f5e3b]/10 bg-[#f7fbf8] p-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/70">Security</p>

                {/* Lock / Unlock status + buttons */}
                <div className="flex items-center justify-between rounded-xl border border-[#1f5e3b]/10 bg-white px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${editActive ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    <span className="text-sm font-semibold">{editActive ? 'Active' : 'Locked'}</span>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void unlockUser(edit.id)} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">Unlock</button>
                    <button type="button" onClick={() => void lockUser(edit.id)} className="rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-xs font-semibold text-red-600">Lock</button>
                  </div>
                </div>

                {/* Password Reset Button */}
                <button
                  type="button"
                  onClick={() => openPwResetModal({ id: edit.id, name: edit.full_name, login_id: edit.login_id })}
                  className="w-full rounded-xl border border-orange-200 bg-orange-50 py-2 text-sm font-semibold text-orange-700 hover:bg-orange-100"
                >
                  🔑 Password Reset / Set करें
                </button>
                <p className="text-[10px] text-[#90a4ae] leading-relaxed">
                  Custom password set करें या random generate करें — फिर staff को share करें।
                </p>

                {/* Set new password via Save (Super Admin only - alternative inline method) */}
                {isSuperAdmin && (
                  <div className="space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[#1f5e3b]/60">OR: Save के साथ Password बदलें</p>
                    <div className="flex items-center gap-1.5">
                      <input
                        type={showEditPassword ? 'text' : 'password'}
                        value={editPassword}
                        onChange={(e) => setEditPassword(e.target.value)}
                        placeholder="Leave blank to keep current"
                        className="flex-1 rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1f5e3b]/25"
                      />
                      <button
                        type="button"
                        onClick={() => setShowEditPassword((v) => !v)}
                        className="shrink-0 rounded-lg border border-[#1f5e3b]/20 bg-white px-2.5 py-2 text-xs font-semibold text-[#1f5e3b] hover:bg-[#f0f9f2]"
                      >
                        {showEditPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <p className="text-[10px] text-[#90a4ae]">Will be applied when you click Save above.</p>
                  </div>
                )}

                {/* Security message + copy button */}
                {securityMsg && (
                  <div className="flex items-center gap-2 rounded-lg border border-[#1f5e3b]/15 bg-white px-3 py-2">
                    <span className="flex-1 text-xs font-mono text-[#1f5e3b] break-all">{securityMsg}</span>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(securityMsg).then(() => setSecurityMsg(securityMsg + ' ✓ Copied!'))}
                      className="shrink-0 rounded-lg border border-[#1f5e3b]/20 px-2.5 py-1 text-[10px] font-semibold text-[#1f5e3b]"
                    >
                      Copy
                    </button>
                  </div>
                )}
              </div>
            )}

            {editSaveMsg && (
              <div className={`mt-4 rounded-xl px-4 py-3 text-sm font-medium ${editSaveMsg.startsWith('✅') ? 'border border-emerald-200 bg-emerald-50 text-emerald-800' : 'border border-red-200 bg-red-50 text-red-700'}`}>
                {editSaveMsg}
              </div>
            )}
            <div className="mt-4 flex gap-3">
              <button type="submit" disabled={editSaving} className="rounded-xl bg-[#1f5e3b] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {editSaving ? '⏳ Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => setEdit(null)} className="rounded-xl border border-[#1f5e3b]/15 px-4 py-2 text-sm">Cancel</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
