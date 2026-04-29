import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery } from '@powersync/react'
import { useAuthStore, selectUser } from '../store/auth'

const SYNC_TIMEOUT_MS = 5_000

export type ServiceModel = 'COUNTER' | 'DINE_IN'
export type EstablishmentSyncState = 'loading' | 'ready' | 'timeout' | 'error'

export interface EstablishmentRow {
  id: string
  tenant_id: string
  code: string
  name: string
  address: string | null
  phone: string | null
  service_model: ServiceModel
  is_active: number
}

export interface UseEstablishmentResult {
  establishment: EstablishmentRow | null
  serviceModel: ServiceModel | null
  syncState: EstablishmentSyncState
  isCounter: boolean
  isDineIn: boolean
  isLoading: boolean
  isReady: boolean
  isTimeout: boolean
  retry: () => void
}

export function useEstablishment(): UseEstablishmentResult {
  const user = useAuthStore(selectUser)
  const establishmentId = user?.establishmentId ?? ''

  const [syncState, setSyncState] = useState<EstablishmentSyncState>('loading')
  const [retryCount, setRetryCount] = useState(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const { data, isLoading, error } = useQuery<EstablishmentRow>(
    `SELECT
       id,
       tenant_id,
       code,
       name,
       address,
       phone,
       service_model,
       is_active
     FROM Establishment
     WHERE id = ?
       AND is_active = 1
     LIMIT 1`,
    [establishmentId, retryCount],
  )

  useEffect(() => {
    if (!establishmentId) return

    setSyncState('loading')

    timeoutRef.current = setTimeout(() => {
      setSyncState(prev => prev === 'loading' ? 'timeout' : prev)
    }, SYNC_TIMEOUT_MS)

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [establishmentId, retryCount])

  useEffect(() => {
    if (error) {
      setSyncState('error')
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      return
    }

    if (!isLoading && data !== undefined) {
      const hasData = (data ?? []).length > 0
      if (hasData) {
        setSyncState('ready')
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
      }
    }
  }, [data, isLoading, error])

  const retry = useCallback(() => {
    setSyncState('loading')
    setRetryCount(c => c + 1)
  }, [])

  const establishment = data?.[0] ?? null
  const serviceModel = establishment?.service_model ?? null

  return {
    establishment,
    serviceModel,
    syncState,
    isCounter: serviceModel === 'COUNTER',
    isDineIn: serviceModel === 'DINE_IN' || serviceModel === null,
    isLoading: syncState === 'loading',
    isReady: syncState === 'ready',
    isTimeout: syncState === 'timeout',
    retry,
  }
}
