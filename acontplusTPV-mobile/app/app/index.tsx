// =============================================================================
// app/(app)/index.tsx
// Pantalla principal — Vista de Mesas (Sprint 2: placeholder funcional)
//
// Esta pantalla es el punto de entrada después del login exitoso.
// En Sprint 3 se reemplazará con la grilla real de mesas desde PowerSync.
//
// Lo que hace ahora:
//   - Muestra bienvenida con nombre del usuario y rol
//   - Muestra el estado de sincronización de PowerSync en tiempo real
//   - Expone el botón de logout con limpieza completa (disconnectAndClear)
//
// PowerSync status:
//   usePowerSyncStatus() es el hook oficial del SDK para leer el estado
//   de la conexión en tiempo real. Posibles valores de status.connected:
//     true  → sincronizando activamente con el servidor
//     false → sin conexión (modo offline — datos locales disponibles)
//
// El estado de PowerSync se muestra en un badge persistente en la UI.
// Este badge sobrevivirá al Sprint 3 — es información operativa crítica
// para un restaurante que trabaja offline.
// =============================================================================

import { useCallback }              from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
}                                   from 'react-native'
//import { usePowerSyncStatus }       from '@powersync/react-native'
import { useStatus } from '@powersync/react'
import { StatusBar }                from 'expo-status-bar'

import { useAuthStore, selectUser, selectRoles, selectBusinessDayId } from '../../src/store/auth'

// =============================================================================
// BADGE DE ESTADO POWERSYNC
// Componente reutilizable — se usará en el header global en Sprint 3
// =============================================================================

function PowerSyncStatusBadge() {
//  const status = usePowerSyncStatus()
  const status = useStatus()

  if (status.connected) {
    return (
      <View className="flex-row items-center gap-1.5 bg-emerald-500/20 px-3 py-1.5 rounded-full">
        <View className="w-2 h-2 rounded-full bg-emerald-500" />
        <Text className="text-emerald-400 text-xs font-semibold">Sincronizado</Text>
      </View>
    )
  }

  if (status.dataFlowStatus?.uploading || status.dataFlowStatus?.downloading) {
    return (
      <View className="flex-row items-center gap-1.5 bg-blue-500/20 px-3 py-1.5 rounded-full">
        <ActivityIndicator size={10} color="#60a5fa" />
        <Text className="text-blue-400 text-xs font-semibold">Sincronizando...</Text>
      </View>
    )
  }

  return (
    <View className="flex-row items-center gap-1.5 bg-slate-700 px-3 py-1.5 rounded-full">
      <View className="w-2 h-2 rounded-full bg-slate-500" />
      <Text className="text-slate-400 text-xs font-semibold">Sin conexión</Text>
    </View>
  )
}

// =============================================================================
// LABEL DE ROL — etiqueta visual del rol activo
// =============================================================================

const ROLE_LABELS: Record<string, { label: string; color: string }> = {
  ADMIN:   { label: 'Administrador', color: 'bg-purple-500/20 text-purple-300' },
  CASHIER: { label: 'Cajero',        color: 'bg-blue-500/20 text-blue-300'    },
  BARMAN:  { label: 'Barman',        color: 'bg-amber-500/20 text-amber-300'  },
  WAITER:  { label: 'Mesero',        color: 'bg-emerald-500/20 text-emerald-300' },
}

// =============================================================================
// COMPONENTE PRINCIPAL
// =============================================================================

export default function IndexScreen() {
  const user          = useAuthStore(selectUser)
  const roles         = useAuthStore(selectRoles)
  const businessDayId = useAuthStore(selectBusinessDayId)
  const logout        = useAuthStore(s => s.logout)

  // Rol principal para mostrar en la UI (el de mayor jerarquía)
  const primaryRole = (['ADMIN', 'CASHIER', 'BARMAN', 'WAITER'] as const)
    .find(r => roles.includes(r)) ?? 'WAITER'

  const roleInfo = ROLE_LABELS[primaryRole] ?? ROLE_LABELS['WAITER']!

  // ── Logout con confirmación ────────────────────────────────────────────
  // logout() del store: invalida refreshToken en servidor + limpia SecureStore
  // + disconnectAndClear() de PowerSync (borra SQLite local).
  // Después del logout, el Guard de /(app)/_layout.tsx detecta
  // isAuthenticated → false y hace Redirect a /(auth)/login automáticamente.
  const handleLogout = useCallback(() => {
    Alert.alert(
      'Cerrar sesión',
      '¿Estás seguro? Se borrarán los datos locales de este dispositivo.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text:    'Cerrar sesión',
          style:   'destructive',
          onPress: async () => {
            await logout()
            // No hacemos router.replace() aquí.
            // El Guard detecta isAuthenticated → false y navega automáticamente.
          },
        },
      ],
    )
  }, [logout])

  return (
    <View className="flex-1 bg-slate-900">
      <StatusBar style="light" />

      {/* ── Header ──────────────────────────────────────────────────── */}
      <View className="px-6 pt-14 pb-4 bg-slate-800 border-b border-slate-700">
        <View className="flex-row items-center justify-between">

          {/* Info del usuario */}
          <View className="flex-1">
            <Text className="text-slate-400 text-xs mb-0.5">Bienvenido</Text>
            <Text className="text-white text-lg font-bold" numberOfLines={1}>
              {user?.name ?? 'Usuario'}
            </Text>
            <View className={`mt-1.5 self-start px-2.5 py-0.5 rounded-full ${roleInfo.color}`}>
              <Text className="text-xs font-semibold">{roleInfo.label}</Text>
            </View>
          </View>

          {/* Badge de PowerSync */}
          <PowerSyncStatusBadge />
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ padding: 24 }}>

        {/* ── Estado de la jornada ──────────────────────────────────── */}
        <View className={`
          rounded-2xl p-4 mb-6 border
          ${businessDayId
            ? 'bg-emerald-900/30 border-emerald-700/50'
            : 'bg-amber-900/30 border-amber-700/50'}
        `}>
          <View className="flex-row items-center gap-2">
            <Text className="text-xl">{businessDayId ? '✅' : '⏳'}</Text>
            <View className="flex-1">
              <Text className={`font-semibold text-sm ${businessDayId ? 'text-emerald-300' : 'text-amber-300'}`}>
                {businessDayId ? 'Jornada activa' : 'Sin jornada activa'}
              </Text>
              <Text className={`text-xs mt-0.5 ${businessDayId ? 'text-emerald-500' : 'text-amber-500'}`}>
                {businessDayId
                  ? `ID: ${businessDayId.slice(0, 8)}...`
                  : 'El administrador debe abrir la jornada'}
              </Text>
            </View>
          </View>
        </View>

        {/* ── Placeholder de mesas ──────────────────────────────────── */}
        <View className="bg-slate-800 rounded-2xl p-6 mb-6 items-center border border-slate-700">
          <Text className="text-4xl mb-3">🪑</Text>
          <Text className="text-white text-lg font-bold mb-2">
            Selecciona una mesa
          </Text>
          <Text className="text-slate-400 text-sm text-center">
            La grilla de mesas estará disponible en el Sprint 3.
            Las mesas se cargarán desde la base de datos local de PowerSync.
          </Text>
        </View>

        {/* ── Info de sincronización ────────────────────────────────── */}
        <View className="bg-slate-800 rounded-2xl p-4 mb-6 border border-slate-700">
          <Text className="text-slate-300 text-sm font-semibold mb-3">
            Estado del sistema
          </Text>
          <View className="gap-2">
            <View className="flex-row justify-between">
              <Text className="text-slate-500 text-xs">Tenant</Text>
              <Text className="text-slate-300 text-xs font-mono">
                {user?.tenantId?.slice(0, 8) ?? '—'}...
              </Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-slate-500 text-xs">Establecimiento</Text>
              <Text className="text-slate-300 text-xs font-mono">
                {user?.establishmentId?.slice(0, 8) ?? '—'}...
              </Text>
            </View>
            <View className="flex-row justify-between">
              <Text className="text-slate-500 text-xs">Roles activos</Text>
              <Text className="text-slate-300 text-xs">
                {roles.join(', ')}
              </Text>
            </View>
          </View>
        </View>

        {/* ── Botón de logout ───────────────────────────────────────── */}
        <TouchableOpacity
          onPress={handleLogout}
          className="bg-red-900/40 border border-red-800/60 rounded-2xl py-4 items-center mt-2"
          activeOpacity={0.7}
        >
          <Text className="text-red-400 font-semibold text-base">
            Cerrar sesión
          </Text>
        </TouchableOpacity>

      </ScrollView>
    </View>
  )
}
