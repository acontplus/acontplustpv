// =============================================================================
// src/hooks/useTables.ts
// Hook reactivo de mesas — PowerSync SQLite
//
// Lee las mesas del establecimiento del usuario autenticado.
// Los datos llegan via PowerSync (bucket tenant_catalog en sync-rules.yaml).
//
// ESTADO DE MESA:
//   SQLite solo tiene el estado estático de la mesa (número, alias, capacidad).
//   El estado dinámico (si tiene pedido activo, quién la atiende) se calcula
//   en tiempo de query haciendo JOIN con la tabla Order.
//
//   Mesa "ocupada" = tiene al menos un Order en estado activo:
//   DRAFT | CONFIRMED | SERVED | AWAITING_PAYMENT
// =============================================================================

import { useQuery }     from '@powersync/react'
import { useAuthStore, selectUser } from '../store/auth'

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface TableRow {
  id:               string
  establishment_id: string
  number:           number
  alias:            string | null
  capacity:         number
  is_active:        number  // 0 | 1
}

export interface TableWithStatus extends TableRow {
  // Estado dinámico calculado via JOIN con Order
  active_order_id:     string | null
  active_order_status: string | null
  waiter_user_id:      string | null
}

// Estados de pedido que indican mesa ocupada
const ACTIVE_ORDER_STATUSES = [
  'DRAFT',
  'CONFIRMED',
  'SERVED',
  'AWAITING_PAYMENT',
  'CREDIT_REQUESTED',
].map(s => `'${s}'`).join(', ')

// =============================================================================
// HOOK PRINCIPAL
// =============================================================================

export function useTables() {
  const user          = useAuthStore(selectUser)
  const establishmentId = user?.establishmentId ?? ''

  // Query con LEFT JOIN a Order para detectar mesas ocupadas
  // Solo mesas activas del establecimiento del usuario autenticado
  const { data, isLoading, error } = useQuery<TableWithStatus>(
    `SELECT
       t.id,
       t.establishment_id,
       t.number,
       t.alias,
       t.capacity,
       t.is_active,
       o.id           AS active_order_id,
       o.status       AS active_order_status,
       o.created_by_user_id AS waiter_user_id
     FROM "Table" t
     LEFT JOIN "Order" o
       ON o.table_id = t.id
      AND o.status IN (${ACTIVE_ORDER_STATUSES})
     WHERE t.establishment_id = ?
       AND t.is_active = 1
     ORDER BY t.number ASC`,
    [establishmentId],
  )

  // Derivar métricas útiles para la UI
  const tables       = data ?? []
  const occupied     = tables.filter(t => t.active_order_id !== null)
  const available    = tables.filter(t => t.active_order_id === null)

  return {
    tables,
    isLoading,
    error,

    // Métricas para el header de la grilla
    totalTables:     tables.length,
    occupiedCount:   occupied.length,
    availableCount:  available.length,
  }
}
