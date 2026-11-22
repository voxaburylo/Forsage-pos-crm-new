import { Zap } from 'lucide-react'

/**
 * Логотип «Форсаж» — один для всіх екранів (22.11.2026, слово власника: «логотип як у веб-версії всюди»):
 * жовтий квадрат із чорною блискавкою. Той самий малюнок — у значку вкладки (public/favicon.svg)
 * і в значку програми каси (apps/desktop/build/icon.svg → icon.ico).
 */
export function BrandLogo({ size = 32 }: { size?: number }) {
  return (
    <div className="bg-accent flex items-center justify-center shrink-0" style={{ width: size, height: size, borderRadius: size / 4 }} aria-hidden="true">
      <Zap size={Math.round(size / 2)} className="text-black" fill="currentColor" />
    </div>
  )
}
