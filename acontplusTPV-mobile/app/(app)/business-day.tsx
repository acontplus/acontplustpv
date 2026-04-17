// =============================================================================
// app/(app)/business-day.tsx
// Tab de Jornada — solo ADMIN
// Placeholder — implementación completa en Sprint 3 (Paso 3: BusinessDay)
// =============================================================================

import { View, Text } from 'react-native'
import { StatusBar }  from 'expo-status-bar'

export default function BusinessDayScreen() {
  return (
    <View className="flex-1 bg-slate-900 items-center justify-center px-6">
      <StatusBar style="light" />
      <Text className="text-4xl mb-4">📅</Text>
      <Text className="text-white text-xl font-bold mb-2">Gestión de Jornada</Text>
      <Text className="text-slate-400 text-sm text-center">
        Disponible en Sprint 3 — Apertura y cierre de jornada
      </Text>
    </View>
  )
}
