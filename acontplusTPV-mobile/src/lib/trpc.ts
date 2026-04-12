// =============================================================================
// src/lib/trpc.ts
// Cliente tRPC para React Native
//
// Patrón: httpBatchLink con interceptor de 401 para refresh automático.
// El cliente es un singleton — se configura una vez al arrancar la app.
//
// Decisión: httpBatchLink (no httpLink) porque:
//   - Agrupa múltiples queries en un solo request HTTP
//   - Reduce el overhead de red en zonas de baja cobertura (restaurantes reales)
//   - Expo/React Native soporta batch nativamente
// =============================================================================

import { createTRPCReact }   from '@trpc/react-query'
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client'
import Constants              from 'expo-constants'
import { useAuthStore }       from '../store/auth'

// Importación del tipo del router del backend — type-only, no genera bundle
// En un monorepo esto vendría de @acontplus/api/types
// En repos separados, copiar/generar el tipo aquí
import type { AppRouter }     from '../types/router'

// ── Re-exportar el tipo para uso en la app ──────────────────────────────────
export type { AppRouter }

// ── Instancia de tRPC para React (hooks) ────────────────────────────────────
export const trpc = createTRPCReact<AppRouter>()

// ── Obtener la URL base de la API ────────────────────────────────────────────
function getApiUrl(): string {
  return Constants.expoConfig?.extra?.apiUrl ?? 'https://api.tudominio.com'
}

// =============================================================================
// LINK CON INTERCEPTOR DE 401
// Reintenta la petición una vez después de refrescar el accessToken.
// Si el refresh falla por kill switch (isActive=false), el auth store
// ejecuta disconnectAndClear() y el usuario vuelve al login.
// =============================================================================

let isRefreshing = false
let refreshPromise: Promise<string | null> | null = null

/**
 * Crea el httpBatchLink con lógica de retry automático en 401.
 * Se recrea cuando el accessToken cambia (ver trpcClient abajo).
 */
function createTrpcLink() {
  return httpBatchLink({
    url: `${getApiUrl()}/trpc`,

    // Headers dinámicos — se evalúan en cada petición
    headers() {
      const { accessToken } = useAuthStore.getState()
      return {
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        'Content-Type': 'application/json',
      }
    },

    // fetch personalizado con interceptor de 401
    fetch: async (url, options) => {
      const response = await fetch(url, options)

      // Si no es 401 o no tenemos refresh token, devolver tal cual
      const { refreshToken } = useAuthStore.getState()
      if (response.status !== 401 || !refreshToken) {
        return response
      }

      // Evitar múltiples refreshes concurrentes (race condition)
      if (!isRefreshing) {
        isRefreshing = true
        refreshPromise = useAuthStore.getState().refreshAccessToken().finally(() => {
          isRefreshing    = false
          refreshPromise  = null
        })
      }

      // Esperar a que el refresh termine (todos los requests en vuelo comparten)
      const newToken = await refreshPromise

      if (!newToken) {
        // Kill switch activado — devolver el 401 original para que tRPC lo propague
        return response
      }

      // Reintentar la petición original con el nuevo token
      const newOptions = {
        ...options,
        headers: {
          ...(options?.headers as Record<string, string>),
          Authorization: `Bearer ${newToken}`,
        },
      }
      return fetch(url, newOptions)
    },
  })
}

// =============================================================================
// CLIENTE VANILLA (sin React Query) — para llamadas fuera de componentes
// Por ejemplo: en el auth store, en initPowerSync, etc.
// =============================================================================

export const trpcVanilla = createTRPCClient<AppRouter>({
  links: [createTrpcLink()],
})

// =============================================================================
// CONFIGURACIÓN DE REACT QUERY PARA tRPC
// Exportar la función que crea el cliente — se instancia en el provider
// =============================================================================

export function createTrpcQueryClient() {
  return trpc.createClient({
    links: [createTrpcLink()],
  })
}
