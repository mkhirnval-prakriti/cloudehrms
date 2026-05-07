import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api } from '../api'
import { LogoLoader } from '../components/LogoLoader'
import { useAuth } from '../context/AuthContext'

export function Register() {
  const { user, initializing } = useAuth()
  const base = import.meta.env.BASE_URL

  const [fullName, setFullName] = useState('')
  const [mobile, setMobile] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [shiftStart, setShiftStart] = useState('')
  const [shiftEnd, setShiftEnd] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [err, setErr] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  if (initializing) return <LogoLoader />
  if (user) return <Navigate to="/" replace />
  if (success) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-[#f5f7f6] via-white to-[#e8f0eb] px-4 py-10">
        <div className="relative w-full max-w-[440px]">
          <div className="rounded-3xl border border-white/70 bg-white/85 p-8 shadow-[0_24px_64px_rgba(31,94,59,0.12)] backdrop-blur-md text-center">
            <div className="mb-5 flex justify-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e8f5e9]">
                <svg className="h-8 w-8 text-[#2e7d32]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <h2 className="font-display mb-2 text-xl font-bold text-[#1f5e3b]">Registration Submitted!</h2>
            <p className="mb-6 text-sm leading-relaxed text-[#14261a]/80">{success}</p>
            <Link
              to="/login"
              className="inline-block w-full rounded-xl bg-gradient-to-r from-[#1f5e3b] via-[#2a6d47] to-[#1f5e3b] py-3 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(31,94,59,0.3)] transition hover:brightness-[1.03]"
            >
              Back to Login
            </Link>
          </div>
        </div>
      </div>
    )
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    if (password !== confirmPassword) {
      setErr('Passwords do not match')
      return
    }
    if (password.length < 6) {
      setErr('Password must be at least 6 characters')
      return
    }
    if (!shiftStart) {
      setErr('Shift start time is required')
      return
    }
    if (!shiftEnd) {
      setErr('Shift end time is required')
      return
    }
    setLoading(true)
    try {
      const data = await api<{ message: string }>('/register', {
        method: 'POST',
        body: JSON.stringify({
          full_name: fullName.trim(),
          mobile: mobile.trim(),
          password,
          shift_start: shiftStart,
          shift_end: shiftEnd,
          email: email.trim() || undefined,
          address: address.trim() || undefined,
        }),
      })
      setSuccess(data.message || 'आपका अकाउंट बन गया है, approval के लिए भेज दिया गया है।')
    } catch (e) {
      setErr((e as Error).message || 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-[#f5f7f6] via-white to-[#e8f0eb] px-4 py-10">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage: `radial-gradient(circle at 20% 20%, rgba(102, 187, 106, 0.2) 0%, transparent 45%),
            radial-gradient(circle at 80% 80%, rgba(31, 94, 59, 0.08) 0%, transparent 40%)`,
        }}
      />
      <div className="relative w-full max-w-[440px]">
        <div className="rounded-3xl border border-white/70 bg-white/85 p-8 shadow-[0_24px_64px_rgba(31,94,59,0.12)] backdrop-blur-md md:p-10">
          <div className="mb-6 flex flex-col items-center gap-2">
            <img
              src={`${base}logo.png`}
              alt="Prakriti Herbs"
              className="h-[72px] w-auto max-w-[180px] object-contain"
              width={180}
              height={72}
            />
            <p className="font-display text-center text-lg font-semibold tracking-tight text-[#1f5e3b]">
              Create Account
            </p>
            <p className="text-center text-xs text-[#1f5e3b]/60">
              Your Employee ID will be assigned after admin approval
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label htmlFor="reg-name" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/90">
                Full Name <span className="text-red-500">*</span>
              </label>
              <input
                id="reg-name"
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Your full name"
                required
                autoComplete="name"
              />
            </div>

            <div>
              <label htmlFor="reg-mobile" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/90">
                Mobile Number <span className="text-red-500">*</span>
              </label>
              <input
                id="reg-mobile"
                type="tel"
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="10-digit mobile number"
                inputMode="tel"
                required
                autoComplete="tel"
              />
            </div>

            <div>
              <label htmlFor="reg-pass" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/90">
                Password <span className="text-red-500">*</span>
              </label>
              <input
                id="reg-pass"
                type="password"
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                required
                autoComplete="new-password"
              />
            </div>

            <div>
              <label htmlFor="reg-pass2" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/90">
                Confirm Password <span className="text-red-500">*</span>
              </label>
              <input
                id="reg-pass2"
                type="password"
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                required
                autoComplete="new-password"
              />
            </div>

            {/* Working Hours — mandatory */}
            <div className="rounded-2xl border border-[#1f5e3b]/12 bg-[#f5fbf7] px-4 py-4 space-y-3">
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#1f5e3b]/70">
                Working Hours <span className="text-red-500">*</span>
              </p>
              <p className="text-[11px] text-[#1f5e3b]/55 -mt-1">
                अपनी shift का समय भरें। Admin बाद में बदल सकते हैं।
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="reg-shift-start" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/80">
                    Shift Start <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="reg-shift-start"
                    type="time"
                    className="w-full rounded-xl border border-[#1f5e3b]/15 bg-white px-3 py-2.5 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                    value={shiftStart}
                    onChange={(e) => setShiftStart(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="reg-shift-end" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/80">
                    Shift End <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="reg-shift-end"
                    type="time"
                    className="w-full rounded-xl border border-[#1f5e3b]/15 bg-white px-3 py-2.5 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                    value={shiftEnd}
                    onChange={(e) => setShiftEnd(e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>

            <details className="group">
              <summary className="cursor-pointer list-none text-xs font-medium text-[#1f5e3b]/70 hover:text-[#1f5e3b] select-none">
                <span className="group-open:hidden">+ Add optional details</span>
                <span className="hidden group-open:inline">- Optional details</span>
              </summary>
              <div className="mt-3 space-y-3">
                <div>
                  <label htmlFor="reg-email" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/90">
                    Email (optional)
                  </label>
                  <input
                    id="reg-email"
                    type="email"
                    className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    autoComplete="email"
                  />
                </div>
                <div>
                  <label htmlFor="reg-addr" className="mb-1.5 block text-xs font-semibold tracking-wide text-[#1f5e3b]/90">
                    Address (optional)
                  </label>
                  <textarea
                    id="reg-addr"
                    rows={2}
                    className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm text-[#14261a] shadow-inner shadow-black/5 outline-none transition focus:border-[#66bb6a]/50 focus:ring-4 focus:ring-[#1f5e3b]/10"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Your residential address"
                  />
                </div>
              </div>
            </details>

            {err && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {err}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-xl bg-gradient-to-r from-[#1f5e3b] via-[#2a6d47] to-[#1f5e3b] py-3.5 text-sm font-semibold tracking-wide text-white shadow-[0_8px_24px_rgba(31,94,59,0.35)] transition hover:brightness-[1.03] active:scale-[0.99] disabled:opacity-70"
            >
              {loading ? 'Submitting…' : 'Create Account'}
            </button>

            <p className="text-center text-xs text-[#1f5e3b]/65">
              Already have an account?{' '}
              <Link to="/login" className="font-semibold text-[#2e7d32] underline">
                Sign in
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  )
}
