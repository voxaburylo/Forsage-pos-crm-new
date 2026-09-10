export function ReportError({ message, retry }: { message: string; retry: () => void }) {
  if (!message) return null
  return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
    <p>Звіт не завантажено. Це не означає, що продажів немає.</p>
    <p className="mt-1">{message}</p>
    <button type="button" onClick={retry} className="mt-3 rounded-lg border border-red-300 px-3 py-2 font-semibold">Спробувати ще раз</button>
  </div>
}
