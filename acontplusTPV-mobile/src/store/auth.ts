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
//      → trpcVanilla.auth.login.mutate(...)
//      → Guarda accessToken + refreshToken en SecureStore
//      → Obtiene powerSyncToken con /auth/powersync-token
//
//   2. refreshAccessToken() — llamado automáticamente por trpc.ts en 401
//      → trpcVanilla.auth.refresh.mutate(...)
//      → Si devuelve 401 (isActive=false): KILL SWITCH → disconnectAndClear()
//      → Si devuelve nuevo accessToken: guardar y devolver
//
//   3. logout()
//      → trpcVanilla.auth.logout.mutate()
//      → Limpiar SecureStore y estado local
//      → disconnectAndClear() de PowerSync
// =============================================================================

import { create }           from 'zustand'
import { immer }            from 'zustand/middleware/immer'
import * as SecureStore     from 'expo-secure-store'
import Constants            from 'expo-constants'

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

const API_URL = Constants.expoConfig?.extra?.apiUrl || 'http://localhost:3000'
const POWERSYNC_URL = Constants.expoConfig?.extra?.powerSyncUrl || 'http://localhost:8080'

async function disconnectPowerSyncSafely(): Promise<void> {
  const { disconnectAndClear } = require('../lib/powersync') as typeof import('../lib/powersync')
  await disconnectAndClear()
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
        // Importación lazy para evitar ciclo de dependencias en el arranque
        const { trpcVanilla } = await import('../lib/trpc')

        // Paso 1: autenticación con PIN
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

        const loginResult = await trpcVanilla.auth.login.mutate({
          tenantSlug,
          pin,
          establishmentId,
        }) as LoginResponse

        // Paso 2: obtener token de PowerSync (no bloquea el login si falla)
        const powerSyncUrl = Constants.expoConfig?.extra?.powerSyncUrl || POWERSYNC_URL
        try {
          const psResponse = await fetch(`${API_URL}/auth/powersync-token`, {
            method:  'POST',
            headers: {
              'Authorization': `Bearer ${loginResult.accessToken}`,
            },
          })
          if (!psResponse.ok) {
            console.warn('[auth] PowerSync token failed:', psResponse.status)
          }
        } catch (psErr) {
          console.warn('[auth] PowerSync token error (non-blocking):', psErr)
        }

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

        // PowerSync: connect() desde app/_layout.tsx (import estático —
        // el dynamic import desde el store puede no ser la misma instancia que el Provider).

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
    refreshAccessToken: async () => {
      const { refreshToken } = get()

      if (!refreshToken) return null

      try {
        const { trpcVanilla } = await import('../lib/trpc')

        type RefreshResponse = { accessToken: string }

        const result = await trpcVanilla.auth.refresh.mutate({
          refreshToken,
        }) as RefreshResponse

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
        // Instrucciones §2: 401 por isActive=false → disconnectAndClear()
        if (error.message?.includes('desactivado') || error.message?.includes('UNAUTHORIZED')) {
          await disconnectPowerSyncSafely()
          set(state => {
            state.accessToken  = null
            state.refreshToken = null
            state.user         = null
            state.powerSyncUrl = null
            state.businessDayId = null
            state.error        = null
          })
          await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN).catch(() => {})
          await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN).catch(() => {})
          await SecureStore.deleteItemAsync(KEYS.USER).catch(() => {})
        }

        return null
      }
    },

    // ── logout ────────────────────────────────────────────────────────────────
    logout: async () => {
      try {
        const { trpcVanilla } = await import('../lib/trpc')
        await trpcVanilla.auth.logout.mutate().catch(() => {})
      } catch {
        // Ignorar errores de logout — siempre limpiar localmente
      }

      await disconnectPowerSyncSafely()

      await SecureStore.deleteItemAsync(KEYS.ACCESS_TOKEN).catch(() => {})
      await SecureStore.deleteItemAsync(KEYS.REFRESH_TOKEN).catch(() => {})
      await SecureStore.deleteItemAsync(KEYS.USER).catch(() => {})

      set(state => {
        state.accessToken   = null
        state.refreshToken  = null
        state.user          = null
        state.powerSyncUrl  = null
        state.businessDayId = null
        state.isLoading     = false
        state.error         = null
      })
    },

    // ── loadStoredSession ─────────────────────────────────────────────────────
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
          state.powerSyncUrl = Constants.expoConfig?.extra?.powerSyncUrl || POWERSYNC_URL
        })

        // PowerSync: connect() en app/_layout.tsx tras session + init (misma instancia que Provider)

      } catch {
        // SecureStore vacío o datos corruptos — arrancar sin sesión
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

// ── Selectores precomputados (evitan re-renders innecesarios) ─────────────────
export const EMPTY_ROLES: UserRole[] = []

export const selectRoles = (s: AuthState & AuthActions): UserRole[] =>
  s.user?.roles ?? EMPTY_ROLES

export const selectIsAuthenticated = (s: AuthState & AuthActions): boolean =>
  s.accessToken !== null && s.user !== null
  
export const selectBusinessDayId = (s: AuthState & AuthActions): string | null =>
  s.businessDayId

export const selectUser = (s: AuthState & AuthActions): AuthUser | null =>
  s.user
