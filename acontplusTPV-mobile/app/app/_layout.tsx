// =============================================================================
// app/(app)/_layout.tsx
// App Layout — Auth Guard + Tabs condicionales por rol
//
// DOBLE GUARD (dos condiciones para operar):
//   1. isAuthenticated  → ¿hay sesión válida?
//      Si no → redirect a /(auth)/login
//
//   2. businessDayId    → ¿hay jornada abierta?
//      Si no → pantalla de bloqueo "Jornada cerrada"
//      (no redirect — la app debe mantenerse en primer plano para cuando
//       el admin abra la jornada y PowerSync sincronice el businessDayId)
//
// Por qué el guard de jornada NO hace redirect:
//   El documento maestro establece que el servidor rechaza transacciones
//   con businessDayId de jornadas cerradas. Si el mesero no tiene jornada
//   activa, no puede crear pedidos de ningún modo. La pantalla de bloqueo
//   es el UX correcto: el mesero espera hasta que el admin (CASHIER/ADMIN)
//   abra la jornada desde su dispositivo. PowerSync sincronizará el nuevo
//   businessDayId automáticamente y el Guard desbloqueará la UI.
//
// TABS CONDICIONALES POR ROL:
//   La estructura de tabs se adapta al rol del usuario logueado.
//   Esto evita tener que refactorizar _layout.tsx en el Sprint 3
//   cuando lleguen los flujos de CASHIER y ADMIN.
//
//   WAITER:           [Mesas, Perfil]
//   CASHIER / BARMAN: [Pedidos, Caja, Perfil]
//   ADMIN:            [Mesas, Pedidos, Caja, Jornada, Perfil]
//
// Por qué tabs y no Stack:
//   Los roles operan en paralelo (el cajero necesita ver pedidos Y caja
//   al mismo tiempo). Los tabs son el patrón correcto para acceso paralelo
//   a módulos independientes. El Stack se usa dentro de cada tab para la
//   navegación profunda (Mesa → Pedido → Confirmación).
// =============================================================================

import { Redirect, Tabs }        from 'expo-router'
import { View, Text, ActivityIndicator } from 'react-native'

import {
  useAuthStore,
  selectIsAuthenticated,
  selectRoles,
  selectBusinessDayId,
  selectUser,
}                                from '../../src/store/auth'

// =============================================================================
// PANTALLA DE BLOQUEO — jornada cerrada
// Se muestra cuando el usuario está autenticado pero no hay jornada abierta.
// No es una ruta — es un componente inline para mantener el árbol de providers.
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

      {/* Indicador de sincronización activa */}
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
// COMPONENTE DE TABS — configuración condicional por rol
// =============================================================================

function AppTabs() {
  const roles = useAuthStore(selectRoles)

  // Derivar capacidades desde los roles — una sola lectura del store
  const isAdmin   = roles.includes('ADMIN')
  const isCashier = roles.some(r => r === 'ADMIN' || r === 'CASHIER' || r === 'BARMAN')
  const isWaiter  = roles.includes('WAITER')

  // Todos los usuarios ven al menos el tab de Mesas o Pedidos según su rol.
  // El tab de Perfil es universal.

  return (
    <Tabs
      screenOptions={{
        headerShown:          false,
        tabBarStyle: {
          backgroundColor:    '#1e293b',  // slate-800
          borderTopColor:     '#334155',  // slate-700
          borderTopWidth:     1,
        },
        tabBarActiveTintColor:   '#3b82f6',  // blue-500
        tabBarInactiveTintColor: '#64748b',  // slate-500
        tabBarLabelStyle: {
          fontSize:   11,
          fontWeight: '600',
        },
      }}
    >
      {/* ── Tab: Mesas — visible para WAITER y ADMIN ── */}
      <Tabs.Screen
        name="index"
        options={{
          title:     'Mesas',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>🪑</Text>
          ),
          // CASHIER/BARMAN sin rol ADMIN no necesitan la vista de mesas
          // (ellos cobran, no toman pedidos de mesa directamente)
          href: isAdmin || isWaiter ? undefined : null,
        }}
      />

      {/* ── Tab: Pedidos — visible para CASHIER, BARMAN y ADMIN ── */}
      <Tabs.Screen
        name="orders"
        options={{
          title:     'Pedidos',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>📋</Text>
          ),
          href: isCashier ? undefined : null,
        }}
      />

      {/* ── Tab: Caja — visible para CASHIER y ADMIN ── */}
      <Tabs.Screen
        name="cashier"
        options={{
          title:     'Caja',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>💰</Text>
          ),
          // Solo CASHIER (incluye ADMIN) — BARMAN no maneja caja directamente
          href: roles.some(r => r === 'ADMIN' || r === 'CASHIER') ? undefined : null,
        }}
      />

      {/* ── Tab: Jornada — solo ADMIN ── */}
      <Tabs.Screen
        name="business-day"
        options={{
          title:     'Jornada',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>📅</Text>
          ),
          href: isAdmin ? undefined : null,
        }}
      />

      {/* ── Tab: Perfil — universal ── */}
      <Tabs.Screen
        name="profile"
        options={{
          title:     'Perfil',
          tabBarIcon: ({ color }) => (
            <Text style={{ color, fontSize: 20 }}>👤</Text>
          ),
        }}
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

  // ── Guard 1: autenticación ────────────────────────────────────────────────
  // Si no hay sesión, mandar al login. Expo Router Redirect es declarativo:
  // no hay historial de navegación que limpiar, el usuario simplemente
  // no puede acceder a ninguna ruta bajo /(app)/.
  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />
  }

  // ── Guard 2: jornada activa ───────────────────────────────────────────────
  // ADMIN y CASHIER pueden operar sin jornada (ellos son quienes la abren).
  // WAITER y BARMAN necesitan jornada activa para crear pedidos.
  //
  // Si es ADMIN o CASHIER → dejarlo pasar para que pueda abrir la jornada.
  // Si es WAITER o BARMAN sin jornada → mostrar pantalla de bloqueo.
  const canOpenDay = roles.some(r => r === 'ADMIN' || r === 'CASHIER')

  if (!businessDayId && !canOpenDay) {
    return <JornadaCerradaScreen />
  }

  // ── Ambos guards superados → renderizar la app ───────────────────────────
  return <AppTabs />
}
