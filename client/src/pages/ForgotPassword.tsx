import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

type Step = 1 | 2 | 3

export function ForgotPassword() {
  const nav = useNavigate()
  const base = import.meta.env.BASE_URL
  const [step, setStep] = useState<Step>(1)
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [resetToken, setResetToken] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    setBusy(true)
    try {
      await api('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      })
      setMsg('If an account exists, a 6-digit OTP was sent to the registered email.')
      setStep(2)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    setMsg('')
    setBusy(true)
    try {
      const d = await api<{ reset_token?: string }>('/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
      })
      if (d.reset_token) {
        setResetToken(d.reset_token)
        setStep(3)
        setMsg('OTP verified. Set your new password.')
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    if (pass.length < 6 || pass !== pass2) {
      setErr('Password must be at least 6 characters and match confirmation.')
      return
    }
    setBusy(true)
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token: resetToken, new_password: pass }),
      })
      setMsg('Password updated. Redirecting to sign in…')
      window.setTimeout(() => nav('/login', { replace: true }), 1200)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-[#f5f7f6] via-white to-[#e8f0eb] px-4 py-10">
      <div className="relative w-full max-w-[420px]">
        <div className="rounded-3xl border border-white/70 bg-white/85 p-8 shadow-[0_24px_64px_rgba(31,94,59,0.12)] backdrop-blur-md md:p-10">
          <div className="mb-6 flex flex-col items-center gap-2">
            <img
              src={`${base}logo.png`}
              alt=""
              className="h-[72px] w-auto max-w-[200px] object-contain"
              width={200}
              height={72}
            />
            <p className="font-display text-center text-lg font-semibold text-[#1f5e3b]">
              Prakriti Herbs — Reset password
            </p>
          </div>

          {step === 1 && (
            <form onSubmit={sendOtp} className="space-y-4">
              <p className="text-xs text-[#1f5e3b]/75">
                Enter your registered email. We will send a one-time code (valid 5 minutes).
              </p>
              <label className="block text-xs font-semibold text-[#1f5e3b]/90">Email</label>
              <input
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                autoComplete="email"
                required
              />
              {err && <p className="text-sm text-red-600">{err}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-xl bg-[#1f5e3b] py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                Send OTP
              </button>
            </form>
          )}

          {step === 2 && (
            <form onSubmit={verifyOtp} className="space-y-4">
              <label className="block text-xs font-semibold text-[#1f5e3b]/90">6-digit OTP</label>
              <input
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm tracking-widest"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                required
              />
              {err && <p className="text-sm text-red-600">{err}</p>}
              {msg && <p className="text-xs text-[#2e7d32]">{msg}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-xl bg-[#1f5e3b] py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                Verify OTP
              </button>
            </form>
          )}

          {step === 3 && (
            <form onSubmit={savePassword} className="space-y-4">
              <label className="block text-xs font-semibold text-[#1f5e3b]/90">New password</label>
              <input
                type="password"
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                autoComplete="new-password"
                required
                minLength={6}
              />
              <label className="block text-xs font-semibold text-[#1f5e3b]/90">Confirm password</label>
              <input
                type="password"
                className="w-full rounded-xl border border-[#1f5e3b]/12 bg-white/90 px-4 py-3 text-sm"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                autoComplete="new-password"
                required
              />
              {err && <p className="text-sm text-red-600">{err}</p>}
              {msg && <p className="text-sm text-[#2e7d32]">{msg}</p>}
              <button
                type="submit"
                disabled={busy}
                className="w-full rounded-xl bg-[#1f5e3b] py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                Save password
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-xs text-[#1f5e3b]/65">
            <Link to="/login" className="font-medium text-[#2e7d32] underline">
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
