import { Sidebar } from './Sidebar'
import { ToastContainer } from './ui'

interface Props {
  children: React.ReactNode
  title?: string
  actions?: React.ReactNode
  onBack?: () => void
}

export function Layout({ children, title, actions, onBack }: Props) {
  return (
    <div className="flex min-h-screen bg-gray-100">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        {(title || actions || onBack) && (
          <header className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {onBack && (
                <button onClick={onBack} className="text-gray-400 hover:text-gray-600 transition-colors">
                  ←
                </button>
              )}
              {title && <h1 className="font-bold text-gray-900 text-lg">{title}</h1>}
            </div>
            {actions && <div className="flex items-center gap-3">{actions}</div>}
          </header>
        )}
        <main className="flex-1 p-6 overflow-auto">
          {children}
        </main>
      </div>
      <ToastContainer />
    </div>
  )
}
