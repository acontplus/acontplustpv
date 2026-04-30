import '../global.css'
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
//   PowerSyncContext.Provider → contexto de SQLite para toda la app
//   trpc.Provider             → contexto tRPC + React Query
//   QueryClientProvider       → React Query directamente
//
// Barrera de hidratación:
//   isPowerSyncReady && isSessionLoaded → ocultar splash → renderizar <Slot />
//
// CORRECCIÓN BUG PIN-NAV (Sprint 2):
//   Añadido useEffect reactivo sobre isAuthenticated para disparar
//   router.replace() desde el layout raíz — único componente siempre montado.
//
//   PROBLEMA RAÍZ: el Guard en (app)/_layout.tsx solo vive cuando Expo Router
//   está en el segmento (app)/. Cuando el usuario está en (auth)/login, ese
//   Guard no está montado y no puede reaccionar al cambio de isAuthenticated.
//   Zustand actualiza el store, pero nadie escucha ese cambio para navegar.
//
//   SOLUCIÓN: el Root Layout es el único árbol que SIEMPRE está montado,
//   independientemente del segmento activo de Expo Router. Observar
//   isAuthenticated + useSegments() aquí y navegar de forma imperativa es
//   el patrón correcto para esta arquitectura de grupos de rutas separados.
//
//   La condición isSessionLoaded en el useEffect es CRÍTICA: evita
//   redirecciones prematuras mientras SecureStore está leyendo al arranque.
//   Sin ella, al abrir la app con sesión guardada habría un flash de
//   /(auth)/login antes de que loadStoredSession resuelva.
//
// Por qué PowerSync PRIMERO:
//   PowerSyncDatabase.init() abre el archivo SQLite en disco.
//   Si un componente hijo intenta hacer usePowerSyncQuery() antes de que
//   init() resuelva, la query falla silenciosamente con "database not open".
//   La barrera isPowerSyncReady garantiza que nunca ocurra.
//
// Por qué NO navegamos solo desde (app)/_layout.tsx:
//   El Guard en (app)/_layout.tsx solo protege el acceso directo a rutas del
//   grupo (app)/ (deep linking, restauración de sesión al arrancar). No está
//   montado cuando el usuario está en (auth)/, así que no puede reaccionar
//   al login. Ambos mecanismos son necesarios y complementarios.
//
// Por qué PowerSyncContext.Provider y NO PowerSyncProvider:
//   PowerSyncProvider no existe en @powersync/react 1.10.0. El contexto se
//   provee directamente con value={powerSyncDb}.
// =============================================================================

import { useEffect, useState, useCallback } from 'react'
import { View }                              from 'react-native'
import { Slot, useRouter, useSegments }      from 'expo-router'
import * as SplashScreen                     from 'expo-splash-screen'
import { QueryClientProvider }               from '@tanstack/react-query'
import { PowerSyncContext }                  from '@powersync/react'

import { trpc, createTrpcQueryClient }       from '../src/lib/trpc'
import { queryClient }                       from '../src/lib/queryClient'
import { initPowerSync, powerSyncDb }        from '../src/lib/powersync'
import { useAuthStore, selectIsAuthenticated } from '../src/store/auth'

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
  const isAuthenticated   = useAuthStore(selectIsAuthenticated)

  const router   = useRouter()
  const segments = useSegments()

  // ── Inicialización de PowerSync (solo SQLite) ───────────────────────────
  // connect() NO va aquí: antes corría en paralelo con SecureStore y fetchCredentials()
  // podía ejecutarse sin accessToken → WS 101 y cierre casi inmediato (nginx urt corto).
  useEffect(() => {
    initPowerSync()
      .then(() => setIsPowerSyncReady(true))
      .catch((err) => {
        console.error('[PowerSync] Error al inicializar:', err)
        setIsPowerSyncReady(true)
      })
  }, [])

  // ── Restaurar sesión DESPUÉS de que SQLite esté listo ────────────────────
  // Orden estricto: init → tokens en store → loadStoredSession.connect() en auth.ts
  useEffect(() => {
    if (!isPowerSyncReady) return
    loadStoredSession()
      .then(() => setIsSessionLoaded(true))
      .catch(() => setIsSessionLoaded(true))
  }, [isPowerSyncReady, loadStoredSession])

  // ── CORRECCIÓN BUG PIN-NAV: Navegación reactiva desde el layout raíz ─────
  //
  // Este useEffect es el corazón de la corrección. Observa dos señales:
  //   1. isAuthenticated — cambia cuando login() actualiza el store de Zustand
  //   2. isSessionLoaded — garantiza que no navegamos antes de leer SecureStore
  //
  // useSegments() devuelve el array de segmentos activos de Expo Router.
  // Ejemplo: ['(auth)', 'login'] cuando estamos en la pantalla de login.
  // Ejemplo: ['(app)', 'index'] cuando estamos en el dashboard.
  // segments[0] es suficiente para determinar en qué grupo de rutas estamos.
  //
  // Flujo login exitoso:
  //   1. handlePinSubmit llama a login() del store
  //   2. El store setea accessToken + user → isAuthenticated pasa a true
  //   3. Este useEffect se dispara: inAuthGroup=true, isAuthenticated=true
  //   4. router.replace('/(app)') navega al dashboard
  //
  // Flujo logout / kill switch:
  //   1. logout() o disconnectAndClear() limpia el store → isAuthenticated=false
  //   2. Este useEffect se dispara: inAppGroup=true, isAuthenticated=false
  //   3. router.replace('/(auth)/login') navega al login
  //
  // Flujo arranque con sesión guardada:
  //   1. loadStoredSession() carga tokens → isAuthenticated=true, isSessionLoaded=true
  //   2. Expo Router arranca en la ruta inicial (generalmente (auth)/login)
  //   3. Este useEffect se dispara: inAuthGroup=true, isAuthenticated=true
  //   4. router.replace('/(app)') redirige directamente al dashboard
  useEffect(() => {
    // Guardia: no actuar hasta que la sesión haya sido leída de SecureStore.
    // Sin esta condición, al arrancar la app habría un flash de /(auth)/login
    // (isAuthenticated=false inicial) antes de que loadStoredSession resuelva.
    if (!isSessionLoaded) return

    const inAuthGroup = segments[0] === '(auth)'
    const inAppGroup  = segments[0] === '(app)'

    if (isAuthenticated && inAuthGroup) {
      // Usuario autenticado intentando acceder a zona de auth → al dashboard
      router.replace('/(app)')
      return
    }

    if (!isAuthenticated && inAppGroup) {
      // Usuario no autenticado en zona protegida → al login
      // (cubre logout, kill switch por isActive=false, expiración sin refresh)
      router.replace('/(auth)/login')
      return
    }
  }, [isAuthenticated, isSessionLoaded, segments, router])

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
