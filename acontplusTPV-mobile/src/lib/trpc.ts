import { createTRPCReact }                from '@trpc/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { useAuthStore }                    from '../store/auth'

export const trpc = createTRPCReact() as any

function getApiUrl(): string {
  return 'https://api.resuelveyaa.com'
}

let isRefreshing = false
let refreshPromise: Promise<string | null> | null = null
const TRPC_DEBUG_NETWORK = true
const TRPC_FETCH_TIMEOUT_MS = 15000

function createTrpcLink() {
  return httpBatchLink({
    url: `${getApiUrl()}/trpc`,

    headers() {
      const { accessToken } = useAuthStore.getState()
      return {
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
        'Content-Type': 'application/json',
      }
    },

    fetch: async (url, options) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const startedAt = Date.now()
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), TRPC_FETCH_TIMEOUT_MS)

      const safeHeaders = {
        ...(options?.headers as Record<string, string> | undefined),
      }
      if (safeHeaders.Authorization) {
        safeHeaders.Authorization = `${safeHeaders.Authorization.slice(0, 20)}...`
      }

      if (TRPC_DEBUG_NETWORK) {
        console.log('[tRPC][request]', {
          requestId,
          url: String(url),
          method: options?.method ?? 'POST',
          hasBody: Boolean(options?.body),
          headers: safeHeaders,
        })
      }

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        })
        const elapsedMs = Date.now() - startedAt
        if (TRPC_DEBUG_NETWORK) {
          console.log('[tRPC][response]', {
            requestId,
            url: String(url),
            status: response.status,
            ok: response.ok,
            elapsedMs,
          })
        }

        const { refreshToken } = useAuthStore.getState()
        if (response.status !== 401 || !refreshToken) {
          return response
        }

        if (!isRefreshing) {
          isRefreshing = true
          refreshPromise = useAuthStore
            .getState()
            .refreshAccessToken()
            .catch(() => null)
            .finally(() => {
              isRefreshing   = false
              refreshPromise = null
            })
        }

        const newToken = await refreshPromise

        if (!newToken) {
          return response
        }

        const newOptions = {
          ...options,
          headers: {
            ...(options?.headers as Record<string, string>),
            Authorization: `Bearer ${newToken}`,
          },
          signal: controller.signal,
        }
        return fetch(url, newOptions)
      } catch (e) {
        const elapsedMs = Date.now() - startedAt
        console.log('[tRPC][network-error]', {
          requestId,
          url: String(url),
          elapsedMs,
          timeoutMs: TRPC_FETCH_TIMEOUT_MS,
          error: String(e),
        })
        throw e
      } finally {
        clearTimeout(timeoutId)
      }
    },
  })
}

export const trpcVanilla = createTRPCClient<any>({
  links: [createTrpcLink()],
})

export function createTrpcQueryClient() {
  return trpc.createClient({
    links: [createTrpcLink()],
  })
}
