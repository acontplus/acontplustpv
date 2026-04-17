// =============================================================================
// src/store/auth.ts
// Store de autenticación — Zustand con persistencia en SecureStore
//
// Estado gestionado:
//   - accessToken / refreshToken
//   - Datos del usuario autenticado (id, name, roles, tenantId, establishmentId)
//   - Estado de la jornada activa (businessDayId)
//   - powerSyncUrl (viene del .env pero puede ser dinámico por tenant en el futuro)
//
// Flujo de autenticación (exacto al backend):
//   1. login(tenantSlug, pin, establishmentId)
//      → POST /trpc/auth.login
//      → Guarda accessToken + refreshToken en SecureStore
//      → Obtiene powerSyncToken con /auth/powersync-token
//
//   2. refreshAccessToken() — llamado automáticamente por trpc.ts en 401
//      → POST /trpc/auth.refresh con refreshToken
//      → Si devuelve 401 (isActive=false): KILL SWITCH → disconnectAndClear()
//      → Si devuelve nuevo accessToken: guardar y devolver
//
//   3. logout()
//      → POST /trpc/auth.logout
//      → Limpiar SecureStore y estado local
//      → disconnectAndClear() de PowerSync
// =============================================================================

import { create }           from 'zustand'
import { immer }            from 'zustand/middleware/immer'
import * as SecureStore     from 'expo-secure-store'
import Constants            from 'expo-constants'
import { disconnectAndClear } from '../lib/powersync'

// ── Tipos ─────────────────────────────────────────────────────────────────────

type UserRole = 'ADMIN' | 'CASHIER' | 'BARMAN' | 'WAITER'

interface AuthUser {
  id:              string
  name:            string
  roles:           UserRole[]
  tenantId:        string
  establishmentId: string
}

interface AuthState {
  // Tokens
  accessToken:   string | null
  refreshToken:  string | null

  // Usuario autenticado
  user:          AuthUser | null

  // PowerSync
  powerSyncUrl:  string | null

  // Estado de la jornada activa (se carga después del login)
  businessDayId: string | null

  // Estado de carga
  isLoading:     boolean
  error:         string | null
}

interface AuthActions {
  login:              (tenantSlug: string, pin: string, establishmentId: string) => Promise<void>
  refreshAccessToken: () => Promise<string | null>
  logout:             () => Promise<void>
  loadStoredSession:  () => Promise<void>
  setBusinessDayId:   (id: string | null) => void
  clearError:         () => void
}

// ── Claves de SecureStore ────────────────────────────────────────────────────
const KEYS = {
  ACCESS_TOKEN:  'acontplus_access_token',
  REFRESH_TOKEN: 'acontplus_refresh_token',
  USER:          'acontplus_user',
} as const

// ── Helper: fetch directo sin tRPC (para bootstrap antes de que el cliente exista) ──

async function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? ''
  const res = await fetch(`${apiUrl}/trpc/${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ json: body }),
  })

  const json = await res.json() as { result?: { data?: { json: T } }; error?: { message: string; data?: { code: string } } }

  if (!res.ok || json.error) {
    const error = new Error(json.error?.message ?? 'Error de red')
    // Añadir el código HTTP para que el interceptor detecte 401
    ;(error as Error & { status: number }).status = res.status
    ;(error as Error & { code: string }).code = json.error?.data?.code ?? 'UNKNOWN'
    throw error
  }

  return json.result!.data!.json
}

// =============================================================================
// STORE
// =============================================================================

export const useAuthStore = create<AuthState & AuthActions>()(
  immer((set, get) => ({
    // ── Estado inicial ────────────────────────────────────────────────────────
    accessToken:   null,
    refreshToken:  null,
    user:          null,
    powerSyncUrl:  null,
    businessDayId: null,
    isLoading:     false,
    error:         null,

    // ── login ─────────────────────────────────────────────────────────────────
    login: async (tenantSlug, pin, establishmentId) => {
      set(state => { state.isLoading = true; state.error = null })

      try {
        // Paso 1: autenticación con PIN
        // Flujo exacto del backend: auth.login → {accessToken, refreshToken, user}
        type LoginResponse = {
          accessToken:  string
          refreshToken: string
          user: {
            id:              string
            name:            string
            roles:           UserRole[]
            tenantId:        string
            establishmentId: string
          }
        }

        const loginResult = await apiPost<LoginResponse>('auth.login', {
          tenantSlug,
          pin,
          establishmentId,
        })

        // Paso 2: obtener token de PowerSync con el accessToken recién obtenido
        const apiUrl = Constants.expoConfig?.extra?.apiUrl ?? ''
        const psResponse = await fetch(`${apiUrl}/auth/powersync-token`, {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${loginResult.accessToken}`,
            'Content-Type':  'application/json',
          },
        })

        if (!psResponse.ok) {
          throw new Error('No se pudo obtener el token de sincronización')
        }

        const psData = await psResponse.json() as { token: string }
        const powerSyncUrl = Constants.expoConfig?.extra?.powerSyncUrl ?? ''

        // Paso 3: persistir tokens en SecureStore
        await SecureStore.setItemAsync(KEYS.ACCESS_TOKEN,  loginResult.accessToken)
        await SecureStore.setItemAsync(KEYS.REFRESH_TOKEN, loginResult.refreshToken)
        await SecureStore.setItemAsync(KEYS.USER, JSON.stringify(loginResult.user))

        // Paso 4: actualizar estado
        set(state => {
          state.accessToken  = loginResult.accessToken
          state.refreshToken = loginResult.refreshToken
          state.user         = loginResult.user
          state.powerSyncUrl = powerSyncUrl
          state.isLoading    = false
          state.error        = null
        })

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Error al iniciar sesión'
        set(state => {
          state.isLoading = false
          state.error     = message
        })
        throw err
      }
    },

    // ── refreshAccessToken ────────────────────────────────────────────────────
    // Instrucciones §2: SOLO activar disconnectAndClear() si el 401 viene
    // de isActive = false, NO por expiración natural del token.
    refreshAccessToken: async () => {
      const { refreshToken } = get()

      if (!refreshToken) return null

      try {
        type RefreshResponse = { accessToken: string }

        const result = await apiPost<RefreshResponse>(
          'auth.refresh',
          { refreshToken },
        )

        // Guardar el nuevo accessToken
        await SecureStore.setItemAsync(KEYS.ACCESS_TOKEN, result.accessToken)

        set(state => {
          state.accessToken = result.accessToken
        })

        return result.accessToken

      } catch (err: unknown) {
        const error = err as Error & { status?: number; code?: string; message: string }

        // KILL SWITCH: activar disconnectAndClear() ÚNICAMENTE cuando el backend
        // confirma explícitamente que el usuario fue desactivado (isActive = false).
        //
        // El endpoint auth.refresh devuelve code: 'UNAUTHORIZED' en 4 escenarios:
        //   1. refreshToken con firma inválida o expirado  → NO borrar datos
        //   2. hash del refreshToken no coincide           → NO borrar datos
        //   3. usuario no encontrado en BD                 → NO borrar datos
        //   4. user.isActive === false                     → SÍ borrar datos ✓
        //
        // El único discriminador fiable entre estos casos es el message exacto
        // que devuelve el backend (src/routers/auth.ts, caso isActive = false).
        // Instrucciones §2: "la app SOLO ejecuta disconnectAndClear() cuando
        // recibe 401 por isActive = false, NO por expiración natural del token."
        const isKillSwitch =
          (error.status === 401 || error.code === 'UNAUTHORIZED') &&
          error.message === 'Usuario desactivado'

        if (isKillSwitch) {
          // Limpiar estado local
          await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN)
          await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN)
          await SecureStore.deleteItemAsync(KEYS.USER)

          set(state => {
            state.accessToken   = null
            state.refreshToken  = null
            state.user          = null
            state.businessDayId = null
            state.error         = 'Tu sesión ha sido desactivada. Contacta al administrador.'
          })

          // Borrar todos los datos locales de PowerSync
          await disconnectAndClear()
        }

        return null
      }
    },

    // ── logout ─────────────────────────────────────────────────────────────────
    logout: async () => {
      const { accessToken } = get()

      // Intentar invalidar el refreshToken en el servidor (best-effort)
      if (accessToken) {
        try {
          await apiPost('auth.logout', {}, accessToken)
        } catch {
          // No crítico — limpiar localmente de todos modos
        }
      }

      // Limpiar SecureStore
      await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN)
      await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN)
      await SecureStore.deleteItemAsync(KEYS.USER)

      // Limpiar estado Zustand
      set(state => {
        state.accessToken   = null
        state.refreshToken  = null
        state.user          = null
        state.businessDayId = null
        state.error         = null
      })

      // Desconectar PowerSync y borrar base de datos local
      await disconnectAndClear()
    },

    // ── loadStoredSession ─────────────────────────────────────────────────────
    // Llamar al arrancar la app para restaurar la sesión almacenada
    loadStoredSession: async () => {
      try {
        const [accessToken, refreshToken, userJson] = await Promise.all([
          SecureStore.getItemAsync(KEYS.ACCESS_TOKEN),
          SecureStore.getItemAsync(KEYS.REFRESH_TOKEN),
          SecureStore.getItemAsync(KEYS.USER),
        ])

        if (!accessToken || !refreshToken || !userJson) return

        const user = JSON.parse(userJson) as AuthUser

        set(state => {
          state.accessToken  = accessToken
          state.refreshToken = refreshToken
          state.user         = user
          state.powerSyncUrl = Constants.expoConfig?.extra?.powerSyncUrl ?? null
        })
      } catch {
        // SecureStore vacío o corrupto — arrancar sin sesión
      }
    },

    // ── setBusinessDayId ──────────────────────────────────────────────────────
    setBusinessDayId: (id) => {
      set(state => { state.businessDayId = id })
    },

    // ── clearError ────────────────────────────────────────────────────────────
    clearError: () => {
      set(state => { state.error = null })
    },
  })),
)

// ── Selector helpers ─────────────────────────────────────────────────────────
// Evitan re-renders innecesarios al suscribirse solo a lo que se necesita.
//
// REGLA CRÍTICA — Zustand v5 + React 18 (useSyncExternalStore):
//   React llama a getSnapshot() dos veces para verificar consistencia.
//   Si el selector devuelve un objeto/array NUEVO en cada llamada
//   (aunque con el mismo contenido), React lanza:
//   "Warning: The result of getSnapshot should be cached to avoid an infinite loop"
//
//   Solución: nunca devolver literales inline como fallback.
//   Usar una constante estable de módulo en su lugar.
//   EMPTY_ROLES es creado UNA sola vez al cargar el módulo — siempre
//   es el mismo objeto en memoria → React.is() devuelve true → sin warning.

const EMPTY_ROLES: UserRole[] = []

export const selectIsAuthenticated = (s: AuthState) => !!s.accessToken && !!s.user
export const selectUser            = (s: AuthState) => s.user
export const selectRoles           = (s: AuthState) => s.user?.roles ?? EMPTY_ROLES
export const selectBusinessDayId   = (s: AuthState) => s.businessDayId
export const selectIsAdmin         = (s: AuthState) => s.user?.roles.includes('ADMIN') ?? false
export const selectIsCashier       = (s: AuthState) =>
  s.user?.roles.some(r => ['ADMIN', 'CASHIER'].includes(r)) ?? false
