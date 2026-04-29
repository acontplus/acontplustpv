import { useCallback } from 'react'
import { useRouter } from 'expo-router'
import { useEstablishment } from './useEstablishment'
import type { EstablishmentSyncState } from './useEstablishment'

export interface UseNewOrderResult {
  startNewOrder: () => void
  canStartOrder: boolean
  syncState: EstablishmentSyncState
  isCounter: boolean
  isDineIn: boolean
  isLoading: boolean
  retry: () => void
}

const ROUTES = {
  DINE_IN: '/(app)/new-order/table-select' as const,
  COUNTER: '/(app)/new-order' as const,
  FALLBACK: '/(app)/new-order/table-select' as const,
} as const

export function useNewOrder(): UseNewOrderResult {
  const router = useRouter()
  const {
    syncState,
    isCounter,
    isDineIn,
    isLoading,
    retry,
  } = useEstablishment()

  const startNewOrder = useCallback(() => {
    if (syncState === 'loading' || syncState === 'error') return

    if (syncState === 'timeout') {
      router.push(ROUTES.FALLBACK)
      return
    }

    if (isCounter) {
      router.push(ROUTES.COUNTER)
    } else {
      router.push(ROUTES.DINE_IN)
    }
  }, [syncState, isCounter, router])

  const canStartOrder = syncState === 'ready' || syncState === 'timeout'

  return {
    startNewOrder,
    canStartOrder,
    syncState,
    isCounter,
    isDineIn,
    isLoading,
    retry,
  }
}
