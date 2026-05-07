import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../context/AuthContext'
import { canPerm } from '../lib/permissions'

type Lead = {
  id: number
  full_name: string
  phone: string | null
  email: string | null
  company: string | null
  status: string
  notes: string | null
  created_at: string
  created_by_name?: string | null
}

export function CrmPage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const canRead = !!(user && canPerm(user, 'crm:read'))
  const canWrite = !!(user && canPerm(user, 'crm:write'))
  const [full_name, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [status, setStatus] = useState('new')
  const [notes, setNotes] = useState('')

  const leadsQ = useQuery({
    queryKey: ['crm', 'leads'],
    queryFn: () => api<{ leads: Lead[] }>('/crm/leads'),
    enabled: canRead,
  })

  const createM = useMutation({
    mutationFn: () =>
      api<{ lead: Lead }>('/crm/leads', {
        method: 'POST',
        body: JSON.stringify({
          full_name,
          phone: phone || undefined,
          email: email || undefined,
          company: company || undefined,
          status,
          notes: notes || undefined,
        }),
      }),
    onSuccess: () => {
      setFullName('')
      setPhone('')
      setEmail('')
      setCompany('')
      setStatus('new')
      setNotes('')
      void qc.invalidateQueries({ queryKey: ['crm', 'leads'] })
    },
  })

  const leads = leadsQ.data?.leads ?? []

  if (!canRead) {
    return (
      <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center text-sm text-[#1f5e3b]">
        CRM leads are restricted to Admin and Branch / Attendance managers. Contact HR if you need access.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[#1f5e3b]">CRM — Leads</h1>
        <p className="mt-1 text-sm text-[#1f5e3b]/70">Basic lead capture tied to your HRMS login.</p>
      </div>

      <section className="ph-card rounded-2xl border border-[#1f5e3b]/10 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1f5e3b]/80">New lead</h2>
        {!canWrite && (
          <p className="mt-2 text-xs text-amber-800">You can view leads but cannot create new ones.</p>
        )}
        <form
          className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canWrite || !full_name.trim()) return
            createM.mutate()
          }}
        >
          <label className="block text-sm">
            <span className="font-medium text-[#37474f]">Name *</span>
            <input
              className="mt-1 w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm outline-none ring-[#2e7d32]/25 focus:ring-2"
              value={full_name}
              onChange={(e) => setFullName(e.target.value)}
              required
              disabled={!canWrite}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-[#37474f]">Phone</span>
            <input
              className="mt-1 w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm outline-none ring-[#2e7d32]/25 focus:ring-2"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              disabled={!canWrite}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-[#37474f]">Email</span>
            <input
              type="email"
              className="mt-1 w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm outline-none ring-[#2e7d32]/25 focus:ring-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={!canWrite}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-[#37474f]">Company</span>
            <input
              className="mt-1 w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm outline-none ring-[#2e7d32]/25 focus:ring-2"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              disabled={!canWrite}
            />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-[#37474f]">Status</span>
            <select
              className="mt-1 w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm outline-none ring-[#2e7d32]/25 focus:ring-2"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              disabled={!canWrite}
            >
              <option value="new">new</option>
              <option value="contacted">contacted</option>
              <option value="qualified">qualified</option>
              <option value="won">won</option>
              <option value="lost">lost</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-2 lg:col-span-3">
            <span className="font-medium text-[#37474f]">Notes</span>
            <textarea
              className="mt-1 min-h-[72px] w-full rounded-xl border border-[#1f5e3b]/15 px-3 py-2 text-sm outline-none ring-[#2e7d32]/25 focus:ring-2"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={!canWrite}
            />
          </label>
          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              disabled={!canWrite || createM.isPending}
              className="rounded-xl bg-gradient-to-r from-[#1f5e3b] to-[#2e7d32] px-5 py-2.5 text-sm font-semibold text-white shadow-md transition hover:brightness-[1.03] disabled:opacity-60"
            >
              {createM.isPending ? 'Saving…' : 'Save lead'}
            </button>
            {createM.isError ? (
              <p className="mt-2 text-sm text-red-600">{(createM.error as Error).message}</p>
            ) : null}
          </div>
        </form>
      </section>

      <section className="ph-card overflow-hidden rounded-2xl border border-[#1f5e3b]/10 bg-white shadow-sm">
        <div className="border-b border-[#1f5e3b]/10 px-5 py-4 sm:px-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1f5e3b]/80">Pipeline</h2>
        </div>
        {leadsQ.isLoading ? (
          <p className="p-6 text-sm text-[#1f5e3b]/70">Loading…</p>
        ) : leadsQ.isError ? (
          <p className="p-6 text-sm text-red-600">{(leadsQ.error as Error).message}</p>
        ) : leads.length === 0 ? (
          <p className="p-6 text-sm text-[#1f5e3b]/70">No leads yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#f1f8f4] text-xs font-semibold uppercase tracking-wide text-[#1f5e3b]/80">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f5e3b]/8">
                {leads.map((r) => (
                  <tr key={r.id} className="hover:bg-[#fafcfa]">
                    <td className="px-4 py-3 font-medium text-[#263238]">{r.full_name}</td>
                    <td className="px-4 py-3 text-[#37474f]">{r.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-[#37474f]">{r.email ?? '—'}</td>
                    <td className="px-4 py-3 text-[#37474f]">{r.company ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-[#e8f5e9] px-2.5 py-0.5 text-xs font-medium text-[#2e7d32]">
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#546e7a]">{r.created_at?.slice(0, 16) ?? ''}</td>
                    <td className="px-4 py-3 text-[#546e7a]">{r.created_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
