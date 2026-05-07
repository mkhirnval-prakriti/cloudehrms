/** Minimal branded loader — logo + orbit only (no splash copy). */
export function LogoLoader() {
  const base = import.meta.env.BASE_URL
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f5f7f6] px-4">
      <div className="relative flex h-28 w-28 items-center justify-center">
        <div
          className="ph-loader-orbit absolute inset-0 rounded-full border-2 border-dashed border-[#1f5e3b]/25 border-t-[#66bb6a]"
          aria-hidden
        />
        <img
          src={`${base}logo.png`}
          alt=""
          className="ph-loader-logo relative h-16 w-16 object-contain"
          width={64}
          height={64}
        />
      </div>
    </div>
  )
}
