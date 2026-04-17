// =============================================================================
// app/(app)/cashier.tsx
// Tab de Caja — CASHIER y ADMIN
// Placeholder — implementación completa en Sprint 4 (Paso 6: Flujo de cobro)
// =============================================================================

import { View, Text } from 'react-native'
import { StatusBar }  from 'expo-status-bar'

export default function CashierScreen() {
  return (
    <View className="flex-1 bg-slate-900 items-center justify-center px-6">
      <StatusBar style="light" />
      <Text className="text-4xl mb-4">💰</Text>
      <Text className="text-white text-xl font-bold mb-2">Caja</Text>
      <Text className="text-slate-400 text-sm text-center">
        Disponible en Sprint 4 — Flujo de cobro y eventos de caja
      </Text>
    </View>
  )
}
