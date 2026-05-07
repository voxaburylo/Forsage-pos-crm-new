import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={
          <div className="min-h-screen bg-gray-100 flex items-center justify-center">
            <div className="bg-white rounded-2xl shadow-lg p-10 text-center max-w-md">
              <div className="text-5xl mb-4">⚡</div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">Форсаж CRM</h1>
              <p className="text-gray-500 mb-6">Система управління магазином автозапчастин</p>
              <div className="inline-block bg-yellow-400 text-black font-semibold px-6 py-2 rounded-lg text-sm">
                Розробка — Фаза 1
              </div>
            </div>
          </div>
        } />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
