import { Link } from 'react-router-dom'

export function Placeholder({
  title,
  hint,
}: {
  title: string
  hint?: string
}) {
  return (
    <div className="ph-card mx-auto max-w-lg rounded-2xl p-8 text-center">
      <h1 className="text-xl font-bold text-[#1f5e3b]">{title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-[#1f5e3b]/70">
        {hint || 'This module uses the classic portal while we migrate screens to React.'}
      </p>
      <Link
        to="/"
        className="mt-8 inline-block rounded-xl bg-gradient-to-r from-[#1f5e3b] to-[#2e7d32] px-6 py-3 text-sm font-semibold text-white shadow-[0_8px_24px_rgba(31,94,59,0.25)] transition hover:brightness-[1.03]"
      >
        Back to Dashboard
      </Link>
      <p className="mt-6 text-xs text-[#8d6e63]">
        Full flows:{' '}
        <a className="font-semibold text-[#1f5e3b] underline underline-offset-2" href="/portal/">
          Legacy portal
        </a>
      </p>
    </div>
  )
}
