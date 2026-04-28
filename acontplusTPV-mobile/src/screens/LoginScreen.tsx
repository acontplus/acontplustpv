// =============================================================================
// src/screens/LoginScreen.tsx
// Pantalla de Login — acontplusTPV
//
// Flujo de pantalla:
//   Paso 1 (SLUG):          Ingreso del slug del tenant (ej: "mi-restaurante")
//   Paso 2 (ESTABLISHMENT): Selección del establecimiento del tenant
//   Paso 3 (PIN):           Teclado numérico de 4 dígitos
//
// El slug se guarda en AsyncStorage (no SecureStore — es dato público)
// para auto-completar en el próximo login.
// El PIN nunca se almacena — solo viaja una vez por HTTPS al servidor.
//
// Correcciones Sprint 1 aplicadas en este archivo:
//   M-02: Stale closure en handlePinKey — usar setPin(prev => ...) funcional
//   M-03: setTimeout sin cleanup en useEffect del shake — limpiado en return
//   Selectores: useAuthStore con selector granular para evitar re-renders masivos
//
// Sobre la navegación post-login:
//   Este componente NO navega. Solo llama a login() del store.
//   El Guard en app/(app)/_layout.tsx detecta isAuthenticated → true
//   y hace el redirect. Ver comentario en app/(auth)/login.tsx.
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
  Vibration,
  Animated,
}                              from 'react-native'
import { StatusBar }           from 'expo-status-bar'
import AsyncStorage            from '@react-native-async-storage/async-storage'
import * as SecureStore        from 'expo-secure-store'
import { useAuthStore }        from '../store/auth'
import { trpcVanilla }         from '../lib/trpc'

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

const PinKey = React.memo(({ label, onPress, variant = 'default' }: PinKeyProps) => (
  <TouchableOpacity
    onPress={onPress}
    disabled={variant === 'empty'}
    className={`
      flex-1 aspect-square rounded-2xl items-center justify-center mx-1 my-1
      ${variant === 'empty'   ? 'bg-transparent' : ''}
      ${variant === 'default' ? 'bg-white active:bg-slate-100' : ''}
      ${variant === 'delete'  ? 'bg-slate-100 active:bg-slate-200' : ''}
    `}
  >
    {typeof label === 'string'
      ? <Text className="text-2xl font-semibold text-slate-800">{label}</Text>
      : label
    }
  </TouchableOpacity>
))

// ── Indicadores de punto del PIN ─────────────────────────────────────────────
interface PinDotsProps {
  length:  number
  filled:  number
  shaking: boolean
}

const PinDots = React.memo(({ length, filled, shaking }: PinDotsProps) => {
  const shakeAnim = useRef(new Animated.Value(0)).current

  useEffect(() => {
    if (!shaking) return
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: 10,  duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8,   duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -8,  duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0,   duration: 40, useNativeDriver: true }),
    ]).start()
  }, [shaking, shakeAnim])

  return (
    <Animated.View
      style={{ transform: [{ translateX: shakeAnim }] }}
      className="flex-row justify-center gap-4 my-8"
    >
      {Array.from({ length }).map((_, i) => (
        <View
          key={i}
          className={`w-4 h-4 rounded-full
            ${i < filled
              ? 'bg-blue-600'
              : 'bg-slate-200 border-2 border-slate-300 bg-transparent'}
          `}
        />
      ))}
    </Animated.View>
  )
})

// =============================================================================
// CONSTANTES
// =============================================================================

// B-02 CORREGIDO: el slug es dato público (lo comparten todos los empleados),
// no merece el Keychain/Keystore de SecureStore. AsyncStorage es suficiente.
const SLUG_STORAGE_KEY = 'acontplus_last_slug'
const PIN_LENGTH       = 4

// =============================================================================
// FETCH DE ESTABLECIMIENTOS — usa trpcVanilla (cliente tRPC sin React Query)
// Se llama antes del login, no hay token todavía.
// =============================================================================
async function fetchEstablishments(tenantSlug: string): Promise<Establishment[]> {
  if (__DEV__) {
    console.log('[login] fetchEstablishments request', { tenantSlug })
  }

  const result = await trpcVanilla.auth.listEstablishments.mutate({ tenantSlug })

  if (__DEV__) {
    console.log('[login] fetchEstablishments response', result)
  }

  return result as Establishment[]
}

// =============================================================================
// COMPONENTE PRINCIPAL
// =============================================================================

export default function LoginScreen() {
  // ── Selectores granulares de Zustand (M-02 CORREGIDO) ────────────────────
  // Suscribirse con selector individual en lugar de desestructurar el store
  // completo. Así el componente solo re-renderiza cuando cambia el campo
  // específico que le importa, no ante cualquier cambio del store.
  const login      = useAuthStore(s => s.login)
  const isLoading  = useAuthStore(s => s.isLoading)
  const error      = useAuthStore(s => s.error)
  const clearError = useAuthStore(s => s.clearError)

  // ── Estado local de la pantalla ───────────────────────────────────────────
  const [step,           setStep]          = useState<LoginStep>('SLUG')
  const [tenantSlug,     setTenantSlug]    = useState('')
  const [establishments, setEstablishments] = useState<Establishment[]>([])
  const [selectedEstId,  setSelectedEstId] = useState<string | null>(null)
  const [pin,            setPin]           = useState('')
  const [slugLoading,    setSlugLoading]   = useState(false)
  const [slugError,      setSlugError]     = useState<string | null>(null)
  const [pinShake,       setPinShake]      = useState(false)

  const slugInputRef = useRef<TextInput>(null)

  // ── Cargar el slug guardado al montar ────────────────────────────────────
  useEffect(() => {
    AsyncStorage.getItem(SLUG_STORAGE_KEY).then(saved => {
      if (saved) setTenantSlug(saved)
    }).catch(() => { /* AsyncStorage vacío — arrancar sin slug */ })
  }, [])

  // ── Limpiar error del store al desmontar ─────────────────────────────────
  useEffect(() => {
    return () => { clearError() }
  }, [clearError])

  // ── Animación de shake cuando hay error de PIN (M-03 CORREGIDO) ──────────
  // El setTimeout tiene su cleanup en el return del useEffect para evitar
  // llamar a setPinShake en un componente ya desmontado.
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>

    if (error && step === 'PIN') {
      setPinShake(true)
      setPin('')
      timeoutId = setTimeout(() => setPinShake(false), 400)
    }

    // Cleanup: cancela el timeout si el componente se desmonta o si
    // error/step cambian antes de que los 400ms expiren.
    return () => { clearTimeout(timeoutId) }
  }, [error, step])

  // ── PASO 3: submit del PIN ─────────────────────────────────────────────────
  // Definido antes de handlePinKey para poder ser referenciado en él.
  const handlePinSubmit = useCallback(async (submittedPin: string) => {
    if (!selectedEstId) return

    try {
      await login(tenantSlug.trim().toLowerCase(), submittedPin, selectedEstId)
      // Login exitoso → NO navegamos aquí.
      // El Guard en app/(app)/_layout.tsx detecta isAuthenticated → true
      // y hace el redirect a /(app) automáticamente.
    } catch {
      // El error ya está en el store → el useEffect del shake lo detecta
    }
  }, [tenantSlug, selectedEstId, login])

  // ── PASO 3: ingreso de dígitos (M-02 CORREGIDO) ──────────────────────────
  // Usar setPin con updater funcional (prev => ...) elimina la dependencia
  // en `pin` del closure y evita el stale closure en taps rápidos.
  // handlePinSubmit se incluye en las dependencias correctamente.
  const handlePinKey = useCallback((digit: string) => {
    setPin(prev => {
      if (prev.length >= PIN_LENGTH) return prev
      const next = prev + digit

      if (next.length === PIN_LENGTH) {
        // Ejecutar en microtask: permite que React pinte el 4to punto
        // antes de que el submit bloquee el JS thread con el fetch.
        setTimeout(() => handlePinSubmit(next), 0)
      }

      return next
    })
  }, [handlePinSubmit])

  // ── PASO 3: borrar último dígito ─────────────────────────────────────────
  const handlePinDelete = useCallback(() => {
    setPin(prev => prev.slice(0, -1))
    clearError()
  }, [clearError])

  // ── PASO 1: validar slug y cargar establecimientos ────────────────────────
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

      // Guardar slug para la próxima vez (AsyncStorage — dato público)
      await AsyncStorage.setItem(SLUG_STORAGE_KEY, trimmed)
      setTenantSlug(trimmed)
      setEstablishments(ests)

      // Si solo hay un establecimiento, saltar directamente al PIN
      if (ests.length === 1) {
        setSelectedEstId(ests[0]!.id)
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

  // ── PASO 2: seleccionar establecimiento ──────────────────────────────────
  const handleEstablishmentSelect = useCallback((id: string) => {
    setSelectedEstId(id)
    setStep('PIN')
  }, [])

  // ── Volver al paso anterior ───────────────────────────────────────────────
  const handleBack = useCallback(() => {
    clearError()
    setPin('')
    if (step === 'PIN')           setStep(establishments.length > 1 ? 'ESTABLISHMENT' : 'SLUG')
    if (step === 'ESTABLISHMENT') setStep('SLUG')
  }, [step, establishments.length, clearError])

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

          {/* ── Header ────────────────────────────────────────────────── */}
          <View className="items-center mb-10">
            <View className="w-16 h-16 bg-blue-600 rounded-2xl items-center justify-center mb-4">
              <Text className="text-white text-3xl font-bold">T</Text>
            </View>
            <Text className="text-2xl font-bold text-slate-800">acontplusTPV</Text>
            <Text className="text-slate-500 text-sm mt-1">Sistema de Punto de Venta</Text>
          </View>

          {/* ── PASO 1: Ingreso del slug ───────────────────────────────── */}
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
                    setTenantSlug(text)
                    setSlugError(null)
                  }}
                  onSubmitEditing={handleSlugSubmit}
                  placeholder="ej: mi-restaurante"
                  placeholderTextColor="#94a3b8"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="go"
                  className="flex-1 text-slate-800 text-base"
                />
              </View>

              {slugError && (
                <Text className="text-red-500 text-sm mt-2">{slugError}</Text>
              )}

              <TouchableOpacity
                onPress={handleSlugSubmit}
                disabled={slugLoading || !tenantSlug.trim()}
                className={`
                  mt-6 rounded-xl py-4 items-center
                  ${tenantSlug.trim() && !slugLoading
                    ? 'bg-blue-600 active:bg-blue-700'
                    : 'bg-slate-200'
                  }
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

          {/* ── PASO 2: Selección de establecimiento ──────────────────── */}
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

          {/* ── PASO 3: Teclado de PIN ─────────────────────────────────── */}
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

              <PinDots
                length={PIN_LENGTH}
                filled={pin.length}
                shaking={pinShake}
              />

              {error && (
                <Text className="text-red-500 text-sm text-center mb-4">{error}</Text>
              )}

              {/* Pad numérico */}
              <View className="mt-auto">
                {[
                  ['1', '2', '3'],
                  ['4', '5', '6'],
                  ['7', '8', '9'],
                ].map((row, ri) => (
                  <View key={ri} className="flex-row justify-between mb-2">
                    {row.map(digit => (
                      <PinKey
                        key={digit}
                        label={digit}
                        onPress={() => handlePinKey(digit)}
                      />
                    ))}
                  </View>
                ))}

                {/* Última fila: vacío, 0, borrar */}
                <View className="flex-row justify-between">
                  <PinKey label="" onPress={() => {}} variant="empty" />
                  <PinKey label="0" onPress={() => handlePinKey('0')} />
                  <PinKey
                    label={<Text className="text-2xl text-slate-600">⌫</Text>}
                    onPress={handlePinDelete}
                    variant="delete"
                  />
                </View>

                <TouchableOpacity onPress={handleBack} className="mt-4 items-center py-3">
                  <Text className="text-blue-600 font-medium">← Cambiar establecimiento</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
