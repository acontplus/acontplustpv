// =============================================================================
// app/(app)/index.tsx
// Pantalla principal — Lista de pedidos activos (Sprint 3)
//
// MODELO DE NEGOCIO — Bar sin mesas fijas:
//   No hay grilla de mesas. La pantalla principal muestra los pedidos
//   activos de la jornada, filtrados según el rol:
//
//   WAITER:          sus pedidos (PowerSync solo le sincroniza los suyos)
//   BARMAN / ADMIN:  todos los pedidos de la jornada
//   CASHIER:         pedidos en AWAITING_PAYMENT para cobrar
//
// IDENTIFICACIÓN DEL PEDIDO:
//   Sin mesa → identificado por order_number (asignado al confirmar)
//   Con mesa → identificado por table_alias + order_number
//   En DRAFT → identificado por local_sequence (aún sin número definitivo)
//
// ESTADOS VISIBLES:
//   DRAFT            → creado pero no enviado al barman
//   CONFIRMED        → barman lo recibió y está preparando
//   SERVED           → entregado al cliente
//   AWAITING_PAYMENT → cliente quiere pagar
//   CREDIT_REQUESTED → pago por crédito solicitado
//
// FLUJO DE NUEVO PEDIDO — Sprint 4:
//   El botón FAB "+" abre la pantalla de selección de catálogo
//   donde el mesero/barman arma el pedido y lo confirma.
// =============================================================================

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  Alert,
}                                    from 'react-native'
import { StatusBar }                 from 'expo-status-bar'
import { useQuery, useStatus }       from '@powersync/react'

import { useBusinessDay }            from '../../src/hooks/useBusinessDay'
import { useNewOrder }               from '../../src/hooks/useNewOrder'
import {
  useAuthStore,
  selectUser,
  selectRoles,
  selectBusinessDayId,
}                                    from '../../src/store/auth'
// =============================================================================
// TIPOS
// =============================================================================

interface OrderRow {
  id:                  string
  order_number:        string | null
  local_sequence:      string
  status:              string
  print_status:        string
  table_alias:         string | null
  total_amount:        number
  notes:               string | null
  created_at:          string
  updated_at:          string
  created_by_user_id:  string | null
  item_count:          number
}

// =============================================================================
// HELPERS VISUALES
// =============================================================================

const STATUS_CONFIG: Record<string, {
  label:   string
  bg:      string
  border:  string
  badge:   string
  text:    string
}> = {
  DRAFT: {
    label:  'Borrador',
    bg:     'bg-slate-800',
    border: 'border-slate-600',
    badge:  'bg-slate-600',
    text:   'text-slate-300',
  },
  CONFIRMED: {
    label:  'En preparación',
    bg:     'bg-blue-900/40',
    border: 'border-blue-700/60',
    badge:  'bg-blue-600',
    text:   'text-blue-200',
  },
  SERVED: {
    label:  'Entregado',
    bg:     'bg-emerald-900/40',
    border: 'border-emerald-700/60',
    badge:  'bg-emerald-600',
    text:   'text-emerald-200',
  },
  AWAITING_PAYMENT: {
    label:  'Por cobrar',
    bg:     'bg-amber-900/40',
    border: 'border-amber-700/60',
    badge:  'bg-amber-500',
    text:   'text-amber-200',
  },
  CREDIT_REQUESTED: {
    label:  'Crédito solicitado',
    bg:     'bg-purple-900/40',
    border: 'border-purple-700/60',
    badge:  'bg-purple-600',
    text:   'text-purple-200',
  },
}

function getStatusConfig(status: string) {
  return STATUS_CONFIG[status] ?? STATUS_CONFIG['DRAFT']!
}

// Hora formateada desde ISO string
function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('es-EC', {
      hour:   '2-digit',
      minute: '2-digit',
      timeZone: 'America/Guayaquil',
    })
  } catch {
    return '—'
  }
}

// =============================================================================
// HOOK: pedidos activos desde PowerSync SQLite
// =============================================================================

const ACTIVE_STATUSES = `'DRAFT','CONFIRMED','SERVED','AWAITING_PAYMENT','CREDIT_REQUESTED'`

function useActiveOrders(businessDayId: string | null, userId: string | null, isWaiter: boolean) {
  // WAITER: solo sus pedidos (PowerSync ya filtra por sync-rules,
  //         pero filtramos también en SQLite por seguridad y rendimiento)
  // BARMAN/CASHIER/ADMIN: todos los pedidos de la jornada activa
  const sql = isWaiter
    ? `SELECT
         o.id, o.order_number, o.local_sequence, o.status, o.print_status,
         o.table_alias, o.total_amount, o.notes, o.created_at, o.updated_at,
         o.created_by_user_id,
         COUNT(oi.id) AS item_count
       FROM "Order" o
       LEFT JOIN "OrderItem" oi ON oi.order_id = o.id
       WHERE o.business_day_id = ?
         AND o.created_by_user_id = ?
         AND o.status IN (${ACTIVE_STATUSES})
       GROUP BY o.id
       ORDER BY o.created_at DESC`
    : `SELECT
         o.id, o.order_number, o.local_sequence, o.status, o.print_status,
         o.table_alias, o.total_amount, o.notes, o.created_at, o.updated_at,
         o.created_by_user_id,
         COUNT(oi.id) AS item_count
       FROM "Order" o
       LEFT JOIN "OrderItem" oi ON oi.order_id = o.id
       WHERE o.business_day_id = ?
         AND o.status IN (${ACTIVE_STATUSES})
       GROUP BY o.id
       ORDER BY
         CASE o.status
           WHEN 'AWAITING_PAYMENT' THEN 1
           WHEN 'CONFIRMED'        THEN 2
           WHEN 'SERVED'           THEN 3
           WHEN 'DRAFT'            THEN 4
           ELSE 5
         END,
         o.created_at ASC`

  const params = isWaiter
    ? [businessDayId ?? '', userId ?? '']
    : [businessDayId ?? '']

  const { data, isLoading } = useQuery<OrderRow>(sql, params)

  return { orders: data ?? [], isLoading }
}

// =============================================================================
// BADGE DE SYNC — useStatus(): misma fuente que useQuery / PowerSyncContext
// =============================================================================

function SyncBadge() {
  const ps = useStatus()
  const downloading = ps.dataFlowStatus?.downloading === true
  const uploading   = ps.dataFlowStatus?.uploading === true
  const syncing     = downloading || uploading
  const handshake   = ps.connecting === true
  const flowErr     =
    ps.dataFlowStatus?.downloadError ?? ps.dataFlowStatus?.uploadError

  useEffect(() => {
    if (__DEV__ && flowErr != null) {
      console.warn('[PowerSync][dataFlow error]', flowErr.message ?? String(flowErr))
    }
  }, [flowErr])

  const showLive = ps.connected === true || handshake || syncing

  useEffect(() => {
    if (__DEV__) {
      console.log('[Badge][useStatus]', {
        connected:  ps.connected,
        connecting: ps.connecting,
        downloading,
        uploading,
        hasSynced:  ps.hasSynced,
        err:        flowErr?.message ?? null,
      })
    }
  }, [ps.connected, ps.connecting, downloading, uploading, ps.hasSynced, flowErr])

  if (ps.connected === true && !syncing && !flowErr) {
    return (
      <View className="flex-row items-center gap-1 bg-emerald-500/20 px-2 py-1 rounded-full">
        <View className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <Text className="text-emerald-400 text-xs">Sync</Text>
      </View>
    )
  }

  if (showLive) {
    return (
      <View className="flex-row items-center gap-1 bg-blue-500/20 px-2 py-1 rounded-full">
        <ActivityIndicator size={8} color="#60a5fa" />
        <Text className="text-blue-400 text-xs">Sync...</Text>
      </View>
    )
  }

  return (
    <View className="flex-row items-center gap-1 bg-slate-700 px-2 py-1 rounded-full">
      <View className="w-1.5 h-1.5 rounded-full bg-slate-500" />
      <Text className="text-slate-400 text-xs">Sin red</Text>
    </View>
  )
}

// =============================================================================
// COMPONENTE: Tarjeta de pedido
// =============================================================================

interface OrderCardProps {
  order:   OrderRow
  onPress: (order: OrderRow) => void
}

function OrderCard({ order, onPress }: OrderCardProps) {
  const cfg = getStatusConfig(order.status)

  // Identificador visible: número de pedido si existe, si no el local_sequence
  const displayId = order.order_number
    ? `#${order.order_number}`
    : `~${order.local_sequence.slice(-6).toUpperCase()}`

  return (
    <TouchableOpacity
      onPress={() => onPress(order)}
      className={`rounded-2xl p-4 border mb-3 ${cfg.bg} ${cfg.border}`}
      activeOpacity={0.75}
    >
      <View className="flex-row items-start justify-between mb-2">
        {/* Identificador + mesa */}
        <View>
          <Text className={`text-xl font-bold ${cfg.text}`}>
            {displayId}
          </Text>
          {order.table_alias ? (
            <Text className={`text-xs mt-0.5 ${cfg.text} opacity-70`}>
              Mesa: {order.table_alias}
            </Text>
          ) : null}
        </View>

        {/* Badge de estado */}
        <View className={`px-2.5 py-1 rounded-full ${cfg.badge}`}>
          <Text className="text-white text-xs font-semibold">
            {cfg.label}
          </Text>
        </View>
      </View>

      <View className="flex-row items-center justify-between mt-1">
        {/* Items y total */}
        <Text className={`text-sm ${cfg.text} opacity-60`}>
          {order.item_count} {order.item_count === 1 ? 'ítem' : 'ítems'}
        </Text>
        <Text className={`text-base font-bold ${cfg.text}`}>
          ${Number(order.total_amount).toFixed(2)}
        </Text>
      </View>

      {/* Hora y notas */}
      <View className="flex-row items-center justify-between mt-1.5">
        <Text className={`text-xs ${cfg.text} opacity-40`}>
          {formatTime(order.created_at)}
        </Text>
        {order.notes ? (
          <Text className={`text-xs ${cfg.text} opacity-50`} numberOfLines={1}>
            📝 {order.notes}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  )
}

// =============================================================================
// PANTALLA PRINCIPAL
// =============================================================================

export default function OrdersScreen() {
  const user          = useAuthStore(selectUser)
  const roles         = useAuthStore(selectRoles)
  const businessDayId = useAuthStore(selectBusinessDayId)

  // Sincroniza businessDayId al store automáticamente
  useBusinessDay()
  const {
    startNewOrder,
    canStartOrder,
    isLoading: isEstablishmentLoading,
  } = useNewOrder()

  const isWaiter   = roles.includes('WAITER') && !roles.includes('ADMIN') && !roles.includes('CASHIER') && !roles.includes('BARMAN')
  const isCashier  = roles.some(r => r === 'ADMIN' || r === 'CASHIER')

  const { orders, isLoading } = useActiveOrders(
    businessDayId,
    user?.id ?? null,
    isWaiter,
  )

  const [refreshing, setRefreshing] = useState(false)

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    await new Promise(r => setTimeout(r, 600))
    setRefreshing(false)
  }, [])

  const handleOrderPress = useCallback((order: OrderRow) => {
    // Sprint 4: navegar a detalle/acciones del pedido
    Alert.alert(
      order.order_number ? `Pedido #${order.order_number}` : 'Pedido en borrador',
      `Estado: ${getStatusConfig(order.status).label}\nTotal: $${Number(order.total_amount).toFixed(2)}`,
      [{ text: 'Cerrar' }],
    )
  }, [])

  // Contadores por estado para el header
  const awaitingCount  = orders.filter(o => o.status === 'AWAITING_PAYMENT').length
  const confirmedCount = orders.filter(o => o.status === 'CONFIRMED').length

  return (
    <View className="flex-1 bg-slate-900">
      <StatusBar style="light" />

      {/* Header */}
      <View className="px-6 pt-14 pb-3 bg-slate-800 border-b border-slate-700">
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-white text-xl font-bold">Pedidos</Text>
            <Text className="text-slate-400 text-xs mt-0.5">
              {user?.name ?? ''}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <SyncBadge />
          </View>
        </View>

        {/* Métricas */}
        {orders.length > 0 && (
          <View className="flex-row gap-4 mt-3">
            <Text className="text-slate-400 text-xs">
              <Text className="text-white font-bold">{orders.length}</Text> activos
            </Text>
            {confirmedCount > 0 && (
              <Text className="text-slate-400 text-xs">
                <Text className="text-blue-400 font-bold">{confirmedCount}</Text> en preparación
              </Text>
            )}
            {awaitingCount > 0 && (
              <Text className="text-slate-400 text-xs">
                <Text className="text-amber-400 font-bold">{awaitingCount}</Text> por cobrar
              </Text>
            )}
          </View>
        )}
      </View>

      {/* Aviso sin jornada para CASHIER/ADMIN */}
      {!businessDayId && isCashier && (
        <View className="mx-4 mt-4 p-3 bg-amber-900/30 rounded-xl border border-amber-700/50 flex-row items-center gap-2">
          <Text className="text-amber-400">⚠️</Text>
          <Text className="text-amber-300 text-xs flex-1">
            Sin jornada activa. Ve a "Jornada" para abrirla.
          </Text>
        </View>
      )}

      {/* Lista */}
      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text className="text-slate-400 text-sm mt-3">Cargando pedidos...</Text>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={o => o.id}
          renderItem={({ item }) => (
            <OrderCard order={item} onPress={handleOrderPress} />
          )}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor="#3b82f6"
            />
          }
          ListEmptyComponent={
            <View className="items-center py-16">
              <Text className="text-4xl mb-4">📋</Text>
              <Text className="text-white text-lg font-bold mb-2">
                Sin pedidos activos
              </Text>
              <Text className="text-slate-400 text-sm text-center">
                {businessDayId
                  ? 'Crea un nuevo pedido con el botón +'
                  : 'Abre la jornada para comenzar a operar'}
              </Text>
            </View>
          }
        />
      )}

      {/* FAB — Nuevo pedido */}
      {businessDayId && (
        <TouchableOpacity
          onPress={startNewOrder}
          disabled={!canStartOrder || isEstablishmentLoading}
          className={`absolute bottom-8 right-6 w-14 h-14 rounded-full items-center justify-center shadow-lg ${
            canStartOrder && !isEstablishmentLoading
              ? 'bg-blue-600 active:bg-blue-700'
              : 'bg-slate-600'
          }`}
          style={{ elevation: 6 }}
        >
          {isEstablishmentLoading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text className="text-white text-3xl font-light leading-none">+</Text>
          )}
        </TouchableOpacity>
      )}
    </View>
  )
}
