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
import * as SecureStore       from 'expo-secure-store'
import { useAuthStore }       from '../store/auth'

// =============================================================================
// SCHEMAS SQLite — espejo del schema Prisma (solo campos necesarios offline)
// =============================================================================

// ── ProductCategory ───────────────────────────────────────────────────────────
// Necesario para agrupar productos en el menú
const productCategorySchema = new Table({
  // tenantId se omite — PowerSync lo filtra por bucket (ya está garantizado)
  name:          column.text,
  description:   column.text,
  display_order: column.integer,
  is_active:     column.integer,  // boolean como 0/1 en SQLite
}, { indexes: { display_order: ['display_order'] } })

// ── Product ───────────────────────────────────────────────────────────────────
// Catálogo completo para crear pedidos offline
const productSchema = new Table({
  category_id:          column.text,
  name:                 column.text,
  description:          column.text,
  sale_price:           column.real,   // Decimal → real en SQLite (centavos de precisión suficiente)
  current_average_cost: column.real,
  unit:                 column.text,
  is_active:            column.integer,
  updated_at:           column.text,   // ISO string — para Last-Write-Wins
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
// La app necesita el businessDayId para crear pedidos y eventos de caja
const businessDaySchema = new Table({
  establishment_id: column.text,
  is_open:          column.integer,
  opened_at:        column.text,   // ISO string
  opened_by:        column.text,   // userId del cajero que abrió
  closed_at:        column.text,
}, {
  indexes: {
    by_establishment: ['establishment_id', 'is_open'],
  },
})

// ── Establishment ─────────────────────────────────────────────────────────────
// Para mostrar el nombre del local en la UI y resolver el businessDayId
const establishmentSchema = new Table({
  code:      column.text,
  name:      column.text,
  address:   column.text,
  phone:     column.text,
  is_active: column.integer,
})

// ── Order ─────────────────────────────────────────────────────────────────────
// El core del sistema — pedidos creados offline
const orderSchema = new Table({
  establishment_id:    column.text,
  point_of_sale_id:    column.text,
  business_day_id:     column.text,
  order_number:        column.text,
  local_sequence:      column.text,   // Clave idempotente del dispositivo
  created_by_user_id:  column.text,
  created_by_device_id: column.text,
  closed_by_user_id:   column.text,
  table_id:            column.text,
  table_alias:         column.text,
  kiosk_turn_number:   column.text,
  status:              column.text,
  payment_method:      column.text,
  print_status:        column.text,
  subtotal:            column.real,
  total_amount:        column.real,
  notes:               column.text,
  created_at:          column.text,
  updated_at:          column.text,  // Para Last-Write-Wins (Instrucciones §1)
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

// Tipo TypeScript inferido del schema para uso en la app
export type Database = (typeof AppSchema)['types']

// =============================================================================
// CONECTOR DE POWERSYNC
// Implementa PowerSyncBackendConnector: fetchCredentials + uploadData
// =============================================================================

class AcontPlusConnector {
  /**
   * fetchCredentials: PowerSync llama a esto periódicamente para renovar
   * el token de sincronización.
   *
   * Flujo:
   *   1. Leer el accessToken del store de auth
   *   2. Llamar al endpoint /auth/powersync-token con ese accessToken
   *   3. Devolver el token de PowerSync
   *
   * Si el accessToken está expirado, el store intentará el refresh automático.
   * Si el refresh falla por 401 (usuario desactivado), el kill switch del
   * auth store ejecutará disconnectAndClear().
   */
  async fetchCredentials() {
    const { accessToken, refreshAccessToken, powerSyncUrl } = useAuthStore.getState()

    // Si no hay token, no podemos sincronizar
    if (!accessToken) {
      return null
    }

    try {
      // Solicitar el token de PowerSync al backend
      const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? ''
      const response = await fetch(`${apiUrl}/auth/powersync-token`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type':  'application/json',
        },
      })

      if (response.status === 401) {
        // El accessToken expiró — intentar refresh silencioso
        const newAccessToken = await refreshAccessToken()
        if (!newAccessToken) {
          // El kill switch ya fue activado por refreshAccessToken()
          return null
        }

        // Reintentar con el nuevo token
        const retryResponse = await fetch(`${apiUrl}/auth/powersync-token`, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${newAccessToken}`,
            'Content-Type':  'application/json',
          },
        })

        if (!retryResponse.ok) return null

        const retryData = await retryResponse.json() as { token: string }
        return {
          endpoint:  powerSyncUrl ?? Constants.expoConfig?.extra?.powerSyncUrl ?? '',
          token:     retryData.token,
        }
      }

      if (!response.ok) return null

      const data = await response.json() as { token: string }
      return {
        endpoint: powerSyncUrl ?? Constants.expoConfig?.extra?.powerSyncUrl ?? '',
        token:    data.token,
      }
    } catch {
      return null
    }
  }

  /**
   * uploadData: PowerSync llama a esto cuando hay escrituras locales pendientes
   * de subir al servidor.
   *
   * En este proyecto las mutaciones van por tRPC directamente (syncOrder,
   * confirmOrder, etc.) — no usamos el mecanismo de upload de PowerSync
   * para escrituras. PowerSync solo lee (download).
   *
   * Si en el futuro se implementa el patrón de upload via PowerSync,
   * este método procesaría los cambios de la cola.
   */
  async uploadData(_database: AbstractPowerSyncDatabase): Promise<void> {
    // Las escrituras van por tRPC, no por PowerSync upload
    // PowerSync actúa como read-only sync en este diseño
    return
  }
}

// =============================================================================
// INSTANCIA GLOBAL DE POWERSYNC
// Singleton — una sola instancia en toda la app
// =============================================================================

export const powerSyncDb = new PowerSyncDatabase({
  schema:    AppSchema,
  database: {
    // Nombre del archivo SQLite en el dispositivo
    dbFilename: 'acontplustpv.db',
  },
})

export const connector = new AcontPlusConnector()

/**
 * Inicializar PowerSync — llamar al arrancar la app (en el root layout).
 * Se conecta al servidor y comienza la sincronización en background.
 */
export async function initPowerSync(): Promise<void> {
  await powerSyncDb.init()
  await powerSyncDb.connect(connector)
}

/**
 * Desconectar y limpiar — el KILL SWITCH.
 * Se llama cuando el servidor devuelve 401 con isActive = false.
 * Borra todos los datos locales del dispositivo.
 */
export async function disconnectAndClear(): Promise<void> {
  await powerSyncDb.disconnectAndClear()
}
