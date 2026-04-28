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
import { useAuthStore }       from '../store/auth'

// URLs hardcodeadas — evitan dependencia de Constants.expoConfig en runtime
const API_URL        = 'https://api.resuelveyaa.com'
const POWERSYNC_URL  = 'https://powersync.resuelveyaa.com'

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
  code:      column.text,
  name:      column.text,
  address:   column.text,
  phone:     column.text,
  is_active: column.integer,
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
      const response = await fetch(`${API_URL}/auth/powersync-token`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })

      if (response.status === 401) {
        const newAccessToken = await refreshAccessToken()
        if (!newAccessToken) return null

        const retryResponse = await fetch(`${API_URL}/auth/powersync-token`, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${newAccessToken}`,
          },
        })

        if (!retryResponse.ok) return null

        const retryData = await retryResponse.json() as { token: string }
        return {
          endpoint: powerSyncUrl ?? POWERSYNC_URL,
          token:    retryData.token,
        }
      }

      if (!response.ok) return null

      const data = await response.json() as { token: string }
      return {
        endpoint: powerSyncUrl ?? POWERSYNC_URL,
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
