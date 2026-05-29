import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Sidebar } from './Sidebar'
import { ToastContainer } from './ui'

interface Props {
  children: React.ReactNode
  title?: string
  actions?: React.ReactNode
  onBack?: () => void
}

export function Layout({ children, title, actions, onBack }: Props) {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="bg-white border-b border-gray-100 px-4 md:px-6 py-3 flex items-center gap-2 pt-safe">
          {/* Hamburger — mobile only */}
          <button
            className="md:hidden shrink-0 p-1.5 -ml-1 rounded-lg text-gray-500 hover:bg-gray-100 active:bg-gray-200 transition-colors"
            onClick={() => setSidebarOpen(true)}
            aria-label="Меню"
          >
            <Menu size={22} />
          </button>

          <div className="flex items-center gap-2 min-w-0 flex-1">
            {onBack && (
              <button
                onClick={onBack}
                className="text-gray-400 hover:text-gray-600 transition-colors shrink-0 text-xl leading-none"
              >
                ←
              </button>
            )}
            {title && (
              <h1 className="font-bold text-gray-900 text-base md:text-lg truncate">{title}</h1>
            )}
          </div>

          {actions && (
            <div className="flex items-center gap-1.5 shrink-0 overflow-visible relative">{actions}</div>
          )}
        </header>

        <main className="flex-1 p-4 md:p-6 overflow-auto pb-safe">
          {children}
        </main>
      </div>

      <ToastContainer />
    </div>
  )
}
