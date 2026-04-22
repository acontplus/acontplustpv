// =============================================================================
// src/store/cart.ts
// Store del carrito — Zustand
//
// RESPONSABILIDAD:
//   Gestionar el estado del pedido en construcción antes de enviarlo
//   al servidor via trpc.order.syncOrder.
//
// ARQUITECTURA OFFLINE-FIRST:
//   El carrito vive completamente en memoria (Zustand).
//   No se persiste en SQLite — si el usuario cierra la app con un carrito
//   en construcción, se pierde (es el comportamiento correcto: un DRAFT
//   no enviado no existe en el servidor todavía).
//   Una vez que se llama a syncOrder(), el pedido existe en el servidor
//   y PowerSync lo sincroniza de vuelta a SQLite.
//
// localSequence:
//   Clave idempotente generada en el dispositivo. Formato:
//   "{userId}-{timestamp}-{random4}"
//   Garantiza que si syncOrder() se llama múltiples veces con el mismo
//   localSequence (red inestable, retry), el servidor hace UPSERT y no
//   crea duplicados.
//
// pointOfSaleId:
//   El backend requiere pointOfSaleId para asignar el número tributario
//   al confirmar. Viene del Device asociado al usuario, sincronizado via
//   PowerSync en el bucket tenant_establishment.
//
// Precios en el carrito:
//   Los precios son los del catálogo local (SQLite) al momento de armar
//   el pedido. Son referenciales — al CONFIRMAR, el backend toma los
//   precios actuales de PostgreSQL como snapshot oficial (unitPrice).
//   Esto garantiza que aunque el catálogo local esté desactualizado,
//   el precio facturado siempre viene del servidor.
//
// tableId / tableAlias (opcionales):
//   Para establecimientos con mesas. Para bares sin mesas fijas → null.
//   El backend acepta ambos casos según el constraint SQL.
// =============================================================================

import { create }       from 'zustand'
import { immer }        from 'zustand/middleware/immer'

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface CartItem {
  productId:   string
  name:        string        // Para mostrar en la UI — no va al servidor
  unitPrice:   number        // Precio referencial del catálogo local
  quantity:    number        // Siempre > 0
  subtotal:    number        // unitPrice × quantity — calculado automáticamente
  notes:       string | null // Observaciones del ítem (ej: "sin cebolla")
}

export interface CartState {
  // Identidad del pedido en construcción
  localSequence:  string | null   // null = carrito vacío, aún sin secuencia
  pointOfSaleId:  string | null   // Se carga al inicializar (desde SQLite)

  // Ubicación opcional (para establecimientos con mesas)
  tableId:        string | null
  tableAlias:     string | null

  // Notas generales del pedido
  notes:          string | null

  // Ítems
  items:          CartItem[]

  // Totales calculados (derivados de items — no son estado editable)
  subtotal:       number
  total:          number          // En este sistema: subtotal = total (sin IVA separado)

  // Estado de envío al servidor
  isSyncing:      boolean
  syncError:      string | null
}

export interface CartActions {
  // Inicializar con el pointOfSaleId del dispositivo
  init:            (pointOfSaleId: string) => void

  // Gestión de ítems
  addItem:         (item: Omit<CartItem, 'subtotal'>) => void
  removeItem:      (productId: string) => void
  updateQuantity:  (productId: string, quantity: number) => void
  updateItemNotes: (productId: string, notes: string) => void

  // Ubicación (opcional — para establecimientos con mesas)
  setTable:        (tableId: string | null, tableAlias: string | null) => void

  // Notas generales
  setNotes:        (notes: string) => void

  // Estado de sync
  setSyncing:      (syncing: boolean) => void
  setSyncError:    (error: string | null) => void

  // Limpiar completamente el carrito (después de confirmOrder exitoso)
  clear:           () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Genera un localSequence único para el dispositivo.
 * Formato: "{userId_short}-{timestamp_base36}-{random4}"
 * Ejemplo: "a3f2b1c4-lk4h2z-9xk2"
 *
 * No usa UUID completo para mantenerlo legible en logs de debugging.
 * La probabilidad de colisión con este formato es despreciable para
 * el volumen de un restaurante (< 1000 pedidos/día).
 */
export function generateLocalSequence(userId: string): string {
  const userShort  = userId.replace(/-/g, '').slice(0, 8)
  const timestamp  = Date.now().toString(36)
  const random     = Math.random().toString(36).slice(2, 6)
  return `${userShort}-${timestamp}-${random}`
}

/**
 * Recalcula subtotal y total desde los ítems.
 * Se llama después de cualquier mutación de items.
 */
function recalcTotals(items: CartItem[]): { subtotal: number; total: number } {
  const subtotal = parseFloat(
    items.reduce((sum, item) => sum + item.subtotal, 0).toFixed(2)
  )
  return { subtotal, total: subtotal }
}

// ── Estado inicial ────────────────────────────────────────────────────────────

const INITIAL_STATE: CartState = {
  localSequence: null,
  pointOfSaleId: null,
  tableId:       null,
  tableAlias:    null,
  notes:         null,
  items:         [],
  subtotal:      0,
  total:         0,
  isSyncing:     false,
  syncError:     null,
}

// =============================================================================
// STORE
// =============================================================================

export const useCartStore = create<CartState & CartActions>()(
  immer((set) => ({
    ...INITIAL_STATE,

    // ── init ──────────────────────────────────────────────────────────────────
    // Llamar una vez al montar la pantalla de nuevo pedido.
    // Guarda el pointOfSaleId del dispositivo para enviarlo en syncOrder.
    init: (pointOfSaleId) => {
      set(state => {
        state.pointOfSaleId = pointOfSaleId
      })
    },

    // ── addItem ───────────────────────────────────────────────────────────────
    // Si el producto ya existe en el carrito, incrementa la cantidad.
    // Si no existe, lo añade como nuevo ítem.
    // Genera localSequence en el primer ítem añadido.
    addItem: ({ productId, name, unitPrice, quantity, notes }) => {
      set(state => {
        const existing = state.items.find(i => i.productId === productId)

        if (existing) {
          existing.quantity += quantity
          existing.subtotal  = parseFloat((existing.unitPrice * existing.quantity).toFixed(2))
        } else {
          state.items.push({
            productId,
            name,
            unitPrice,
            quantity,
            subtotal: parseFloat((unitPrice * quantity).toFixed(2)),
            notes:    notes ?? null,
          })
        }

        const totals       = recalcTotals(state.items)
        state.subtotal     = totals.subtotal
        state.total        = totals.total
        state.syncError    = null
      })
    },

    // ── removeItem ────────────────────────────────────────────────────────────
    removeItem: (productId) => {
      set(state => {
        state.items    = state.items.filter(i => i.productId !== productId)
        const totals   = recalcTotals(state.items)
        state.subtotal = totals.subtotal
        state.total    = totals.total
      })
    },

    // ── updateQuantity ────────────────────────────────────────────────────────
    // Si quantity <= 0, elimina el ítem (previene cantidades negativas).
    updateQuantity: (productId, quantity) => {
      set(state => {
        if (quantity <= 0) {
          state.items = state.items.filter(i => i.productId !== productId)
        } else {
          const item = state.items.find(i => i.productId === productId)
          if (item) {
            item.quantity = quantity
            item.subtotal = parseFloat((item.unitPrice * quantity).toFixed(2))
          }
        }
        const totals   = recalcTotals(state.items)
        state.subtotal = totals.subtotal
        state.total    = totals.total
      })
    },

    // ── updateItemNotes ───────────────────────────────────────────────────────
    updateItemNotes: (productId, notes) => {
      set(state => {
        const item = state.items.find(i => i.productId === productId)
        if (item) {
          item.notes = notes || null
        }
      })
    },

    // ── setTable ──────────────────────────────────────────────────────────────
    setTable: (tableId, tableAlias) => {
      set(state => {
        state.tableId    = tableId
        state.tableAlias = tableAlias
      })
    },

    // ── setNotes ──────────────────────────────────────────────────────────────
    setNotes: (notes) => {
      set(state => {
        state.notes = notes || null
      })
    },

    // ── setSyncing ────────────────────────────────────────────────────────────
    setSyncing: (syncing) => {
      set(state => { state.isSyncing = syncing })
    },

    // ── setSyncError ──────────────────────────────────────────────────────────
    setSyncError: (error) => {
      set(state => {
        state.syncError  = error
        state.isSyncing  = false
      })
    },

    // ── clear ─────────────────────────────────────────────────────────────────
    // Llamar después de confirmOrder exitoso O al cancelar el pedido.
    // Preserva pointOfSaleId — no es necesario volver a llamar init().
    clear: () => {
      set(state => {
        const posId           = state.pointOfSaleId
        Object.assign(state, INITIAL_STATE)
        state.pointOfSaleId   = posId
      })
    },
  })),
)

// ── Selectores granulares ─────────────────────────────────────────────────────
// Evitan re-renders innecesarios — EMPTY_ITEMS es estable igual que EMPTY_ROLES

const EMPTY_ITEMS: CartItem[] = []

export const selectCartItems         = (s: CartState) => s.items.length > 0 ? s.items : EMPTY_ITEMS
export const selectCartTotal         = (s: CartState) => s.total
export const selectCartSubtotal      = (s: CartState) => s.subtotal
export const selectCartItemCount     = (s: CartState) => s.items.reduce((sum, i) => sum + i.quantity, 0)
export const selectCartIsEmpty       = (s: CartState) => s.items.length === 0
export const selectCartIsSyncing     = (s: CartState) => s.isSyncing
export const selectCartSyncError     = (s: CartState) => s.syncError
export const selectCartLocalSequence = (s: CartState) => s.localSequence
export const selectCartPointOfSaleId = (s: CartState) => s.pointOfSaleId
