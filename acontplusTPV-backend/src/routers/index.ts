// =============================================================================
// apps/api/src/routers/index.ts
// =============================================================================

import { router }            from '../trpc'
import { authRouter }         from './auth'
import { businessDayRouter }  from './businessDay'
import { catalogRouter }      from './catalog'
import { supplierRouter }     from './supplier'
import { warehouseRouter }    from './warehouse'
import { orderRouter }        from './order'
import { paymentsRouter }     from './payments'
import { transfersRouter }    from './transfers'
import { creditsRouter }      from './credits'
import { inventoryRouter }    from './inventory'
import { purchasingRouter }   from './purchasing'
import { payrollRouter }      from './payroll'

export const appRouter = router({
  auth:        authRouter,
  businessDay: businessDayRouter,
  catalog:     catalogRouter,
  supplier:    supplierRouter,
  warehouse:   warehouseRouter,
  order:       orderRouter,
  payments:    paymentsRouter,
  transfers:   transfersRouter,
  credits:     creditsRouter,
  inventory:   inventoryRouter,
  purchasing:  purchasingRouter,
  payroll:     payrollRouter,     // Paso 10 — Nómina y anticipos
  // audit:       auditRouter,    // Paso 11 — Arqueo de inventario
})

export type AppRouter = typeof appRouter
