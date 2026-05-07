/** Lightweight loading skeleton for dashboard-style cards */
export function PageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-4 p-4">
      <div className="h-8 w-48 rounded-lg bg-[#1f5e3b]/10" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl bg-[#1f5e3b]/8" />
        ))}
      </div>
      <div className="h-40 rounded-2xl bg-[#1f5e3b]/8" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 max-w-full rounded bg-[#1f5e3b]/6" />
      ))}
    </div>
  )
}
