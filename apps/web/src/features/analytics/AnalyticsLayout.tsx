import type { ComponentProps } from 'react'
import { Layout } from '@/components/Layout'
import { isDesktopRuntime } from '@/lib/desktopBridge'
import { ReportSourceNote } from './ReportSourceNote'
import './analyticsLayout.css'

/** serverSource — звіт рахується на сервері (навіть на касі): підпис «серверна копія станом на …». */
export function AnalyticsLayout({ serverSource = false, ...props }: ComponentProps<typeof Layout> & { serverSource?: boolean }) {
  return <Layout {...props} contentClassName="analytics-content">
    <ReportSourceNote local={isDesktopRuntime()} server={serverSource} />
    {props.children}
  </Layout>
}
