import { Suspense, lazy, useEffect } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from './components/Layout'
import { LogoLoader } from './components/LogoLoader'
import { Login } from './pages/Login'
import { Register } from './pages/Register'
import { ForgotPassword } from './pages/ForgotPassword'
import { PageSkeleton } from './components/PageSkeleton'
import { ToastProvider } from './components/ToastHost'
import { useAuth } from './context/AuthContext'
import { getToken } from './api'

const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
const AttendancePage = lazy(() => import('./pages/AttendancePage').then((m) => ({ default: m.AttendancePage })))
const EmployeesPage = lazy(() => import('./pages/EmployeesPage').then((m) => ({ default: m.EmployeesPage })))
const LeavesPage = lazy(() => import('./pages/LeavesPage').then((m) => ({ default: m.LeavesPage })))
const PayrollPage = lazy(() => import('./pages/PayrollPage').then((m) => ({ default: m.PayrollPage })))
const DocumentsPage = lazy(() => import('./pages/DocumentsPage').then((m) => ({ default: m.DocumentsPage })))
const NoticesPage = lazy(() => import('./pages/NoticesPage').then((m) => ({ default: m.NoticesPage })))
const OfficePage = lazy(() => import('./pages/OfficePage').then((m) => ({ default: m.OfficePage })))
const CompanyPage = lazy(() => import('./pages/CompanyPage').then((m) => ({ default: m.CompanyPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const GuidePage = lazy(() => import('./pages/GuidePage').then((m) => ({ default: m.GuidePage })))
const KioskPage = lazy(() => import('./pages/KioskPage').then((m) => ({ default: m.KioskPage })))
const TrashPage = lazy(() => import('./pages/TrashPage').then((m) => ({ default: m.TrashPage })))
const MonitorPage = lazy(() => import('./pages/MonitorPage').then((m) => ({ default: m.MonitorPage })))
const QrScanPage = lazy(() => import('./pages/QrScanPage').then((m) => ({ default: m.QrScanPage })))
const IdentityEnrollmentPage = lazy(() =>
  import('./pages/IdentityEnrollmentPage').then((m) => ({ default: m.IdentityEnrollmentPage }))
)
const BiometricAdminPage = lazy(() =>
  import('./pages/BiometricAdminPage').then((m) => ({ default: m.BiometricAdminPage }))
)
const PendingRegistrationsPage = lazy(() =>
  import('./pages/PendingRegistrationsPage').then((m) => ({ default: m.PendingRegistrationsPage }))
)

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, initializing, refreshUser } = useAuth()
  const hasToken = !!getToken()

  // If a token exists but user resolution failed transiently (network/5xx blip
  // during cold start), retry /auth/me on a backoff instead of bouncing the
  // user to /login. The api() helper itself retries once; we add a longer
  // self-heal loop so the session recovers automatically when the server
  // comes back.
  useEffect(() => {
    if (initializing || user || !hasToken) return
    let attempt = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      attempt += 1
      const delay = Math.min(30000, 2000 * attempt)
      window.setTimeout(() => {
        if (cancelled) return
        void refreshUser().then(() => {
          if (!cancelled && !getToken()) cancelled = true
        }).finally(() => {
          if (!cancelled && !user) tick()
        })
      }, delay)
    }
    tick()
    return () => { cancelled = true }
  }, [initializing, user, hasToken, refreshUser])

  if (initializing) {
    return <LogoLoader />
  }
  if (!user) {
    // Token still in storage → likely transient; show loader instead of
    // forcing a re-login. If token was actually cleared (real 401/403),
    // redirect to /login as before.
    if (hasToken) return <LogoLoader />
    return <Navigate to="/login" replace />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <ToastProvider>
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/login/forgot" element={<ForgotPassword />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route
            index
            element={
              <Suspense fallback={<PageSkeleton />}>
                <Dashboard />
              </Suspense>
            }
          />
          <Route
            path="attendance"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <AttendancePage />
              </Suspense>
            }
          />
          <Route
            path="identity"
            element={
              <Suspense fallback={<PageSkeleton rows={5} />}>
                <IdentityEnrollmentPage />
              </Suspense>
            }
          />
          <Route
            path="biometric-requests"
            element={
              <Suspense fallback={<PageSkeleton rows={5} />}>
                <BiometricAdminPage />
              </Suspense>
            }
          />
          <Route
            path="employees"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <EmployeesPage />
              </Suspense>
            }
          />
          <Route
            path="employees/:id"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <EmployeesPage />
              </Suspense>
            }
          />
          <Route
            path="documents"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <DocumentsPage />
              </Suspense>
            }
          />
          <Route
            path="leaves"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <LeavesPage />
              </Suspense>
            }
          />
          <Route
            path="payroll"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <PayrollPage />
              </Suspense>
            }
          />
          <Route path="staff-mgmt" element={<Navigate to="/employees" replace />} />
          <Route
            path="pending-registrations"
            element={
              <Suspense fallback={<PageSkeleton rows={4} />}>
                <PendingRegistrationsPage />
              </Suspense>
            }
          />
          <Route
            path="kiosk"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <KioskPage />
              </Suspense>
            }
          />
          <Route
            path="qr-scan"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <QrScanPage />
              </Suspense>
            }
          />
          <Route
            path="trash"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <TrashPage />
              </Suspense>
            }
          />
          <Route
            path="office"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <OfficePage />
              </Suspense>
            }
          />
          <Route
            path="company"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <SettingsPage />
              </Suspense>
            }
          />
          <Route
            path="settings"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <SettingsPage />
              </Suspense>
            }
          />
          <Route
            path="company-legacy"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <CompanyPage />
              </Suspense>
            }
          />
          <Route
            path="notices"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <NoticesPage />
              </Suspense>
            }
          />
          <Route
            path="guide"
            element={
              <Suspense fallback={<PageSkeleton />}>
                <GuidePage />
              </Suspense>
            }
          />
          <Route
            path="monitor"
            element={
              <Suspense fallback={<PageSkeleton rows={6} />}>
                <MonitorPage />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
    </ToastProvider>
  )
}
