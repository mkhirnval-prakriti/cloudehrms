import { createContext, useCallback, useContext, useEffect, useState } from 'react'

export type ToastKind = 'success' | 'error' | 'info' | 'warning'
export type Toast = {
  id: number
  kind: ToastKind
  title: string
  reason?: string
  solution?: string
  ttl?: number
}

type Ctx = {
  push: (t: Omit<Toast, 'id'>) => void
  pushApiError: (e: unknown, fallback?: string) => void
  pushSuccess: (title: string, body?: string) => void
}

const ToastContext = createContext<Ctx | null>(null)
let nextId = 1

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const remove = useCallback((id: number) => {
    setToasts((arr) => arr.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = nextId++
    const ttl = t.ttl ?? (t.kind === 'error' ? 9000 : 4500)
    setToasts((arr) => [...arr, { ...t, id }])
    window.setTimeout(() => remove(id), ttl)
  }, [remove])

  const pushApiError = useCallback((e: unknown, fallback?: string) => {
    const err = e as { message?: string; reason?: string; solution?: string; code?: string; status?: number }
    push({
      kind: 'error',
      title: err?.message || fallback || 'Kuch galat ho gaya',
      reason: err?.reason,
      solution: err?.solution || (err?.status === 0 || /network|fetch/i.test(err?.message || '') ? 'Internet connection check karo aur retry karo.' : ''),
    })
  }, [push])

  const pushSuccess = useCallback((title: string, body?: string) => {
    push({ kind: 'success', title, reason: body })
  }, [push])

  // Expose globally for non-React error sites (api.ts).
  useEffect(() => {
    ;(window as unknown as { __toast?: Ctx }).__toast = { push, pushApiError, pushSuccess }
  }, [push, pushApiError, pushSuccess])

  return (
    <ToastContext.Provider value={{ push, pushApiError, pushSuccess }}>
      {children}
      <div className="fixed top-4 right-4 z-[9999] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => {
          const tone = t.kind === 'error'
            ? 'border-red-300 bg-red-50 text-red-900'
            : t.kind === 'success' ? 'border-green-300 bg-green-50 text-green-900'
            : t.kind === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900'
            : 'border-blue-300 bg-blue-50 text-blue-900'
          const icon = t.kind === 'error' ? '❌' : t.kind === 'success' ? '✅' : t.kind === 'warning' ? '⚠️' : '🔔'
          return (
            <div key={t.id} className={`rounded-xl border ${tone} p-3 text-sm shadow-lg`}
              role="alert">
              <div className="flex items-start gap-2">
                <span className="text-lg leading-none">{icon}</span>
                <div className="flex-1">
                  <p className="font-semibold">{t.title}</p>
                  {t.reason && <p className="mt-1 text-xs opacity-90">📌 {t.reason}</p>}
                  {t.solution && <p className="mt-1 text-xs opacity-90">✅ {t.solution}</p>}
                </div>
                <button onClick={() => remove(t.id)} className="text-lg leading-none opacity-70 hover:opacity-100">×</button>
              </div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

/** Helper for non-React modules. Safe no-op if provider not mounted yet. */
export function toast(opts: Omit<Toast, 'id'>) {
  const g = (window as unknown as { __toast?: Ctx }).__toast
  if (g) g.push(opts)
}
