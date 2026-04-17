// =============================================================================
// src/lib/queryClient.ts
// QueryClient singleton configurado para arquitectura Offline-First
//
// Decisiones de configuración:
//
//   staleTime: 5 minutos
//     Los datos de negocio (productos, mesas, pedidos) llegan por PowerSync
//     SQLite, no por React Query. Las queries tRPC son para mutaciones y
//     datos que no pasan por sync (businessDay status, reportes). Marcarlos
//     stale inmediatamente (default 0) provocaría refetches innecesarios.
//
//   retry: false
//     Offline es el estado NORMAL de esta app, no un error transitorio.
//     El default de React Query (retry: 3) generaría 3 intentos en red
//     antes de mostrar el error. En un restaurante sin WiFi esto significa
//     ~9 segundos de espera para ver un mensaje de "sin conexión".
//
//   networkMode: 'always'
//     Sin esto, React Query detecta ausencia de red y pausa todas las
//     queries en estado 'paused' en lugar de ejecutarlas y fallar rápido.
//     En Offline-First queremos que las queries intenten ejecutarse siempre
//     — PowerSync se encarga de los datos locales.
//
//   gcTime: 10 minutos (antes cacheTime)
//     Mantener resultados en caché 10 minutos para que la reconexión
//     no vacíe la UI mientras PowerSync re-sincroniza.
// =============================================================================

import { QueryClient } from '@tanstack/react-query'

// Singleton — una sola instancia en toda la app
// Se crea fuera de cualquier componente para sobrevivir re-renders del Root Layout
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 5 minutos antes de marcar datos como stale
      staleTime:   1000 * 60 * 5,

      // Sin reintentos — offline es normal, no un error transitorio
      retry:       false,

      // Ejecutar queries aunque no haya red detectada
      networkMode: 'always',

      // Mantener caché 10 minutos después de que el componente se desmonte
      gcTime:      1000 * 60 * 10,
    },
    mutations: {
      // Sin reintentos en mutaciones — el usuario debe decidir si reintentar
      retry:       false,

      // Permitir mutaciones offline (se encolarán para cuando haya conexión)
      networkMode: 'always',
    },
  },
})
