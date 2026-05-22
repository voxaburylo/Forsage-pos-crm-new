export type CashOperationType = 'in' | 'out'

export interface CashOperation {
  id:         string
  shift_id:   string
  type:       CashOperationType
  amount:     number   // копійки
  note:       string | null
  created_by: string
  created_at: string
}

export interface CashSummary {
  total_in:  number   // копійки
  total_out: number   // копійки
  net:       number   // копійки
}
