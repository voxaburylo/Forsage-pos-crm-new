import type { ComponentProps } from 'react'
import { Layout } from '@/components/Layout'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { ReportSourceNote } from './ReportSourceNote'
import './analyticsLayout.css'

export function AnalyticsLayout(props: ComponentProps<typeof Layout>) {
  return <Layout {...props} contentClassName="analytics-content">
    <ReportSourceNote local={isDesktopRuntime()} />
    {props.children}
  </Layout>
}
