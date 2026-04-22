// =============================================================================
// app/(app)/business-day.tsx
// Pantalla de gestión de jornada — ADMIN y CASHIER
//
// FLUJO:
//   Sin jornada abierta → formulario de apertura (initialCash + notes)
//   Con jornada abierta → estado de la jornada + formulario de cierre (blindCount)
//
// INTEGRACIÓN:
//   - useBusinessDay() lee el estado actual de SQLite (reactivo via PowerSync)
//   - trpc.businessDay.open.useMutation() llama al backend para abrir
//   - trpc.businessDay.close.useMutation() llama al backend para cerrar
//   - Tras la mutación el servidor actualiza BusinessDay en PostgreSQL
//   - PowerSync sincroniza el cambio a SQLite → useBusinessDay() reacciona
//   - El Guard en _layout.tsx detecta businessDayId y desbloquea WAITER/BARMAN
//
// POR QUÉ NO MUTAMOS SQLITE DIRECTAMENTE:
//   Las mutaciones van siempre por tRPC (Instrucciones §1 — PowerSync solo
//   lectura). El servidor valida la jornada, genera el CashRegisterEvent
//   de SHIFT_OPEN/SHIFT_CLOSE y aplica el RLS. El cliente solo espera la
//   sincronización de PowerSync para ver el cambio reflejado.
// =============================================================================

import { useState, useCallback }     from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
}                                    from 'react-native'
import { StatusBar }                 from 'expo-status-bar'

import { useBusinessDay }            from '../../src/hooks/useBusinessDay'
import { useAuthStore, selectUser }  from '../../src/store/auth'
import { trpc }                      from '../../src/lib/trpc'

// =============================================================================
// COMPONENTE: Formulario de apertura
// =============================================================================

interface OpenDayFormProps {
  establishmentId: string
  onSuccess: () => void
}

function OpenDayForm({ establishmentId, onSuccess }: OpenDayFormProps) {
  const [initialCash, setInitialCash] = useState('')
  const [notes,       setNotes]       = useState('')

  const openMutation = trpc.businessDay.open.useMutation({
    onSuccess: () => {
      Alert.alert('Jornada abierta', 'La jornada se ha abierto correctamente.')
      onSuccess()
    },
    onError: (err: Error) => {
      Alert.alert('Error', err.message ?? 'No se pudo abrir la jornada')
    },
  })

  const handleOpen = useCallback(() => {
    const cash = parseFloat(initialCash.replace(',', '.')) || 0

    Alert.alert(
      'Confirmar apertura',
      `¿Abrir jornada con $${cash.toFixed(2)} en caja?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Abrir jornada',
          onPress: () => openMutation.mutate({
            establishmentId,
            initialCash: cash,
            notes: notes.trim() || undefined,
          }),
        },
      ],
    )
  }, [initialCash, notes, establishmentId, openMutation])

  return (
    <View className="bg-slate-800 rounded-2xl p-6 border border-slate-700">
      <Text className="text-white text-lg font-bold mb-1">Abrir jornada</Text>
      <Text className="text-slate-400 text-sm mb-6">
        Ingresa el efectivo inicial en caja para comenzar el día.
      </Text>

      <Text className="text-slate-300 text-sm font-medium mb-2">
        Efectivo inicial en caja
      </Text>
      <View className="bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 mb-4 flex-row items-center">
        <Text className="text-slate-400 text-base mr-2">$</Text>
        <TextInput
          value={initialCash}
          onChangeText={setInitialCash}
          placeholder="0.00"
          placeholderTextColor="#64748b"
          keyboardType="decimal-pad"
          className="flex-1 text-white text-base"
        />
      </View>

      <Text className="text-slate-300 text-sm font-medium mb-2">
        Notas (opcional)
      </Text>
      <View className="bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 mb-6">
        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Observaciones de apertura..."
          placeholderTextColor="#64748b"
          multiline
          numberOfLines={2}
          className="text-white text-sm"
        />
      </View>

      <TouchableOpacity
        onPress={handleOpen}
        disabled={openMutation.isPending}
        className={`py-4 rounded-xl items-center ${
          openMutation.isPending ? 'bg-slate-600' : 'bg-emerald-600 active:bg-emerald-700'
        }`}
      >
        {openMutation.isPending
          ? <ActivityIndicator color="#fff" />
          : <Text className="text-white font-bold text-base">Abrir jornada</Text>
        }
      </TouchableOpacity>
    </View>
  )
}

// =============================================================================
// COMPONENTE: Estado + formulario de cierre
// =============================================================================

interface CloseDayFormProps {
  establishmentId: string
  businessDayId:   string
  openedAt:        string | null
  onSuccess:       () => void
}

function CloseDayForm({ establishmentId, businessDayId, openedAt, onSuccess }: CloseDayFormProps) {
  const [blindCount, setBlindCount] = useState('')
  const [notes,      setNotes]      = useState('')

  const closeMutation = trpc.businessDay.close.useMutation({
    onSuccess: (data: { message: string }) => {
      Alert.alert('Jornada cerrada', data.message ?? 'La jornada se ha cerrado correctamente.')
      onSuccess()
    },
    onError: (err: Error) => {
      Alert.alert('Error', err.message ?? 'No se pudo cerrar la jornada')
    },
  })

  const handleClose = useCallback(() => {
    const count = parseFloat(blindCount.replace(',', '.'))
    if (isNaN(count) || count < 0) {
      Alert.alert('Error', 'Ingresa un monto válido para el arqueo ciego.')
      return
    }
    Alert.alert(
      'Confirmar cierre',
      `¿Cerrar jornada con $${count.toFixed(2)} contados en caja?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Cerrar jornada',
          style: 'destructive',
          onPress: () => closeMutation.mutate({
            establishmentId,
            businessDayId,
            blindCount: count,
            notes: notes.trim() || undefined,
          }),
        },
      ],
    )
  }, [blindCount, notes, establishmentId, businessDayId, closeMutation])

  const openedAtFormatted = openedAt
    ? new Date(openedAt).toLocaleString('es-EC', {
        timeZone: 'America/Guayaquil',
        hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
      })
    : '—'

  return (
    <View className="bg-slate-800 rounded-2xl p-6 border border-slate-700">
      <View className="flex-row items-center gap-3 mb-6 p-4 bg-emerald-900/30 rounded-xl border border-emerald-700/50">
        <View className="w-3 h-3 rounded-full bg-emerald-500" />
        <View className="flex-1">
          <Text className="text-emerald-300 font-semibold text-sm">Jornada activa</Text>
          <Text className="text-emerald-500 text-xs mt-0.5">Abierta el {openedAtFormatted}</Text>
        </View>
      </View>

      <Text className="text-white text-lg font-bold mb-1">Cerrar jornada</Text>
      <Text className="text-slate-400 text-sm mb-6">
        Cuenta el efectivo en caja SIN consultar el sistema y escribe el total.
      </Text>

      <Text className="text-slate-300 text-sm font-medium mb-2">
        Arqueo ciego — efectivo contado
      </Text>
      <View className="bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 mb-4 flex-row items-center">
        <Text className="text-slate-400 text-base mr-2">$</Text>
        <TextInput
          value={blindCount}
          onChangeText={setBlindCount}
          placeholder="0.00"
          placeholderTextColor="#64748b"
          keyboardType="decimal-pad"
          className="flex-1 text-white text-base"
        />
      </View>

      <Text className="text-slate-300 text-sm font-medium mb-2">
        Notas (opcional)
      </Text>
      <View className="bg-slate-700 border border-slate-600 rounded-xl px-4 py-3 mb-6">
        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Observaciones de cierre..."
          placeholderTextColor="#64748b"
          multiline
          numberOfLines={2}
          className="text-white text-sm"
        />
      </View>

      <TouchableOpacity
        onPress={handleClose}
        disabled={closeMutation.isPending || !blindCount.trim()}
        className={`py-4 rounded-xl items-center ${
          closeMutation.isPending || !blindCount.trim()
            ? 'bg-slate-600'
            : 'bg-red-700 active:bg-red-800'
        }`}
      >
        {closeMutation.isPending
          ? <ActivityIndicator color="#fff" />
          : <Text className="text-white font-bold text-base">Cerrar jornada</Text>
        }
      </TouchableOpacity>
    </View>
  )
}

// =============================================================================
// PANTALLA PRINCIPAL
// =============================================================================

export default function BusinessDayScreen() {
  const user                               = useAuthStore(selectUser)
  const { businessDay, isLoading, isOpen } = useBusinessDay()

  if (!user) return null

  return (
    <View className="flex-1 bg-slate-900">
      <StatusBar style="light" />

      <View className="px-6 pt-14 pb-4 bg-slate-800 border-b border-slate-700">
        <Text className="text-white text-2xl font-bold">Jornada</Text>
        <Text className="text-slate-400 text-sm mt-1">Apertura y cierre de caja</Text>
      </View>

      <ScrollView className="flex-1 px-6 pt-6">
        {isLoading ? (
          <View className="items-center py-12">
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text className="text-slate-400 text-sm mt-3">
              Verificando estado de la jornada...
            </Text>
          </View>
        ) : isOpen && businessDay ? (
          <CloseDayForm
            establishmentId={user.establishmentId}
            businessDayId={businessDay.id}
            openedAt={businessDay.opened_at}
            onSuccess={() => {}}
          />
        ) : (
          <OpenDayForm
            establishmentId={user.establishmentId}
            onSuccess={() => {}}
          />
        )}

        <View className="mt-6 mb-8 p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
          <Text className="text-slate-500 text-xs leading-5">
            📋 El arqueo ciego significa contar el efectivo en caja antes de
            conocer el teórico del sistema. Esto garantiza un conteo honesto
            y detecta diferencias reales.
          </Text>
        </View>
      </ScrollView>
    </View>
  )
}
