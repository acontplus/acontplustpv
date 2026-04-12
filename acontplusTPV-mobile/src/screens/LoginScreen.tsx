// =============================================================================
// src/screens/LoginScreen.tsx
// Pantalla de Login — acontplusTPV
//
// Flujo de pantalla:
//   Paso 1 (SLUG):         Ingreso del slug del tenant (ej: "mi-restaurante")
//   Paso 2 (ESTABLISHMENT): Selección del establecimiento del tenant
//   Paso 3 (PIN):          Teclado numérico de 4 dígitos
//
// El slug se guarda en SecureStore para auto-completar en el próximo login.
// El PIN nunca se almacena — solo viaja una vez por HTTPS al servidor.
// =============================================================================

import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
}                              from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  Vibration,
  Animated,
}                              from 'react-native'
import { StatusBar }           from 'expo-status-bar'
import * as SecureStore        from 'expo-secure-store'
import Constants               from 'expo-constants'
import { useAuthStore }        from '../store/auth'

// =============================================================================
// TIPOS
// =============================================================================

type LoginStep = 'SLUG' | 'ESTABLISHMENT' | 'PIN'

interface Establishment {
  id:   string
  name: string
  code: string
}

// =============================================================================
// COMPONENTES AUXILIARES
// =============================================================================

// ── Tecla del pad numérico ────────────────────────────────────────────────────
interface PinKeyProps {
  label:    string | React.ReactNode
  onPress:  () => void
  variant?: 'default' | 'delete' | 'empty'
}

function PinKey({ label, onPress, variant = 'default' }: PinKeyProps) {
  const scaleAnim = useRef(new Animated.Value(1)).current

  const handlePress = () => {
    // Animación de tap
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.9, duration: 80, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1,   duration: 80, useNativeDriver: true }),
    ]).start()
    onPress()
  }

  if (variant === 'empty') {
    return <View className="flex-1 m-1.5 h-16" />
  }

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }], flex: 1 }}>
      <TouchableOpacity
        onPress={handlePress}
        className={`
          m-1.5 h-16 rounded-2xl items-center justify-center
          ${variant === 'delete'
            ? 'bg-slate-200 active:bg-slate-300'
            : 'bg-white active:bg-slate-100 shadow-sm border border-slate-100'}
        `}
        activeOpacity={0.8}
      >
        {typeof label === 'string' ? (
          <Text className={`
            text-2xl font-semibold
            ${variant === 'delete' ? 'text-slate-500' : 'text-slate-800'}
          `}>
            {label}
          </Text>
        ) : (
          label
        )}
      </TouchableOpacity>
    </Animated.View>
  )
}

// ── Indicador de dígitos del PIN ──────────────────────────────────────────────
interface PinDotsProps {
  length:  number
  filled:  number
  shake:   boolean
}

function PinDots({ length, filled, shake }: PinDotsProps) {
  const shakeAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (shake) {
      Vibration.vibrate(200)
      Animated.sequence([
        Animated.timing(shakeAnim, { toValue: 10,  duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 10,  duration: 60, useNativeDriver: true }),
        Animated.timing(shakeAnim, { toValue: 0,   duration: 60, useNativeDriver: true }),
      ]).start()
    }
  }, [shake])

  return (
    <Animated.View
      className="flex-row justify-center gap-4 my-8"
      style={{ transform: [{ translateX: shakeAnim }] }}
    >
      {Array.from({ length }).map((_, i) => (
        <View
          key={i}
          className={`
            w-4 h-4 rounded-full
            ${i < filled ? 'bg-blue-600' : 'border-2 border-slate-300 bg-transparent'}
          `}
        />
      ))}
    </Animated.View>
  )
}

// =============================================================================
// PANTALLA PRINCIPAL
// =============================================================================

const SLUG_STORAGE_KEY = 'acontplus_last_slug'
const PIN_LENGTH = 4

// Fetch de establecimientos sin tRPC (se llama antes del login)
async function fetchEstablishments(tenantSlug: string): Promise<Establishment[]> {
  const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? ''

  // Llamada al endpoint público de establecimientos del tenant
  // El tenant resuelve el slug en el servidor
  const res = await fetch(`${apiUrl}/trpc/auth.listEstablishments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { tenantSlug } }),
  })

  if (!res.ok) {
    throw new Error('Tenant no encontrado. Verifica el nombre del negocio.')
  }

  const data = await res.json() as {
    result?: { data?: { json: Establishment[] } }
    error?: { message: string }
  }

  if (data.error) {
    throw new Error(data.error.message)
  }

  return data.result?.data?.json ?? []
}

// =============================================================================
// COMPONENTE
// =============================================================================

export default function LoginScreen() {
  const { login, isLoading, error, clearError } = useAuthStore()

  // ── Estado de la pantalla ──────────────────────────────────────────────────
  const [step,               setStep]              = useState<LoginStep>('SLUG')
  const [tenantSlug,         setTenantSlug]         = useState('')
  const [establishments,     setEstablishments]     = useState<Establishment[]>([])
  const [selectedEstId,      setSelectedEstId]      = useState<string | null>(null)
  const [pin,                setPin]                = useState('')
  const [slugLoading,        setSlugLoading]        = useState(false)
  const [slugError,          setSlugError]          = useState<string | null>(null)
  const [pinShake,           setPinShake]           = useState(false)

  const slugInputRef = useRef<TextInput>(null)

  // ── Cargar el slug guardado ────────────────────────────────────────────────
  useEffect(() => {
    SecureStore.getItemAsync(SLUG_STORAGE_KEY).then(saved => {
      if (saved) setTenantSlug(saved)
    })
  }, [])

  // ── Limpiar error del store al desmontar ───────────────────────────────────
  useEffect(() => {
    return () => clearError()
  }, [])

  // ── Shake cuando hay error de PIN ─────────────────────────────────────────
  useEffect(() => {
    if (error && step === 'PIN') {
      setPinShake(true)
      setPin('')
      setTimeout(() => setPinShake(false), 400)
    }
  }, [error])

  // ── PASO 1: validar slug y cargar establecimientos ─────────────────────────
  const handleSlugSubmit = useCallback(async () => {
    const trimmed = tenantSlug.trim().toLowerCase()
    if (!trimmed) {
      setSlugError('Ingresa el nombre de tu negocio')
      return
    }

    setSlugLoading(true)
    setSlugError(null)

    try {
      const ests = await fetchEstablishments(trimmed)

      if (ests.length === 0) {
        setSlugError('No se encontraron establecimientos activos')
        return
      }

      // Guardar el slug para la próxima vez
      await SecureStore.setItemAsync(SLUG_STORAGE_KEY, trimmed)
      setTenantSlug(trimmed)
      setEstablishments(ests)

      // Si solo hay un establecimiento, seleccionarlo automáticamente
      if (ests.length === 1) {
        setSelectedEstId(ests[0].id)
        setStep('PIN')
      } else {
        setStep('ESTABLISHMENT')
      }
    } catch (err) {
      setSlugError(err instanceof Error ? err.message : 'Error de conexión')
    } finally {
      setSlugLoading(false)
    }
  }, [tenantSlug])

  // ── PASO 2: seleccionar establecimiento ───────────────────────────────────
  const handleEstablishmentSelect = useCallback((id: string) => {
    setSelectedEstId(id)
    setStep('PIN')
  }, [])

  // ── PASO 3: manejo del PIN ────────────────────────────────────────────────
  const handlePinKey = useCallback((digit: string) => {
    if (pin.length >= PIN_LENGTH) return
    const newPin = pin + digit
    setPin(newPin)

    // Auto-submit cuando se completan los 4 dígitos
    if (newPin.length === PIN_LENGTH) {
      handlePinSubmit(newPin)
    }
  }, [pin])

  const handlePinDelete = useCallback(() => {
    setPin(prev => prev.slice(0, -1))
    clearError()
  }, [])

  const handlePinSubmit = useCallback(async (submittedPin: string) => {
    if (!selectedEstId) return

    try {
      await login(tenantSlug, submittedPin, selectedEstId)
      // Si el login tiene éxito, la navegación la maneja el root layout
      // al detectar que isAuthenticated cambió a true
    } catch {
      // El error ya está en el store — el useEffect de shake lo detecta
    }
  }, [tenantSlug, selectedEstId, login])

  // ── Volver al paso anterior ────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    clearError()
    setPin('')
    if (step === 'PIN')          setStep(establishments.length > 1 ? 'ESTABLISHMENT' : 'SLUG')
    if (step === 'ESTABLISHMENT') setStep('SLUG')
  }, [step, establishments.length])

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-slate-50"
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <StatusBar style="dark" />

      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-1 px-6 pt-16 pb-8">

          {/* ── Header ─────────────────────────────────────────────────── */}
          <View className="items-center mb-10">
            <View className="w-16 h-16 bg-blue-600 rounded-2xl items-center justify-center mb-4">
              <Text className="text-white text-3xl font-bold">T</Text>
            </View>
            <Text className="text-2xl font-bold text-slate-800">acontplusTPV</Text>
            <Text className="text-slate-500 text-sm mt-1">Sistema de Punto de Venta</Text>
          </View>

          {/* ── PASO 1: Ingreso del slug ────────────────────────────────── */}
          {step === 'SLUG' && (
            <View className="flex-1">
              <Text className="text-lg font-semibold text-slate-700 mb-2">
                Nombre del negocio
              </Text>
              <Text className="text-slate-500 text-sm mb-6">
                Ingresa el identificador único de tu restaurante
              </Text>

              <View className={`
                flex-row items-center bg-white border rounded-xl px-4 py-3
                ${slugError ? 'border-red-400' : 'border-slate-200'}
              `}>
                <TextInput
                  ref={slugInputRef}
                  value={tenantSlug}
                  onChangeText={text => {
                    setTenantSlug(text.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    setSlugError(null)
                  }}
                  onSubmitEditing={handleSlugSubmit}
                  placeholder="mi-restaurante"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  className="flex-1 text-base text-slate-800"
                />
              </View>

              {slugError && (
                <Text className="text-red-500 text-sm mt-2">{slugError}</Text>
              )}

              <TouchableOpacity
                onPress={handleSlugSubmit}
                disabled={slugLoading || !tenantSlug.trim()}
                className={`
                  mt-6 py-4 rounded-xl items-center
                  ${slugLoading || !tenantSlug.trim()
                    ? 'bg-slate-200'
                    : 'bg-blue-600 active:bg-blue-700'}
                `}
              >
                {slugLoading
                  ? <ActivityIndicator color="#fff" />
                  : <Text className={`font-semibold text-base ${tenantSlug.trim() ? 'text-white' : 'text-slate-400'}`}>
                      Continuar
                    </Text>
                }
              </TouchableOpacity>
            </View>
          )}

          {/* ── PASO 2: Selección de establecimiento ───────────────────── */}
          {step === 'ESTABLISHMENT' && (
            <View className="flex-1">
              <Text className="text-lg font-semibold text-slate-700 mb-2">
                Selecciona tu local
              </Text>
              <Text className="text-slate-500 text-sm mb-6">
                {tenantSlug}
              </Text>

              {establishments.map(est => (
                <TouchableOpacity
                  key={est.id}
                  onPress={() => handleEstablishmentSelect(est.id)}
                  className="bg-white border border-slate-200 rounded-xl px-5 py-4 mb-3 active:bg-slate-50"
                >
                  <Text className="text-base font-semibold text-slate-800">{est.name}</Text>
                  <Text className="text-sm text-slate-500 mt-0.5">Código: {est.code}</Text>
                </TouchableOpacity>
              ))}

              <TouchableOpacity onPress={handleBack} className="mt-4 items-center py-3">
                <Text className="text-blue-600 font-medium">← Cambiar negocio</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ── PASO 3: Teclado de PIN ──────────────────────────────────── */}
          {step === 'PIN' && (
            <View className="flex-1">
              <View className="items-center mb-2">
                <Text className="text-lg font-semibold text-slate-700">
                  Ingresa tu PIN
                </Text>
                <Text className="text-slate-500 text-sm mt-1">
                  {establishments.find(e => e.id === selectedEstId)?.name ?? tenantSlug}
                </Text>
              </View>

              {/* Puntos indicadores del PIN */}
              <PinDots length={PIN_LENGTH} filled={pin.length} shake={pinShake} />

              {/* Mensaje de error */}
              {error && (
                <Text className="text-red-500 text-sm text-center mb-4 -mt-2">
                  {error}
                </Text>
              )}

              {/* Loading overlay */}
              {isLoading && (
                <View className="items-center mb-4">
                  <ActivityIndicator size="small" color="#2563eb" />
                  <Text className="text-slate-500 text-sm mt-2">Verificando...</Text>
                </View>
              )}

              {/* Teclado numérico */}
              <View className="mt-2">
                {/* Fila 1-2-3 */}
                <View className="flex-row">
                  {['1','2','3'].map(d => (
                    <PinKey key={d} label={d} onPress={() => handlePinKey(d)} />
                  ))}
                </View>
                {/* Fila 4-5-6 */}
                <View className="flex-row">
                  {['4','5','6'].map(d => (
                    <PinKey key={d} label={d} onPress={() => handlePinKey(d)} />
                  ))}
                </View>
                {/* Fila 7-8-9 */}
                <View className="flex-row">
                  {['7','8','9'].map(d => (
                    <PinKey key={d} label={d} onPress={() => handlePinKey(d)} />
                  ))}
                </View>
                {/* Fila volver-0-borrar */}
                <View className="flex-row">
                  <PinKey
                    label={<Text className="text-blue-600 text-sm font-medium">Volver</Text>}
                    onPress={handleBack}
                    variant="delete"
                  />
                  <PinKey label="0" onPress={() => handlePinKey('0')} />
                  <PinKey
                    label="⌫"
                    onPress={handlePinDelete}
                    variant="delete"
                  />
                </View>
              </View>
            </View>
          )}

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
