export function ReportSourceNote({ local }: { local: boolean }) {
  return <p className="mb-3 text-xs text-gray-500" data-testid="report-source">
    {local ? 'Джерело: локальна база магазину.'
      : 'Джерело: серверна копія для перегляду. Вона може відставати від каси; точний час повноти даних наразі не підтверджено.'}
  </p>
}
