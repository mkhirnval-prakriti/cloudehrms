import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { api, getToken, setToken as persistToken } from '../api'
import { closeRealtime } from '../realtime'

export type AuthUser = {
  id: number
  email: string
  login_id: string | null
  full_name: string
  role: string
  branch_id: number | null
  shift_start?: string
  shift_end?: string
  permissions?: Record<string, boolean>
}

type AuthContextValue = {
  user: AuthUser | null
  /** True only while validating an existing JWT (cold start with token in storage). */
  initializing: boolean
  completeLogin: (data: LoginSuccessPayload) => void
  refreshUser: () => Promise<void>
  clearSession: () => void
}

type LoginSuccessPayload = {
  token: string
  id: number
  email: string
  login_id?: string | null
  full_name: string
  role: string
  branch_id?: number | null
  shift_start?: string
  shift_end?: string
  permissions?: Record<string, boolean>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function mapLoginToUser(data: LoginSuccessPayload): AuthUser {
  return {
    id: data.id,
    email: data.email,
    login_id: data.login_id ?? null,
    full_name: data.full_name,
    role: data.role,
    branch_id: data.branch_id ?? null,
    shift_start: data.shift_start,
    shift_end: data.shift_end,
    permissions: data.permissions,
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [initializing, setInitializing] = useState(() => !!getToken())

  useEffect(() => {
    const token = getToken()
    if (!token) {
      setUser(null)
      setInitializing(false)
      return
    }

    let cancelled = false
    api<AuthUser & { permissions?: Record<string, boolean> }>('/auth/me')
      .then((me) => {
        if (!cancelled) {
          setUser(me)
          setInitializing(false)
        }
      })
      .catch((err) => {
        // Only clear token on real auth failure (401/403). Network blips and
        // server restarts (5xx / no response) must NOT log the user out —
        // the JWT is still valid and a retry will succeed.
        const status = (err as { status?: number })?.status
        if (status === 401 || status === 403) {
          persistToken(null)
          if (!cancelled) {
            setUser(null)
            setInitializing(false)
          }
        } else {
          if (!cancelled) {
            setInitializing(false)
          }
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const completeLogin = useCallback((data: LoginSuccessPayload) => {
    if (!data.token) return
    persistToken(data.token)
    setUser(mapLoginToUser(data))
    setInitializing(false)
  }, [])

  const refreshUser = useCallback(async () => {
    const token = getToken()
    if (!token) {
      setUser(null)
      setInitializing(false)
      return
    }
    // Note: do NOT flip `initializing` to true here. This runs in background
    // (e.g. RequireAuth self-heal loop), and toggling initializing causes the
    // full-page LogoLoader to flash on every retry — perceived as buffering.
    try {
      const me = await api<AuthUser & { permissions?: Record<string, boolean> }>('/auth/me')
      setUser(me)
    } catch (err) {
      const status = (err as { status?: number })?.status
      if (status === 401 || status === 403) {
        persistToken(null)
        setUser(null)
      }
    }
  }, [])

  const clearSession = useCallback(() => {
    closeRealtime()
    persistToken(null)
    setUser(null)
    setInitializing(false)
  }, [])

  const value = useMemo(
    () => ({
      user,
      initializing,
      completeLogin,
      refreshUser,
      clearSession,
    }),
    [user, initializing, completeLogin, refreshUser, clearSession]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** Co-located hook + provider (standard React context pattern). */
// eslint-disable-next-line react-refresh/only-export-components -- useAuth must live next to AuthProvider
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
