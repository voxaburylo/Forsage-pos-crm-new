import { describe, it, expect, vi, beforeEach } from 'vitest'
import { requireAuth } from '../../middleware/auth.js'
import { listSuppliers } from '../supplierService.js'
import { listCustomers, getCustomer } from '../customerService.js'
import { listReturns, getReturn, getSaleItems } from '../returnService.js'
import { getShift, getShiftReport } from '../shiftService.js'
import { db } from '../../db/supabase.js'
import jwt from 'jsonwebtoken'

// Set up mock function slots on global before hoisting runs
vi.mock('../../db/supabase.js', () => {
  const mockEq = vi.fn().mockReturnThis()
  const mockIs = vi.fn().mockReturnThis()
  const mockOrder = vi.fn().mockReturnThis()
  const mockRange = vi.fn().mockReturnThis()
  const mockOr = vi.fn().mockReturnThis()
  
  // Store them globally to access in test blocks
  ;(global as any).__mockEq = mockEq
  ;(global as any).__mockIs = mockIs

  const mockQueryChain = {
    eq: mockEq,
    is: mockIs,
    order: mockOrder,
    range: mockRange,
    or: mockOr,
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
              user_metadata: {
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
          user_metadata: {
            role: 'cashier',
            tenant_id: tenantId,
            is_active: true
          }
        },
        'test-secret'
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
          user_metadata: {
            role: 'cashier',
            is_active: true
            // tenant_id is missing
          }
        },
        'test-secret'
      )

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

    it('should apply tenant_id query filter when getting a shift report', async () => {
      const tenantId = 'store-abc-tenant-id'
      try {
        await getShiftReport('shift-uuid', tenantId)
      } catch {}
      expect(db.from).toHaveBeenCalledWith('shifts')
      expect((global as any).__mockEq).toHaveBeenCalledWith('tenant_id', tenantId)
    })
  })
})
