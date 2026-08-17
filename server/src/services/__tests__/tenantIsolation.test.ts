import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireAuth } from '../../middleware/auth.js'
import { listSuppliers } from '../supplierService.js'
import { listCustomers, getCustomer } from '../customerService.js'
import { listReturns, getReturn, getSaleItems } from '../returnService.js'
import { getCurrentShift, getShift, getShiftReport } from '../shiftService.js'
import { allocateSaleNumber, getSale, listSales } from '../saleService.js'
import { getShiftCashSummary, listCashOperations } from '../cashOperationService.js'
import { getProduct, listProducts } from '../productService.js'
import { getSalesToday } from '../reportService.js'
import { getBalance, getTransactions } from '../loyaltyService.js'
import { db } from '../../db/supabase.js'
import jwt from 'jsonwebtoken'
import { supabaseAdmin } from '../../db/supabaseAdmin.js'

const TEST_JWT_OPTIONS = {
  audience: 'authenticated',
  issuer: 'https://test-project.supabase.co/auth/v1',
} as const

vi.mock('../../db/pg.js', () => ({
  runTransaction: vi.fn(),
  pool: {
    options: { max: 10 },
    query: vi.fn().mockResolvedValue({
      rows: [{ generation: 0, reset_at: null, resetting_at: null }],
      rowCount: 1,
    }),
    connect: vi.fn(),
  },
}))

// Set up mock function slots on global before hoisting runs
vi.mock('../../db/supabase.js', () => {
  const mockEq = vi.fn().mockReturnThis()
  const mockIs = vi.fn().mockReturnThis()
  const mockOrder = vi.fn().mockReturnThis()
  const mockRange = vi.fn().mockReturnThis()
  const mockOr = vi.fn().mockReturnThis()
  const mockGte = vi.fn().mockReturnThis()
  const mockLte = vi.fn().mockReturnThis()
  const mockGt = vi.fn().mockReturnThis()
  const mockLimit = vi.fn().mockReturnThis()
  const mockIn = vi.fn().mockReturnThis()
  const mockNeq = vi.fn().mockReturnThis()
  
  // Store them globally to access in test blocks
  ;(global as any).__mockEq = mockEq
  ;(global as any).__mockIs = mockIs

  const mockQueryChain = {
    eq: mockEq,
    is: mockIs,
    order: mockOrder,
    range: mockRange,
    or: mockOr,
    gte: mockGte,
    lte: mockLte,
    gt: mockGt,
    limit: mockLimit,
    in: mockIn,
    neq: mockNeq,
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    single: vi.fn().mockResolvedValue({ data: { id: 'some-id', tenant_id: 'store-abc-tenant-id' }, error: null }),
    then: (resolve: any) => resolve({ data: [], error: null })
  }

  return {
    db: {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue(mockQueryChain),
        insert: vi.fn().mockReturnValue(mockQueryChain),
        update: vi.fn().mockReturnValue(mockQueryChain),
        delete: vi.fn().mockReturnValue(mockQueryChain),
      })
    }
  }
})

// Mock Supabase Admin client
vi.mock('../../db/supabaseAdmin.js', () => {
  return {
    supabaseAdmin: {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user: {
              id: 'user-id',
              email: 'test@example.com',
              app_metadata: {
                role: 'admin',
                tenant_id: 'store-1-tenant-id'
              }
            }
          },
          error: null
        })
      }
    }
  }
})

// Mock audit logging to prevent writing errors in tests
vi.mock('../auditService.js', () => {
  return {
    logAction: vi.fn().mockResolvedValue(true)
  }
})

describe('Multi-Tenant Data Isolation Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_JWT_SECRET = 'test-secret'
    process.env.SUPABASE_URL = 'https://test-project.supabase.co'
    
    // Reset our query chain methods to allow mockReturnThis
    if ((global as any).__mockEq) {
      (global as any).__mockEq.mockReturnThis()
    }
    if ((global as any).__mockIs) {
      (global as any).__mockIs.mockReturnThis()
    }
  })

  describe('1. Auth Middleware Boundary', () => {
    it('should successfully authorize user and set tenant_id if present in JWT token', async () => {
      const tenantId = 'store-2-tenant-id'
      const token = jwt.sign(
        {
          sub: 'user-id-123',
          email: 'cashier@store2.com',
          app_metadata: {
            role: 'cashier',
            tenant_id: tenantId,
            is_active: true
          }
        },
        'test-secret',
        TEST_JWT_OPTIONS,
      )

      const req = {
        headers: {
          authorization: `Bearer ${token}`
        }
      } as any
      const res = {} as any
      const next = vi.fn()

      await requireAuth(req, res, next)

      expect(next).toHaveBeenCalledWith()
      expect(req.user).toBeDefined()
      expect(req.user.tenant_id).toBe(tenantId)
      expect(req.user.role).toBe('cashier')
    })

    it('should return 403 Forbidden if tenant_id is missing from JWT metadata', async () => {
      const token = jwt.sign(
        {
          sub: 'user-id-123',
          email: 'cashier@store2.com',
          app_metadata: {
            role: 'cashier',
            is_active: true
            // tenant_id is missing
          }
        },
        'test-secret',
        TEST_JWT_OPTIONS,
      )

      vi.mocked(supabaseAdmin.auth.getUser).mockResolvedValueOnce({
        data: {
          user: {
            id: 'user-id-123',
            email: 'cashier@store2.com',
            app_metadata: { role: 'cashier', is_active: true },
          },
        },
        error: null,
      } as any)

      const req = {
        headers: {
          authorization: `Bearer ${token}`
        }
      } as any
      const res = {} as any
      const next = vi.fn()

      await requireAuth(req, res, next)

      expect(next).toHaveBeenCalled()
      const errorArg = next.mock.calls[0][0]
      expect(errorArg).toBeDefined()
      expect(errorArg.status).toBe(403)
      expect(errorArg.message).toContain('Не вказано ідентифікатор магазину')
    })

    it('ignores role and tenant claims from editable user_metadata', async () => {
      const token = jwt.sign(
        {
          sub: 'user-id-123',
          email: 'cashier@store2.com',
          user_metadata: {
            role: 'owner',
            tenant_id: 'forged-tenant-id',
            is_active: true,
          },
          app_metadata: {
            role: 'cashier',
            tenant_id: 'trusted-tenant-id',
            is_active: true,
          },
        },
        'test-secret',
        TEST_JWT_OPTIONS,
      )

      const req = {
        headers: {
          authorization: `Bearer ${token}`,
        },
      } as any
      const next = vi.fn()

      await requireAuth(req, {} as any, next)

      expect(next).toHaveBeenCalledWith()
      expect(req.user).toMatchObject({
        role: 'cashier', tenant_id: 'trusted-tenant-id',
      })
    })
  })

  describe('2. Service Layer Database Filtering', () => {
    it('should apply tenant_id query filter when listing suppliers', async () => {
      const tenantId = 'store-abc-tenant-id'
      
      await listSuppliers({ page: 1, per_page: 20 }, tenantId)

      // Verify db.from() was called with 'suppliers'
      expect(db.from).toHaveBeenCalledWith('suppliers')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when listing customers', async () => {
      const tenantId = 'store-abc-tenant-id'
      await listCustomers({ page: 1, per_page: 20 }, tenantId)
      expect(db.from).toHaveBeenCalledWith('customers')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting a customer', async () => {
      const tenantId = 'store-abc-tenant-id'
      try {
        await getCustomer('customer-uuid', tenantId)
      } catch {}
      expect(db.from).toHaveBeenCalledWith('customers')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when listing returns', async () => {
      const tenantId = 'store-abc-tenant-id'
      await listReturns({ page: 1, per_page: 20 }, tenantId)
      expect(db.from).toHaveBeenCalledWith('returns')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting a return', async () => {
      const tenantId = 'store-abc-tenant-id'
      try {
        await getReturn('return-uuid', tenantId)
      } catch {}
      expect(db.from).toHaveBeenCalledWith('returns')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting sale items for return', async () => {
      const tenantId = 'store-abc-tenant-id'
      try {
        await getSaleItems('sale-uuid', tenantId)
      } catch {}
      expect(db.from).toHaveBeenCalledWith('sales')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting a shift', async () => {
      const tenantId = 'store-abc-tenant-id'
      try {
        await getShift('shift-uuid', tenantId)
      } catch {}
      expect(db.from).toHaveBeenCalledWith('shifts')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting the current shift', async () => {
      const tenantId = 'store-abc-tenant-id'
      await getCurrentShift('cashier-uuid', tenantId)
      expect(db.from).toHaveBeenCalledWith('shifts')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting a shift report', async () => {
      const tenantId = 'store-abc-tenant-id'
      try {
        await getShiftReport('shift-uuid', tenantId)
      } catch {}
      expect(db.from).toHaveBeenCalledWith('shifts')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when listing sales', async () => {
      const tenantId = 'store-abc-tenant-id'
      await listSales({ page: 1, per_page: 20 }, tenantId)
      expect(db.from).toHaveBeenCalledWith('sales')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting a sale', async () => {
      const tenantId = 'store-abc-tenant-id'
      await getSale('sale-uuid', tenantId)
      expect(db.from).toHaveBeenCalledWith('sales')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should allocate the next number after the highest existing tenant sale', async () => {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{}] })
        .mockResolvedValueOnce({ rows: [{ max_number: '50' }] })

      await expect(allocateSaleNumber({ query }, 'store-abc-tenant-id')).resolves.toBe('000051')
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining('WHERE tenant_id = $1'), ['store-abc-tenant-id'])
    })

    it('should apply tenant_id query filter when listing cash operations', async () => {
      const tenantId = 'store-abc-tenant-id'
      await listCashOperations({ page: 1, per_page: 20 }, tenantId)
      expect(db.from).toHaveBeenCalledWith('cash_operations')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when summarizing shift cash', async () => {
      const tenantId = 'store-abc-tenant-id'
      await getShiftCashSummary('shift-uuid', tenantId)
      expect(db.from).toHaveBeenCalledWith('cash_operations')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when listing products', async () => {
      const tenantId = 'store-abc-tenant-id'
      await listProducts({ page: 1, per_page: 20, sort_dir: 'asc' }, tenantId)
      expect(db.from).toHaveBeenCalledWith('products')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter when getting a product', async () => {
      const tenantId = 'store-abc-tenant-id'
      await getProduct('product-uuid', tenantId)
      expect(db.from).toHaveBeenCalledWith('products')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })

    it('should apply tenant_id query filter to daily sales reports', async () => {
      const tenantId = 'store-abc-tenant-id'
      await getSalesToday(tenantId)
      expect(db.from).toHaveBeenCalledWith('sales')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
      const salesBuilder = (db.from as any).mock.results
        .find((_: unknown, index: number) => (db.from as any).mock.calls[index]?.[0] === 'sales')
        ?.value
      expect(salesBuilder?.select).toHaveBeenCalled()
      expect(String(salesBuilder?.select.mock.calls[0]?.[0] ?? '')).not.toContain('debt_amount')
    })

    it('should apply tenant_id query filter to loyalty balances and transactions', async () => {
      const tenantId = 'store-abc-tenant-id'
      await getBalance('customer-uuid', tenantId)
      await getTransactions('customer-uuid', tenantId)
      expect(db.from).toHaveBeenCalledWith('customers')
      expect(db.from).toHaveBeenCalledWith('bonus_transactions')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })
  })
})
