import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'

type RoleMap = Record<string, boolean>
type VisibilityMap = Record<string, RoleMap>

const DEFAULTS: VisibilityMap = {
  SUPER_ADMIN: {
    'dashboard.company_stats': true,
    'dashboard.today_attendance': true,
    'dashboard.employee_highlights': true,
    'dashboard.staff_by_branch': true,
    'dashboard.payroll': true,
    'dashboard.live_status': true,
    'dashboard.smart_alerts': true,
    'dashboard.pending_leaves': true,
    'nav.employees': true,
    'nav.reports': true,
    'nav.attendance': true,
    'nav.branches': true,
    'nav.payroll': true,
    'nav.kiosk': true,
  },
  ADMIN: {
    'dashboard.company_stats': true,
    'dashboard.today_attendance': true,
    'dashboard.employee_highlights': true,
    'dashboard.staff_by_branch': true,
    'dashboard.payroll': true,
    'dashboard.live_status': true,
    'dashboard.smart_alerts': true,
    'dashboard.pending_leaves': true,
    'nav.employees': true,
    'nav.reports': true,
    'nav.attendance': true,
    'nav.branches': true,
    'nav.payroll': true,
    'nav.kiosk': true,
  },
  ATTENDANCE_MANAGER: {
    'dashboard.company_stats': false,
    'dashboard.today_attendance': true,
    'dashboard.employee_highlights': true,
    'dashboard.staff_by_branch': true,
    'dashboard.payroll': false,
    'dashboard.live_status': true,
    'dashboard.smart_alerts': false,
    'dashboard.pending_leaves': true,
    'nav.employees': false,
    'nav.reports': true,
    'nav.attendance': true,
    'nav.branches': false,
    'nav.payroll': false,
    'nav.kiosk': true,
  },
  LOCATION_MANAGER: {
    'dashboard.company_stats': false,
    'dashboard.today_attendance': true,
    'dashboard.employee_highlights': false,
    'dashboard.staff_by_branch': true,
    'dashboard.payroll': false,
    'dashboard.live_status': true,
    'dashboard.smart_alerts': false,
    'dashboard.pending_leaves': false,
    'nav.employees': false,
    'nav.reports': false,
    'nav.attendance': true,
    'nav.branches': true,
    'nav.payroll': false,
    'nav.kiosk': true,
  },
  USER: {
    'dashboard.company_stats': false,
    'dashboard.today_attendance': true,
    'dashboard.employee_highlights': false,
    'dashboard.staff_by_branch': false,
    'dashboard.payroll': false,
    'dashboard.live_status': false,
    'dashboard.smart_alerts': false,
    'dashboard.pending_leaves': false,
    'nav.employees': false,
    'nav.reports': false,
    'nav.attendance': true,
    'nav.branches': false,
    'nav.payroll': true,
    'nav.kiosk': false,
  },
}

export const MODULE_LABELS: Record<string, string> = {
  'dashboard.today_attendance': "Today's Attendance Stats",
  'dashboard.company_stats': 'Company / Workforce Stats',
  'dashboard.live_status': 'Currently In Office',
  'dashboard.pending_leaves': 'Pending Leave Requests',
  'dashboard.smart_alerts': 'Smart Alerts & Warnings',
  'dashboard.employee_highlights': 'Employee Highlights',
  'dashboard.staff_by_branch': 'Staff by Branch',
  'dashboard.payroll': 'Payroll Preview',
  'nav.attendance': 'Employee Dashboard (Attendance)',
  'nav.employees': 'Employee Management (Staff Mgmt)',
  'nav.reports': 'Reports',
  'nav.branches': 'Branch Location',
  'nav.payroll': 'Payroll Page',
  'nav.kiosk': 'Kiosk Mode',
}

export const MODULE_GROUPS = {
  'Dashboard Widgets': [
    'dashboard.today_attendance',
    'dashboard.company_stats',
    'dashboard.live_status',
    'dashboard.pending_leaves',
    'dashboard.smart_alerts',
    'dashboard.employee_highlights',
    'dashboard.staff_by_branch',
    'dashboard.payroll',
  ],
  'Navigation Items': [
    'nav.attendance',
    'nav.employees',
    'nav.reports',
    'nav.branches',
    'nav.payroll',
    'nav.kiosk',
  ],
}

export const ALL_MODULES = Object.values(MODULE_GROUPS).flat()

export const CONFIGURABLE_ROLES = ['USER', 'ATTENDANCE_MANAGER', 'LOCATION_MANAGER', 'ADMIN'] as const

export type BranchAccessRules = Record<string, Record<number, boolean>>

export function useModuleVisibility() {
  const { user } = useAuth()

  const { data, refetch } = useQuery({
    queryKey: ['module-visibility'],
    queryFn: () => api<VisibilityMap>('/settings/module-visibility'),
    staleTime: 30000,
    refetchInterval: 60000,
  })

  function canSee(module: string): boolean {
    if (!user) return false
    const role = user.role
    const roleDefaults = DEFAULTS[role] ?? DEFAULTS.USER
    const serverOverrides: RoleMap = data?.[role] ?? {}
    const merged = { ...roleDefaults, ...serverOverrides }
    return merged[module] ?? false
  }

  return { canSee, raw: data, refetch }
}

export function useBranchAccess() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<{ branches: { id: number; name: string }[]; rules: BranchAccessRules }>({
    queryKey: ['branch-access'],
    queryFn: () => api('/settings/branch-access'),
    staleTime: 60000,
  })

  async function saveBranchAccess(rules: BranchAccessRules) {
    await api('/settings/branch-access', { method: 'POST', body: JSON.stringify(rules) })
    await qc.invalidateQueries({ queryKey: ['branch-access'] })
  }

  return { branches: data?.branches ?? [], rules: data?.rules ?? {}, isLoading, saveBranchAccess }
}
