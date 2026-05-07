const JWT_KEY = 'ph_jwt'

/** Base URL for API (no trailing slash). Empty = same origin as the SPA. */
export function apiBaseUrl(): string {
  const raw = import.meta.env.VITE_API_BASE_URL
  if (typeof raw === 'string' && raw.trim()) return raw.replace(/\/$/, '')
  return ''
}

/** Full URL for `/api/...` requests (works with dev proxy and production same-origin). */
export function apiFetchUrl(apiPath: string): string {
  const p = apiPath.startsWith('/') ? apiPath : `/${apiPath}`
  return `${apiBaseUrl()}/api${p}`
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(JWT_KEY)
  } catch {
    return null
  }
}

export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(JWT_KEY, t)
    else localStorage.removeItem(JWT_KEY)
  } catch {
    /* ignore */
  }
}

function buildHeaders(options: RequestInit): Record<string, string> {
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData
  const token = getToken()
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  }
  if (!isForm && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
  _attempt = 0
): Promise<T> {
  const headers = buildHeaders(options)
  let res: Response
  try {
    res = await fetch(apiFetchUrl(path), {
      credentials: 'include',
      headers,
      ...options,
    })
  } catch (networkErr) {
    // Network failure — retry once after 1.5s
    if (_attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500))
      return api(path, options, 1)
    }
    throw networkErr
  }

  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text }
  }

  // Retry once on 5xx server errors (not on 4xx — those are client errors)
  if (res.status >= 500 && _attempt === 0) {
    await new Promise((r) => setTimeout(r, 1500))
    return api(path, options, 1)
  }

  if (!res.ok) {
    const body = (data || {}) as { error?: string; reason?: string; solution?: string; code?: string }
    const err = new Error(body.error || res.statusText) as Error & {
      status?: number; reason?: string; solution?: string; code?: string
    }
    err.status = res.status
    err.reason = body.reason
    err.solution = body.solution
    err.code = body.code
    throw err
  }
  return data as T
}
