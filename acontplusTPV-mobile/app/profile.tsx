// =============================================================================
// app/(app)/profile.tsx
// Tab de Perfil — universal (todos los roles)
// Muestra la información de la sesión activa y el botón de logout secundario.
// =============================================================================

import { useCallback }          from 'react'
import { View, Text, TouchableOpacity, Alert } from 'react-native'
import { StatusBar }            from 'expo-status-bar'
import { useAuthStore, selectUser, selectRoles } from '../src/store/auth'

export default function ProfileScreen() {
  const user   = useAuthStore(selectUser)
  const roles  = useAuthStore(selectRoles)
  const logout = useAuthStore(s => s.logout)

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Cerrar sesión',
      '¿Estás seguro? Se borrarán los datos locales de este dispositivo.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text:    'Cerrar sesión',
          style:   'destructive',
          onPress: () => { logout() },
        },
      ],
    )
  }, [logout])

  return (
    <View className="flex-1 bg-slate-900">
      <StatusBar style="light" />

      <View className="px-6 pt-14 pb-6">
        <Text className="text-white text-2xl font-bold mb-6">Perfil</Text>

        {/* Avatar */}
        <View className="items-center mb-8">
          <View className="w-20 h-20 bg-blue-600 rounded-full items-center justify-center mb-3">
            <Text className="text-white text-3xl font-bold">
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </Text>
          </View>
          <Text className="text-white text-lg font-bold">{user?.name ?? '—'}</Text>
          <Text className="text-slate-400 text-sm mt-1">{roles.join(' · ')}</Text>
        </View>

        {/* Info */}
        <View className="bg-slate-800 rounded-2xl p-4 mb-6 border border-slate-700 gap-3">
          <View className="flex-row justify-between">
            <Text className="text-slate-400 text-sm">ID de usuario</Text>
            <Text className="text-slate-300 text-sm font-mono">
              {user?.id?.slice(0, 8) ?? '—'}...
            </Text>
          </View>
          <View className="flex-row justify-between">
            <Text className="text-slate-400 text-sm">Tenant</Text>
            <Text className="text-slate-300 text-sm font-mono">
              {user?.tenantId?.slice(0, 8) ?? '—'}...
            </Text>
          </View>
          <View className="flex-row justify-between">
            <Text className="text-slate-400 text-sm">Establecimiento</Text>
            <Text className="text-slate-300 text-sm font-mono">
              {user?.establishmentId?.slice(0, 8) ?? '—'}...
            </Text>
          </View>
        </View>

        <TouchableOpacity
          onPress={handleLogout}
          className="bg-red-900/40 border border-red-800/60 rounded-2xl py-4 items-center"
          activeOpacity={0.7}
        >
          <Text className="text-red-400 font-semibold text-base">Cerrar sesión</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}
