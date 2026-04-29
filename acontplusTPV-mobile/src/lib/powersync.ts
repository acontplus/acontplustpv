// =============================================================================
// src/lib/powersync.ts
// Configuración de PowerSync + schemas SQLite
//
// Los schemas SQLite son un SUBCONJUNTO EXACTO de las tablas del schema Prisma.
// Solo se sincronizan los campos que la app necesita para operar offline.
// Los campos pesados (notas largas, URLs de recibos, etc.) se omiten
// para mantener el tamaño de la base de datos local pequeño.
//
// Tablas sincronizadas por perfil (según sync-rules.yaml):
//   TODOS          → Product, ProductCategory, Table, BusinessDay, Establishment
//   WAITER_DEVICE  → Order, OrderItem (solo los suyos, 12h)
//   CASHIER/BARMAN → Order, OrderItem (todos de la jornada)
//   PRINT_NODE     → Order, OrderItem (solo printStatus=PENDING, 2h)
//
// Convención de nombres: snake_case en SQLite (PowerSync convierte desde
// el PascalCase de PostgreSQL automáticamente vía sync-rules.yaml)
// =============================================================================

import {
  PowerSyncDatabase,
  AbstractPowerSyncDatabase,
  column,
  Schema,
  Table,
}                             from '@powersync/react-native'
import Constants              from 'expo-constants'
import { useAuthStore }       from '../store/auth'

// Precedencia de URLs:
// 1) Constants.expoConfig.extra.* (inyectado por app.config.ts / EAS env)
// 2) Fallback localhost para desarrollo sin .env
function getApiUrl(): string {
  const url = Constants.expoConfig?.extra?.apiUrl
  return typeof url === 'string' && url.length > 0 ? url : 'http://localhost:3000'
}

function getPowerSyncUrl(): string {
  const url = Constants.expoConfig?.extra?.powerSyncUrl
  return typeof url === 'string' && url.length > 0 ? url : 'http://localhost:8080'
}

// =============================================================================
// SCHEMAS SQLite — espejo del schema Prisma (solo campos necesarios offline)
// =============================================================================

// ── ProductCategory ───────────────────────────────────────────────────────────
const productCategorySchema = new Table({
  name:          column.text,
  description:   column.text,
  display_order: column.integer,
  is_active:     column.integer,
}, { indexes: { display_order: ['display_order'] } })

// ── Product ───────────────────────────────────────────────────────────────────
const productSchema = new Table({
  category_id:          column.text,
  name:                 column.text,
  description:          column.text,
  sale_price:           column.real,
  current_average_cost: column.real,
  unit:                 column.text,
  is_active:            column.integer,
  updated_at:           column.text,
}, {
  indexes: {
    by_category: ['category_id'],
    active:      ['is_active'],
  },
})

// ── Table (mesas del restaurante) ─────────────────────────────────────────────
const tableSchema = new Table({
  establishment_id: column.text,
  number:           column.integer,
  alias:            column.text,
  capacity:         column.integer,
  is_active:        column.integer,
}, {
  indexes: {
    by_establishment: ['establishment_id'],
  },
})

// ── BusinessDay (jornada activa) ──────────────────────────────────────────────
const businessDaySchema = new Table({
  establishment_id: column.text,
  is_open:          column.integer,
  opened_at:        column.text,
  opened_by:        column.text,
  closed_at:        column.text,
}, {
  indexes: {
    by_establishment: ['establishment_id', 'is_open'],
  },
})

// ── Establishment ─────────────────────────────────────────────────────────────
const establishmentSchema = new Table({
  tenant_id:     column.text,
  code:          column.text,
  name:          column.text,
  address:       column.text,
  phone:         column.text,
  service_model: column.text,
  is_active:     column.integer,
})

// ── Order ─────────────────────────────────────────────────────────────────────
const orderSchema = new Table({
  establishment_id:     column.text,
  point_of_sale_id:     column.text,
  business_day_id:      column.text,
  order_number:         column.text,
  local_sequence:       column.text,
  created_by_user_id:   column.text,
  created_by_device_id: column.text,
  closed_by_user_id:    column.text,
  table_id:             column.text,
  table_alias:          column.text,
  kiosk_turn_number:    column.text,
  status:               column.text,
  payment_method:       column.text,
  print_status:         column.text,
  subtotal:             column.real,
  total_amount:         column.real,
  notes:                column.text,
  created_at:           column.text,
  updated_at:           column.text,
}, {
  indexes: {
    by_status:       ['status'],
    by_business_day: ['business_day_id', 'status'],
    by_user:         ['created_by_user_id', 'status'],
    by_print:        ['print_status'],
    by_sequence:     ['local_sequence'],
  },
})

// ── OrderItem ─────────────────────────────────────────────────────────────────
const orderItemSchema = new Table({
  order_id:   column.text,
  product_id: column.text,
  quantity:   column.real,
  unit_price: column.real,
  unit_cost:  column.real,
  subtotal:   column.real,
  notes:      column.text,
}, {
  indexes: {
    by_order: ['order_id'],
  },
})

// =============================================================================
// SCHEMA COMPLETO
// =============================================================================

export const AppSchema = new Schema({
  ProductCategory: productCategorySchema,
  Product:         productSchema,
  Table:           tableSchema,
  BusinessDay:     businessDaySchema,
  Establishment:   establishmentSchema,
  Order:           orderSchema,
  OrderItem:       orderItemSchema,
})

export type Database = (typeof AppSchema)['types']

// =============================================================================
// CONECTOR DE POWERSYNC
// =============================================================================

class AcontPlusConnector {
  async fetchCredentials() {
    const { accessToken, refreshAccessToken, powerSyncUrl } = useAuthStore.getState()

    if (!accessToken) return null

    try {
      const apiUrl = getApiUrl()
      const resolvedPowerSyncEndpoint = powerSyncUrl ?? getPowerSyncUrl()
      console.log('[PowerSync] endpoint:', resolvedPowerSyncEndpoint)
      console.log('[PowerSync] apiUrl:', apiUrl)
      const response = await fetch(`${apiUrl}/auth/powersync-token`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })
      console.log('[PowerSync] token fetch status:', response.status)

      if (response.status === 401) {
        const newAccessToken = await refreshAccessToken()
        if (!newAccessToken) return null

        const retryResponse = await fetch(`${apiUrl}/auth/powersync-token`, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${newAccessToken}`,
          },
        })
        console.log('[PowerSync] token fetch retry status:', retryResponse.status)

        if (!retryResponse.ok) return null

        const retryData = await retryResponse.json() as { token: string }
        console.log('[PowerSync] token received (retry):', retryData.token?.slice(0, 24) ?? 'null')
        return {
          endpoint: resolvedPowerSyncEndpoint,
          token:    retryData.token,
        }
      }

      if (!response.ok) return null

      const data = await response.json() as { token: string }
      console.log('[PowerSync] token received:', data.token?.slice(0, 24) ?? 'null')
      return {
        endpoint: resolvedPowerSyncEndpoint,
        token:    data.token,
      }
    } catch (err) {
      console.warn('[PowerSync] fetchCredentials error:', err)
      return null
    }
  }

  async uploadData(_database: AbstractPowerSyncDatabase): Promise<void> {
    // Las escrituras van por tRPC, no por PowerSync upload
    return
  }
}

// =============================================================================
// INSTANCIA GLOBAL DE POWERSYNC
// =============================================================================

export const powerSyncDb = new PowerSyncDatabase({
  schema:   AppSchema,
  database: {
    dbFilename: 'acontplustpv.db',
  },
})

export const connector = new AcontPlusConnector()

export async function initPowerSync(): Promise<void> {
  await powerSyncDb.init()
  await powerSyncDb.connect(connector)
}

export async function disconnectAndClear(): Promise<void> {
  await powerSyncDb.disconnectAndClear()
}
