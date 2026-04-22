// =============================================================================
// src/screens/NewOrderScreen.tsx
// Pantalla de Nuevo Pedido — layout responsivo móvil / tablet
//
// LAYOUT RESPONSIVO:
//   Móvil  (ancho < 768px): catálogo full-screen + FAB que abre CartSheet
//   Tablet (ancho ≥ 768px): split-view 65/35 — catálogo | carrito fijo
//
//   El breakpoint de 768px cubre:
//   - Phones en portrait/landscape → móvil
//   - Tablets de 10" en portrait → tablet
//   - Tablets fijas en la barra en landscape → tablet
//
// FLUJO COMPLETO DEL PEDIDO:
//   1. Usuario selecciona productos → useCartStore.addItem()
//   2. Pulsa "Enviar al barman" → syncOrder() vía tRPC
//      → status DRAFT en el servidor
//      → PowerSync sincroniza al barman
//   3. Barman confirma despacho → confirmOrder() vía tRPC (pantalla del barman)
//      → status CONFIRMED + printStatus PENDING
//   4. Mesero pulsa "Pedir cuenta" → requestPayment() vía tRPC
//      → status AWAITING_PAYMENT
//
// pointOfSaleId:
//   Se lee de SQLite (tabla PointOfSale sincronizada via PowerSync).
//   El dispositivo tiene exactamente un PointOfSale asignado.
//   Se pasa al carrito vía useCartStore.init() al montar la pantalla.
//
// localSequence:
//   Se genera al enviar (no al abrir el carrito) para evitar localSequences
//   huérfanos si el usuario abre y cierra la pantalla sin enviar.
// =============================================================================

import {
  useState,
  useEffect,
  useCallback,
  useRef,
}                                    from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  FlatList,
  TextInput,
  ScrollView,
  useWindowDimensions,
  ActivityIndicator,
  Modal,
  Alert,
  KeyboardAvoidingView,
  Platform,
}                                    from 'react-native'
import { useQuery }                  from '@powersync/react'
import { useRouter }                 from 'expo-router'

import {
  useCartStore,
  selectCartItems,
  selectCartTotal,
  selectCartItemCount,
  selectCartIsEmpty,
  selectCartIsSyncing,
  selectCartSyncError,
  generateLocalSequence,
}                                    from '../store/cart'
import { useCatalog }                from '../hooks/useCatalog'
import type { ProductWithCategory }  from '../hooks/useCatalog'
import {
  useAuthStore,
  selectUser,
  selectBusinessDayId,
}                                    from '../store/auth'
import { trpc }                      from '../lib/trpc'

// =============================================================================
// BREAKPOINT
// =============================================================================

const TABLET_BREAKPOINT = 768

// =============================================================================
// HOOK: PointOfSaleId del dispositivo desde SQLite
// =============================================================================

interface PosRow { id: string; name: string }

function usePointOfSaleId(establishmentId: string | undefined) {
  const { data } = useQuery<PosRow>(
    `SELECT id, name FROM PointOfSale WHERE establishment_id = ? AND is_active = 1 LIMIT 1`,
    [establishmentId ?? ''],
  )
  return data?.[0]?.id ?? null
}

// =============================================================================
// COMPONENTE: Tarjeta de producto
// =============================================================================

interface ProductCardProps {
  product:  ProductWithCategory
  quantity: number            // Cantidad actual en el carrito (0 si no está)
  onAdd:    (product: ProductWithCategory) => void
  onRemove: (productId: string) => void
  compact?: boolean           // Modo compacto para tablet
}

function ProductCard({ product, quantity, onAdd, onRemove, compact }: ProductCardProps) {
  return (
    <TouchableOpacity
      onPress={() => onAdd(product)}
      className={`
        bg-slate-800 rounded-xl border border-slate-700 active:bg-slate-700
        ${compact ? 'm-1 p-3' : 'm-1.5 p-4'}
      `}
      style={{ width: compact ? '31%' : '47%' }}
      activeOpacity={0.7}
    >
      {/* Nombre */}
      <Text
        className="text-white font-semibold leading-tight"
        style={{ fontSize: compact ? 12 : 14 }}
        numberOfLines={2}
      >
        {product.name}
      </Text>

      {/* Precio */}
      <Text
        className="text-blue-400 font-bold mt-1"
        style={{ fontSize: compact ? 13 : 15 }}
      >
        ${product.sale_price.toFixed(2)}
      </Text>

      {/* Cantidad en carrito + controles */}
      {quantity > 0 ? (
        <View className="flex-row items-center justify-between mt-2">
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); onRemove(product.id) }}
            className="w-6 h-6 bg-red-700 rounded-full items-center justify-center"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text className="text-white text-sm font-bold leading-none">−</Text>
          </TouchableOpacity>
          <Text className="text-white font-bold text-sm">{quantity}</Text>
          <TouchableOpacity
            onPress={(e) => { e.stopPropagation(); onAdd(product) }}
            className="w-6 h-6 bg-blue-600 rounded-full items-center justify-center"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text className="text-white text-sm font-bold leading-none">+</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View className="mt-2">
          <Text className="text-slate-500 text-xs">Toca para añadir</Text>
        </View>
      )}
    </TouchableOpacity>
  )
}

// =============================================================================
// COMPONENTE: Panel del carrito (reutilizable en sidebar y bottom sheet)
// =============================================================================

interface CartPanelProps {
  onSync:    () => void
  onCancel:  () => void
  compact?:  boolean
}

function CartPanel({ onSync, onCancel, compact }: CartPanelProps) {
  const items      = useCartStore(selectCartItems)
  const total      = useCartStore(selectCartTotal)
  const isEmpty    = useCartStore(selectCartIsEmpty)
  const isSyncing  = useCartStore(selectCartIsSyncing)
  const syncError  = useCartStore(selectCartSyncError)
  const updateQty  = useCartStore(s => s.updateQuantity)
  const removeItem = useCartStore(s => s.removeItem)
  const setNotes   = useCartStore(s => s.setNotes)
  const notes      = useCartStore(s => s.notes)

  return (
    <View className="flex-1 bg-slate-900">
      {/* Header del carrito */}
      <View className={`px-4 ${compact ? 'py-3' : 'py-4'} border-b border-slate-700`}>
        <Text className="text-white font-bold text-base">
          Carrito {items.length > 0 ? `(${items.length})` : ''}
        </Text>
      </View>

      {isEmpty ? (
        <View className="flex-1 items-center justify-center px-4">
          <Text className="text-slate-500 text-sm text-center">
            Selecciona productos del catálogo
          </Text>
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 12 }}>
          {/* Items */}
          {items.map(item => (
            <View
              key={item.productId}
              className="flex-row items-center gap-3 py-2 border-b border-slate-800"
            >
              {/* Nombre y precio unitario */}
              <View className="flex-1">
                <Text className="text-white text-sm font-medium" numberOfLines={1}>
                  {item.name}
                </Text>
                <Text className="text-slate-400 text-xs">
                  ${item.unitPrice.toFixed(2)} c/u
                </Text>
              </View>

              {/* Controles de cantidad */}
              <View className="flex-row items-center gap-2">
                <TouchableOpacity
                  onPress={() => updateQty(item.productId, item.quantity - 1)}
                  className="w-7 h-7 bg-slate-700 rounded-full items-center justify-center"
                >
                  <Text className="text-white text-sm font-bold">−</Text>
                </TouchableOpacity>
                <Text className="text-white font-bold text-sm w-5 text-center">
                  {item.quantity}
                </Text>
                <TouchableOpacity
                  onPress={() => updateQty(item.productId, item.quantity + 1)}
                  className="w-7 h-7 bg-slate-700 rounded-full items-center justify-center"
                >
                  <Text className="text-white text-sm font-bold">+</Text>
                </TouchableOpacity>
              </View>

              {/* Subtotal del ítem */}
              <Text className="text-white font-semibold text-sm w-14 text-right">
                ${item.subtotal.toFixed(2)}
              </Text>
            </View>
          ))}

          {/* Notas del pedido */}
          <View className="mt-4">
            <Text className="text-slate-400 text-xs mb-1">Notas del pedido</Text>
            <View className="bg-slate-800 border border-slate-600 rounded-xl px-3 py-2">
              <TextInput
                value={notes ?? ''}
                onChangeText={setNotes}
                placeholder="Observaciones generales..."
                placeholderTextColor="#64748b"
                multiline
                numberOfLines={2}
                className="text-white text-sm"
              />
            </View>
          </View>
        </ScrollView>
      )}

      {/* Footer con total y acciones */}
      <View className="px-4 py-4 border-t border-slate-700 gap-3">
        {/* Error de sync */}
        {syncError && (
          <Text className="text-red-400 text-xs text-center">{syncError}</Text>
        )}

        {/* Total */}
        <View className="flex-row justify-between items-center">
          <Text className="text-slate-400 font-medium">Total</Text>
          <Text className="text-white text-xl font-bold">${total.toFixed(2)}</Text>
        </View>

        {/* Botón enviar */}
        <TouchableOpacity
          onPress={onSync}
          disabled={isEmpty || isSyncing}
          className={`py-3.5 rounded-xl items-center ${
            isEmpty || isSyncing
              ? 'bg-slate-700'
              : 'bg-blue-600 active:bg-blue-700'
          }`}
        >
          {isSyncing
            ? <ActivityIndicator color="#fff" size="small" />
            : (
              <Text className={`font-bold text-sm ${isEmpty ? 'text-slate-500' : 'text-white'}`}>
                Enviar al barman
              </Text>
            )
          }
        </TouchableOpacity>

        {/* Botón cancelar */}
        <TouchableOpacity
          onPress={onCancel}
          disabled={isSyncing}
          className="py-2 items-center"
        >
          <Text className="text-slate-500 text-sm">Cancelar pedido</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

// =============================================================================
// COMPONENTE: Catálogo con tabs de categoría
// =============================================================================

interface CatalogPanelProps {
  compact?: boolean
}

function CatalogPanel({ compact }: CatalogPanelProps) {
  const { catalog, isLoading } = useCatalog()
  const [activeCatId, setActiveCatId] = useState<string | null>(null)
  const items     = useCartStore(selectCartItems)
  const addItem   = useCartStore(s => s.addItem)
  const removeItem = useCartStore(s => s.removeItem)
  const updateQty  = useCartStore(s => s.updateQuantity)

  // Seleccionar primera categoría por defecto
  useEffect(() => {
    if (catalog.length > 0 && !activeCatId) {
      setActiveCatId(catalog[0]!.id)
    }
  }, [catalog, activeCatId])

  const activeProducts = catalog.find(c => c.id === activeCatId)?.products ?? []

  const getQuantityInCart = useCallback((productId: string) => {
    return items.find(i => i.productId === productId)?.quantity ?? 0
  }, [items])

  const handleAdd = useCallback((product: ProductWithCategory) => {
    addItem({
      productId: product.id,
      name:      product.name,
      unitPrice: product.sale_price,
      quantity:  1,
      notes:     null,
    })
  }, [addItem])

  const handleRemove = useCallback((productId: string) => {
    const qty = getQuantityInCart(productId)
    if (qty <= 1) {
      removeItem(productId)
    } else {
      updateQty(productId, qty - 1)
    }
  }, [getQuantityInCart, removeItem, updateQty])

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" color="#3b82f6" />
        <Text className="text-slate-400 text-sm mt-3">Cargando catálogo...</Text>
      </View>
    )
  }

  return (
    <View className="flex-1">
      {/* Tabs de categoría */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        className="border-b border-slate-700 bg-slate-800"
        contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 6 }}
      >
        {catalog.map(cat => (
          <TouchableOpacity
            key={cat.id}
            onPress={() => setActiveCatId(cat.id)}
            className={`
              px-4 py-2 rounded-full mr-2
              ${activeCatId === cat.id
                ? 'bg-blue-600'
                : 'bg-slate-700 active:bg-slate-600'}
            `}
          >
            <Text
              className={`text-sm font-semibold ${
                activeCatId === cat.id ? 'text-white' : 'text-slate-300'
              }`}
            >
              {cat.name}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Grilla de productos */}
      <FlatList
        key={compact ? 'compact' : 'full'}
        data={activeProducts}
        keyExtractor={p => p.id}
        numColumns={compact ? 3 : 2}
        contentContainerStyle={{ padding: 6 }}
        renderItem={({ item }) => (
          <ProductCard
            product={item}
            quantity={getQuantityInCart(item.id)}
            onAdd={handleAdd}
            onRemove={handleRemove}
            compact={compact}
          />
        )}
        ListEmptyComponent={
          <View className="items-center py-12">
            <Text className="text-slate-500 text-sm">Sin productos en esta categoría</Text>
          </View>
        }
      />
    </View>
  )
}

// =============================================================================
// PANTALLA PRINCIPAL
// =============================================================================

export default function NewOrderScreen() {
  const { width }     = useWindowDimensions()
  const isTablet      = width >= TABLET_BREAKPOINT
  const router        = useRouter()

  const user          = useAuthStore(selectUser)
  const businessDayId = useAuthStore(selectBusinessDayId)

  const pointOfSaleId = usePointOfSaleId(user?.establishmentId)

  const itemCount    = useCartStore(selectCartItemCount)
  const isEmpty      = useCartStore(selectCartIsEmpty)
  const isSyncing    = useCartStore(selectCartIsSyncing)
  const init         = useCartStore(s => s.init)
  const clear        = useCartStore(s => s.clear)
  const setSyncing   = useCartStore(s => s.setSyncing)
  const setSyncError = useCartStore(s => s.setSyncError)
  const cartItems    = useCartStore(selectCartItems)
  const notes        = useCartStore(s => s.notes)
  const tableId      = useCartStore(s => s.tableId)
  const tableAlias   = useCartStore(s => s.tableAlias)

  const [showCart, setShowCart] = useState(false)

  // Inicializar el carrito con el pointOfSaleId del dispositivo
  useEffect(() => {
    if (pointOfSaleId) {
      init(pointOfSaleId)
    }
  }, [pointOfSaleId, init])

  // ── syncOrder via tRPC ─────────────────────────────────────────────────────
  const syncOrderMutation = trpc.order.syncOrder.useMutation()

  const handleSync = useCallback(async () => {
    if (isEmpty || !businessDayId || !pointOfSaleId || !user) return

    setSyncing(true)
    setSyncError(null)

    try {
      // Generar localSequence en el momento del envío (no antes)
      const localSequence = generateLocalSequence(user.id)

      await syncOrderMutation.mutateAsync({
        localSequence,
        pointOfSaleId,
        tableId:    tableId   ?? undefined,
        tableAlias: tableAlias ?? undefined,
        notes:      notes     ?? undefined,
        items: cartItems.map(item => ({
          productId: item.productId,
          quantity:  item.quantity,
          notes:     item.notes ?? undefined,
        })),
      })

      // Éxito — limpiar carrito y volver
      clear()
      setShowCart(false)
      router.back()

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Error al enviar el pedido'
      setSyncError(message)
    }
  }, [
    isEmpty, businessDayId, pointOfSaleId, user,
    cartItems, notes, tableId, tableAlias,
    setSyncing, setSyncError, clear, router, syncOrderMutation,
  ])

  const handleCancel = useCallback(() => {
    if (!isEmpty) {
      Alert.alert(
        'Cancelar pedido',
        '¿Descartar el pedido en construcción?',
        [
          { text: 'No', style: 'cancel' },
          { text: 'Descartar', style: 'destructive', onPress: () => {
            clear()
            router.back()
          }},
        ],
      )
    } else {
      router.back()
    }
  }, [isEmpty, clear, router])

  // ── Sin jornada activa ─────────────────────────────────────────────────────
  if (!businessDayId) {
    return (
      <View className="flex-1 bg-slate-900 items-center justify-center px-6">
        <Text className="text-white text-lg font-bold mb-2">Sin jornada activa</Text>
        <Text className="text-slate-400 text-sm text-center mb-6">
          No hay una jornada abierta. Contacta al administrador.
        </Text>
        <TouchableOpacity onPress={() => router.back()} className="py-3 px-6 bg-slate-700 rounded-xl">
          <Text className="text-white font-semibold">Volver</Text>
        </TouchableOpacity>
      </View>
    )
  }

  // ==========================================================================
  // RENDER: TABLET — Split-view 65/35
  // ==========================================================================

  if (isTablet) {
    return (
      <KeyboardAvoidingView
        className="flex-1 bg-slate-900 flex-row"
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* ── Catálogo — 65% ── */}
        <View style={{ flex: 0.65 }} className="border-r border-slate-700">
          {/* Header */}
          <View className="px-4 pt-12 pb-3 bg-slate-800 border-b border-slate-700 flex-row items-center justify-between">
            <TouchableOpacity onPress={handleCancel} className="py-1 px-3 bg-slate-700 rounded-lg">
              <Text className="text-slate-300 text-sm">← Volver</Text>
            </TouchableOpacity>
            <Text className="text-white font-bold">Nuevo pedido</Text>
            <View className="w-16" />
          </View>

          <CatalogPanel compact />
        </View>

        {/* ── Carrito — 35% ── */}
        <View style={{ flex: 0.35 }}>
          <View className="px-4 pt-12 pb-3 bg-slate-800 border-b border-slate-700">
            <Text className="text-white font-bold text-center">Carrito</Text>
          </View>
          <CartPanel
            onSync={handleSync}
            onCancel={handleCancel}
            compact
          />
        </View>
      </KeyboardAvoidingView>
    )
  }

  // ==========================================================================
  // RENDER: MÓVIL — Catálogo full-screen + FAB + CartSheet modal
  // ==========================================================================

  return (
    <View className="flex-1 bg-slate-900">
      {/* Header */}
      <View className="px-4 pt-12 pb-3 bg-slate-800 border-b border-slate-700 flex-row items-center justify-between">
        <TouchableOpacity onPress={handleCancel} className="py-1 px-3 bg-slate-700 rounded-lg">
          <Text className="text-slate-300 text-sm">← Volver</Text>
        </TouchableOpacity>
        <Text className="text-white font-bold">Nuevo pedido</Text>
        <View className="w-16" />
      </View>

      {/* Catálogo full-screen */}
      <CatalogPanel />

      {/* FAB del carrito — visible solo si hay ítems */}
      {itemCount > 0 && (
        <TouchableOpacity
          onPress={() => setShowCart(true)}
          className="absolute bottom-8 right-6 bg-blue-600 rounded-full px-5 py-3.5 flex-row items-center gap-2 shadow-lg active:bg-blue-700"
          style={{ elevation: 6 }}
        >
          <Text className="text-white text-lg">🛒</Text>
          <Text className="text-white font-bold">{itemCount}</Text>
          <Text className="text-white font-semibold text-sm">Ver carrito</Text>
        </TouchableOpacity>
      )}

      {/* CartSheet — Modal bottom sheet */}
      <Modal
        visible={showCart}
        animationType="slide"
        transparent
        onRequestClose={() => setShowCart(false)}
      >
        <View className="flex-1 justify-end">
          {/* Overlay */}
          <TouchableOpacity
            className="flex-1"
            activeOpacity={1}
            onPress={() => setShowCart(false)}
          />

          {/* Sheet */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ height: '80%' }}
            className="bg-slate-900 rounded-t-3xl border-t border-slate-700 overflow-hidden"
          >
            {/* Handle */}
            <View className="items-center pt-3 pb-1">
              <View className="w-10 h-1 bg-slate-600 rounded-full" />
            </View>

            <CartPanel
              onSync={async () => {
                await handleSync()
                setShowCart(false)
              }}
              onCancel={() => {
                setShowCart(false)
                handleCancel()
              }}
            />
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  )
}
