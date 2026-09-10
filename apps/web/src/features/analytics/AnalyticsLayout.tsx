import type { ComponentProps } from 'react'
import { Layout } from '@/components/Layout'
import './analyticsLayout.css'

export function AnalyticsLayout(props: ComponentProps<typeof Layout>) {
  return <Layout {...props} contentClassName="analytics-content" />
}
