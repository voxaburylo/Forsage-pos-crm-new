import { Link, useLocation } from 'react-router-dom'
import { activeAnalyticsLink, visibleAnalyticsGroups } from '@/features/analytics/analyticsNav'

/** Два рядки навігації аналітики: групи і звіти вибраної групи. */
export function AnalyticsNav({ role }: { role: string }) {
  const location = useLocation()
  const groups = visibleAnalyticsGroups(role)
  if (!groups.length) return null
  const active = activeAnalyticsLink(groups, location.pathname, location.search)
  const activeGroup = groups.find(group => active && group.links.includes(active)) ?? groups[0]
  const tabClass = (on: boolean) => 'py-2 px-1 border-b-2 text-sm whitespace-nowrap transition-colors ' + (on
    ? 'border-[#FFD000] text-gray-900 font-semibold' : 'border-transparent text-gray-500 hover:text-gray-900 hover:border-gray-200 font-medium')
  return (
    <nav aria-label="Розділи аналітики" className="mb-4 -mx-4 px-4 -mt-4 md:-mx-6 md:px-6 md:-mt-6 bg-white shrink-0 border-b border-gray-100">
      <div className="flex flex-wrap gap-x-5">
        {groups.map(group => (
          <Link key={group.id} to={group.links[0].to} className={tabClass(group === activeGroup)}>{group.label}</Link>
        ))}
      </div>
      {activeGroup.links.length > 1 && (
        <div className="flex flex-wrap gap-2 py-2">
          {activeGroup.links.map(link => (
            <Link key={link.to} to={link.to}
              className={'rounded-full px-3 py-1 text-xs ' + (link === active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200')}>
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  )
}
