import type { ComponentType } from 'react'
import { Bar, Legend, Tooltip, XAxis, YAxis } from 'recharts'

// Recharts 2 exposes several class components whose declarations are not
// accepted as JSX elements by the React 18 type set used in this workspace.
// The runtime components are valid; keep the compatibility cast in one place.
export const ChartBar = Bar as unknown as ComponentType<any>
export const ChartLegend = Legend as unknown as ComponentType<any>
export const ChartTooltip = Tooltip as unknown as ComponentType<any>
export const ChartXAxis = XAxis as unknown as ComponentType<any>
export const ChartYAxis = YAxis as unknown as ComponentType<any>

