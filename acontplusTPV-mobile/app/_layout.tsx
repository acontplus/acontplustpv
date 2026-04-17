// =============================================================================
// app/_layout.tsx
// Root Layout — Punto de entrada de la aplicación
//
// Responsabilidades (en orden de ejecución):
//   1. Prevenir que el splash screen se oculte antes de que todo esté listo
//   2. Inicializar PowerSync (SQLite nativo) — DEBE ocurrir antes del primer render
//   3. Restaurar la sesión guardada en SecureStore (loadStoredSession)
//   4. Una vez todo listo: ocultar splash y renderizar el árbol de navegación
//
// Providers en este layout (de exterior a interior):
//   PowerSyncProvider  → contexto de SQLite para toda la app
//   trpc.Provider      → contexto tRPC + React Query
//   QueryClientProvider → React Query directamente
//
// Barrera de hidratación:
//   isPowerSyncReady && isSessionLoaded → ocultar splash → renderizar <Slot />
//
// Por qué PowerSync PRIMERO:
//   PowerSyncDatabase.init() abre el archivo SQLite en disco.
//   Si un componente hijo intenta hacer usePowerSyncQuery() antes de que
//   init() resuelva, la query falla silenciosamente con "database not open".
//   La barrera isPowerSyncReady garantiza que nunca ocurra.
//
// Por qué NO navegamos aquí:
//   Este layout no decide a dónde ir. Solo provee contexto.
//   La navegación es responsabilidad del Guard en app/(app)/_layout.tsx
//   y del grupo de rutas (auth). Expo Router maneja el routing por segmentos.
//
// Por qué PowerSyncProvider y NO PowerSyncContext.Provider directamente:
//   PowerSyncProvider del SDK gestiona internamente el ciclo de vida de la
//   conexión, el estado de sincronización y los re-renders de los hooks
//   (useQuery, etc.). Usar PowerSyncContext.Provider directamente se salta
//   toda esa lógica y deja la app sin gestión de estado de sincronización.
// =============================================================================

import { useEffect, useState, useCallback } from 'react'
import { View }                              from 'react-native'
import { Slot }                              from 'expo-router'
import * as SplashScreen                     from 'expo-splash-screen'
import { QueryClientProvider }               from '@tanstack/react-query'
import { PowerSyncContext }               from '@powersync/react'

import { trpc, createTrpcQueryClient }       from '../src/lib/trpc'
import { queryClient }                       from '../src/lib/queryClient'
import { initPowerSync, powerSyncDb }        from '../src/lib/powersync'
import { useAuthStore }                      from '../src/store/auth'

// Mantener el splash visible hasta que explícitamente lo ocultemos
SplashScreen.preventAutoHideAsync()

// ── Clientes tRPC — singleton del proceso, no del componente ──────────────────
// Se crean fuera del componente para que no se recreen en cada render.
// Si se crean dentro del componente (incluso con useMemo sin deps), pueden
// recrearse en React StrictMode causando pérdida del caché de React Query.
const trpcClient = createTrpcQueryClient()

// =============================================================================
// COMPONENTE
// =============================================================================

export default function RootLayout() {
  // ── Estado de la barrera de hidratación ──────────────────────────────────
  // Ambas condiciones deben ser true antes de ocultar el splash y renderizar
  const [isPowerSyncReady, setIsPowerSyncReady] = useState(false)
  const [isSessionLoaded,  setIsSessionLoaded]  = useState(false)

  const loadStoredSession = useAuthStore(s => s.loadStoredSession)

  // ── Inicialización de PowerSync ───────────────────────────────────────────
  // Se ejecuta una sola vez al montar el Root Layout.
  // Abre la base de datos SQLite y conecta el conector al servidor.
  // powerSyncDb.connect() inicia la sincronización en background — no bloquea.
  useEffect(() => {
    initPowerSync()
      .then(() => setIsPowerSyncReady(true))
      .catch((err) => {
        // PowerSync falló — logear pero continuar: la app puede operar
        // sin sincronización (modo solo-lectura de datos ya almacenados).
        console.error('[PowerSync] Error al inicializar:', err)
        // Marcamos como ready de todos modos para no bloquear la app
        setIsPowerSyncReady(true)
      })
  }, [])

  // ── Restaurar sesión de SecureStore ──────────────────────────────────────
  // Se ejecuta una sola vez. Lee accessToken + refreshToken + user del Keychain
  // y los carga en el store de Zustand para que el Guard los detecte.
  useEffect(() => {
    loadStoredSession()
      .then(() => setIsSessionLoaded(true))
      .catch(() => setIsSessionLoaded(true)) // Siempre marcar como listo
  }, [loadStoredSession])

  // ── Ocultar splash cuando todo esté listo ────────────────────────────────
  // onLayoutRootView se llama cuando el View raíz termina de layoutear.
  // Es el momento seguro para ocultar el splash sin flash de contenido.
  const onLayoutRootView = useCallback(async () => {
    if (isPowerSyncReady && isSessionLoaded) {
      await SplashScreen.hideAsync()
    }
  }, [isPowerSyncReady, isSessionLoaded])

  // Mientras alguna condición no esté lista, no renderizar nada
  // (el splash screen sigue visible por SplashScreen.preventAutoHideAsync)
  if (!isPowerSyncReady || !isSessionLoaded) {
    return null
  }

  // ==========================================================================
  // ÁRBOL DE PROVIDERS
  //
  // PowerSyncContext.Provider es la API correcta para @powersync/react 1.10.0.
  // PowerSyncProvider no existe en esta versión del SDK — el contexto se
  // provee directamente con value={powerSyncDb}.
  //
  // Jerarquía:
  //   PowerSyncContext.Provider (SQLite context)
  //     └── trpc.Provider (tRPC + React Query context)
  //           └── QueryClientProvider (React Query directo)
  //                 └── View (trigger de onLayout para ocultar splash)
  //                       └── Slot (árbol de rutas de Expo Router)
  // ==========================================================================
  return (
    <PowerSyncContext.Provider value={powerSyncDb}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <View className="flex-1" onLayout={onLayoutRootView}>
            <Slot />
          </View>
        </QueryClientProvider>
      </trpc.Provider>
    </PowerSyncContext.Provider>
  )
}
