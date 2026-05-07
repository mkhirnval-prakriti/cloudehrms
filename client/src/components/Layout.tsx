import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { MissedPunchoutModal } from './MissedPunchoutModal'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { useAuth } from '../context/AuthContext'

export function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [showMissed, setShowMissed] = useState(false)
  const { user } = useAuth()

  useEffect(() => {
    if (!user) return
    const key = `missed-dismissed-${user.id}-${new Date().toISOString().slice(0, 10)}`
    if (sessionStorage.getItem(key)) return
    setShowMissed(true)
  }, [user])

  function dismissMissed() {
    if (user) {
      const key = `missed-dismissed-${user.id}-${new Date().toISOString().slice(0, 10)}`
      sessionStorage.setItem(key, '1')
    }
    setShowMissed(false)
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#F4F7F4] dark:bg-[#0f1a13]">
      <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar onMenu={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 transition-opacity duration-200 md:p-6">
          <Outlet />
        </main>
      </div>
      {showMissed && <MissedPunchoutModal onDismiss={dismissMissed} />}
    </div>
  )
}
