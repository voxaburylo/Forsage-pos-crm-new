export function OrderReadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <p>{message}</p>
    <button type="button" onClick={onRetry} className="mt-2 font-semibold underline underline-offset-2">Повторити завантаження</button>
  </div>
}
