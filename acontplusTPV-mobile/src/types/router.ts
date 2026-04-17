// =============================================================================
// src/types/router.ts
// Tipo del AppRouter del backend — type-safety completa en el cliente tRPC
//
// ESTRATEGIA: definición manual sincronizada con el backend.
//
// En repos separados sin monorepo, este es el patrón correcto:
// copiar/escribir los tipos de input/output de cada procedimiento que el
// mobile consume. No es necesario tipear el backend completo — solo los
// procedimientos que la app llama.
//
// CÓMO MANTENER SINCRONIZADO (Opción B — recomendada a futuro):
//   En el backend, crear scripts/export-types.ts:
//     import type { AppRouter } from '../src/routers'
//     export type { AppRouter }
//   Luego en CI: npx tsx scripts/export-types.ts > ../mobile/src/types/router.ts
//
// Procedimientos tipados aquí (Sprint 2):
//   auth.login              → autenticación con PIN
//   auth.refresh            → renovar accessToken
//   auth.logout             → invalidar sesión
//   auth.listEstablishments → listar locales del tenant (endpoint público)
//   businessDay.open        → abrir jornada
//   businessDay.close       → cerrar jornada
//   businessDay.status      → estado de la jornada activa
//   catalog.listCategories  → categorías activas
//   catalog.listProducts    → productos activos con filtros
//
// Los procedimientos de sprints posteriores (order, payments, etc.)
// se añadirán a medida que se implementen en el mobile.
// =============================================================================

// ── Roles — espejo del enum Prisma del backend ───────────────────────────────
type UserRole = 'ADMIN' | 'CASHIER' | 'BARMAN' | 'WAITER'

// =============================================================================
// TIPOS DE RESPUESTA — copiados de acontplusTPV-backend/src/types/auth.ts
// =============================================================================

interface AuthUser {
  id:              string
  name:            string
  roles:           UserRole[]
  tenantId:        string
  establishmentId: string
}

interface LoginResponse {
  accessToken:  string
  refreshToken: string
  user:         AuthUser
}

interface RefreshResponse {
  accessToken: string
}

interface Establishment {
  id:   string
  name: string
  code: string
}

// ── businessDay ───────────────────────────────────────────────────────────────

interface BusinessDayStatus {
  isOpen:      boolean
  businessDay: {
    id:       string
    openedAt: string
    openedBy: string
  } | null
  establishment: {
    id:   string
    name: string
    code: string
  } | null
  message: string
}

interface OpenDayResponse {
  businessDayId:   string
  establishmentId: string
  openedAt:        string
  message:         string
}

interface CloseDayResponse {
  businessDayId: string
  closedAt:      string
  summary: {
    totalCash:      number
    totalTransfers: number
    totalOrders:    number
    blindCount:     number
    difference:     number
  }
  message: string
}

// ── catalog ───────────────────────────────────────────────────────────────────

interface ProductCategory {
  id:           string
  name:         string
  description:  string | null
  displayOrder: number
  isActive:     boolean
}

interface Product {
  id:                 string
  categoryId:         string
  name:               string
  description:        string | null
  salePrice:          number
  currentAverageCost: number
  unit:               string
  isActive:           boolean
}

interface ListCategoriesResponse {
  categories: ProductCategory[]
  total:      number
}

interface ListProductsResponse {
  products:   Product[]
  total:      number
  nextCursor: string | null
}

// =============================================================================
// TIPO DEL ROUTER COMPLETO
//
// Estructura que espeja el appRouter del backend:
//   router({ auth, businessDay, catalog, ... })
//
// tRPC usa este tipo para inferir los tipos de input/output de cada
// procedimiento en los hooks (trpc.auth.login.useMutation(), etc.)
// =============================================================================

export type AppRouter = {
  auth: {
    login: {
      _type:   'mutation'
      _input:  { tenantSlug: string; pin: string; establishmentId: string }
      _output: LoginResponse
    }
    refresh: {
      _type:   'mutation'
      _input:  { refreshToken: string }
      _output: RefreshResponse
    }
    logout: {
      _type:   'mutation'
      _input:  void
      _output: { success: boolean }
    }
    listEstablishments: {
      _type:   'query'
      _input:  { tenantSlug: string }
      _output: Establishment[]
    }
  }
  businessDay: {
    open: {
      _type:   'mutation'
      _input:  { establishmentId: string; initialCash?: number; notes?: string }
      _output: OpenDayResponse
    }
    close: {
      _type:   'mutation'
      _input:  { establishmentId: string; businessDayId: string; blindCount: number; notes?: string }
      _output: CloseDayResponse
    }
    status: {
      _type:   'query'
      _input:  { establishmentId: string }
      _output: BusinessDayStatus
    }
  }
  catalog: {
    listCategories: {
      _type:   'query'
      _input:  void
      _output: ListCategoriesResponse
    }
    listProducts: {
      _type:   'query'
      _input:  { categoryId?: string; search?: string; limit?: number; cursor?: string }
      _output: ListProductsResponse
    }
  }
}
