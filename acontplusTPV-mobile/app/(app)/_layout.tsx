// =============================================================================
// app/(app)/_layout.tsx
// App Layout — Auth Guard + Tabs condicionales por rol
//
// DOBLE GUARD:
//   1. isAuthenticated  → Si no → redirect a /(auth)/login
//   2. businessDayId    → Si no (WAITER/BARMAN) → pantalla de bloqueo
//
// TABS POR ROL — modelo bar sin mesas fijas:
//   WAITER:           [Pedidos, Perfil]
//   BARMAN:           [Pedidos, Perfil]
//   CASHIER:          [Pedidos, Caja, Perfil]
//   ADMIN:            [Pedidos, Caja, Jornada, Perfil]
//
// "Pedidos" es la pantalla principal para TODOS los roles:
//   - WAITER ve sus pedidos activos + botón de nuevo pedido
//   - BARMAN ve todos los pedidos de la jornada + confirmar despacho
//   - CASHIER ve pedidos en AWAITING_PAYMENT para cobrar
// =============================================================================

import { Redirect, Tabs }                    from 'expo-router'
import { View, Text, ActivityIndicator }     from 'react-native'

import {
  useAuthStore,
  selectIsAuthenticated,
  selectRoles,
  selectBusinessDayId,
  selectUser,
}                                            from '../../src/store/auth'

// =============================================================================
// PANTALLA DE BLOQUEO — jornada cerrada
// =============================================================================

function JornadaCerradaScreen() {
  const user = useAuthStore(selectUser)

  return (
    <View className="flex-1 bg-slate-900 items-center justify-center px-8">
      <View className="w-20 h-20 bg-slate-700 rounded-full items-center justify-center mb-6">
        <Text className="text-4xl">🔒</Text>
      </View>

      <Text className="text-white text-2xl font-bold text-center mb-3">
        Jornada cerrada
      </Text>

      <Text className="text-slate-400 text-base text-center leading-6 mb-8">
        No hay una jornada activa en este establecimiento.
        Espera a que el administrador o cajero abra la jornada.
      </Text>

      <View className="flex-row items-center gap-2 bg-slate-800 px-4 py-3 rounded-xl">
        <ActivityIndicator size="small" color="#64748b" />
        <Text className="text-slate-400 text-sm">
          Sincronizando con el servidor...
        </Text>
      </View>

      {user && (
        <Text className="text-slate-600 text-xs mt-8">
          Sesión activa: {user.name}
        </Text>
      )}
    </View>
  )
}

// =============================================================================
// TABS
// =============================================================================

function AppTabs() {
  const roles = useAuthStore(selectRoles)

  const isAdmin   = roles.includes('ADMIN')
  const isCashier = roles.some(r => r === 'ADMIN' || r === 'CASHIER')

  return (
    <Tabs
      screenOptions={{
        headerShown:            false,
        tabBarStyle: {
          backgroundColor:      '#1e293b',
          borderTopColor:       '#334155',
          borderTopWidth:       1,
        },
        tabBarActiveTintColor:   '#3b82f6',
        tabBarInactiveTintColor: '#64748b',
        tabBarLabelStyle: {
          fontSize:   11,
          fontWeight: '600',
        },
      }}
    >
      {/* ── Pedidos — todos los roles ── */}
      <Tabs.Screen
        name="index"
        options={{
          title: 'Pedidos',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>📋</Text>
          ),
        }}
      />

      {/* ── Caja — CASHIER y ADMIN ── */}
      <Tabs.Screen
        name="cashier"
        options={{
          title: 'Caja',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>💰</Text>
          ),
          href: isCashier ? undefined : null,
        }}
      />

      {/* ── Jornada — solo ADMIN ── */}
      <Tabs.Screen
        name="business-day"
        options={{
          title: 'Jornada',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>📅</Text>
          ),
          href: isAdmin ? undefined : null,
        }}
      />

      {/* ── Perfil — universal ── */}
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Perfil',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>👤</Text>
          ),
        }}
      />

      {/* Rutas sin tab — accesibles por navegación pero no visibles en la barra */}
      <Tabs.Screen
        name="orders"
        options={{ href: null }}
      />
      <Tabs.Screen
        name="new-order"
        options={{ href: null }}
      />
    </Tabs>
  )
}

// =============================================================================
// GUARD PRINCIPAL
// =============================================================================

export default function AppLayout() {
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const businessDayId   = useAuthStore(selectBusinessDayId)
  const roles           = useAuthStore(selectRoles)

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />
  }

  const canOpenDay = roles.some(r => r === 'ADMIN' || r === 'CASHIER')

  if (!businessDayId && !canOpenDay) {
    return <JornadaCerradaScreen />
  }

  return <AppTabs />
}
