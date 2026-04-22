// =============================================================================
// src/hooks/useBusinessDay.ts
// Hook reactivo de jornada activa — PowerSync SQLite → Zustand
//
// RESPONSABILIDAD:
//   Leer la jornada activa (is_open = 1) del SQLite local via PowerSync
//   y mantener sincronizado el businessDayId en el auth store de Zustand.
//
// FLUJO COMPLETO:
//   1. PowerSync sincroniza BusinessDay desde el servidor en background
//   2. Este hook observa la tabla BusinessDay en SQLite con useQuery
//   3. Cuando cambia (jornada abierta/cerrada), actualiza setBusinessDayId
//   4. El Guard en app/(app)/_layout.tsx reacciona al businessDayId del store
//   5. WAITER/BARMAN ven la pantalla de "Jornada cerrada" o acceden a la app
//
// POR QUÉ SQLITE Y NO tRPC:
//   La app es Offline-First. Consultar businessDay.status por tRPC requiere
//   conexión al servidor. Leer de SQLite funciona sin internet y es
//   instantáneo — los datos llegan vía PowerSync cuando hay conexión.
//
// POR QUÉ useQuery DE POWERSYNC Y NO usePowerSyncQuery:
//   useQuery de @powersync/react es el hook moderno (no deprecated).
//   usePowerSyncQuery está marcado como deprecated en la versión instalada.
//
// SINCRONIZACIÓN CON EL STORE:
//   useEffect observa el resultado de la query. Cuando PowerSync sincroniza
//   una jornada nueva (el admin la abrió), businessDay cambia → el efecto
//   llama setBusinessDayId → el Guard desbloquea la UI automáticamente.
//   Sin necesidad de polling ni reconexión manual.
// =============================================================================

import { useEffect }           from 'react'
import { useQuery }            from '@powersync/react'
import {
  useAuthStore,
  selectUser,
}                              from '../store/auth'

// Tipo de fila que devuelve la query SQLite
interface BusinessDayRow {
  id:               string
  establishment_id: string
  is_open:          number   // 0 | 1 — SQLite no tiene boolean nativo
  opened_at:        string
  opened_by:        string
  closed_at:        string | null
}

// =============================================================================
// HOOK PRINCIPAL
// =============================================================================

export function useBusinessDay() {
  const user            = useAuthStore(selectUser)
  const setBusinessDayId = useAuthStore(s => s.setBusinessDayId)
  const businessDayId   = useAuthStore(s => s.businessDayId)

  // ── Query reactiva a SQLite ────────────────────────────────────────────────
  // useQuery de PowerSync se re-ejecuta automáticamente cuando la tabla
  // BusinessDay cambia en SQLite (nueva sincronización del servidor).
  // El parámetro [establishmentId] evita re-crear la query en cada render.
  const { data: rows, isLoading } = useQuery<BusinessDayRow>(
    `SELECT id, establishment_id, is_open, opened_at, opened_by, closed_at
     FROM BusinessDay
     WHERE establishment_id = ?
       AND is_open = 1
     LIMIT 1`,
    [user?.establishmentId ?? ''],
  )

  // ── Sincronizar con el store de Zustand ───────────────────────────────────
  // Cada vez que PowerSync actualiza BusinessDay en SQLite, rows cambia.
  // Este efecto propaga el cambio al store para que el Guard reaccione.
  useEffect(() => {
    if (!user?.establishmentId) return

    const activeDay = rows?.[0] ?? null

    if (activeDay && activeDay.is_open === 1) {
      // Jornada abierta — actualizar businessDayId si cambió
      if (businessDayId !== activeDay.id) {
        setBusinessDayId(activeDay.id)
      }
    } else {
      // Sin jornada activa — limpiar businessDayId
      if (businessDayId !== null) {
        setBusinessDayId(null)
      }
    }
  }, [rows, user?.establishmentId, businessDayId, setBusinessDayId])

  // ── Valor de retorno ──────────────────────────────────────────────────────
  const activeDay = rows?.[0] ?? null

  return {
    // La jornada activa o null si está cerrada
    businessDay:    activeDay,

    // true mientras PowerSync no haya completado la primera carga
    isLoading,

    // Conveniencias derivadas
    isOpen:         activeDay?.is_open === 1,
    businessDayId:  activeDay?.id ?? null,
    openedAt:       activeDay?.opened_at ?? null,
  }
}
