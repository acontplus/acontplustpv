// =============================================================================
// src/types/router.ts
// Tipo del AppRouter del backend — para type-safety en el cliente tRPC
//
// En repos separados (como es nuestro caso), este archivo define el tipo
// del router del backend sin importar el código de ejecución.
//
// CÓMO MANTENER SINCRONIZADO:
//   Opción A (manual): cuando el backend agrega un nuevo procedimiento,
//   añadir su firma aquí.
//
//   Opción B (automatizada, recomendada a futuro):
//   En el backend, ejecutar:
//     npx tsx scripts/generate-types.ts > ../acontplusTPV-mobile/src/types/router.ts
//   El script hace: import type { AppRouter } from './src/routers'; export type { AppRouter }
//
// Por ahora, definimos el tipo mínimo necesario para el Sprint 1.
// Los procedimientos de business se añadirán en sprints posteriores.
// =============================================================================

// Importación de tipo desde el backend (solo en desarrollo con path alias)
// En CI/CD se usa la versión copiada manualmente o generada por script

/**
 * Tipo del router completo del backend.
 * Reemplazar con el tipo real del backend cuando se configure el monorepo
 * o el script de generación.
 *
 * TEMPORAL: definición manual del subset necesario para Sprint 1.
 * Los tipos exactos (inputs/outputs) se infieren del schema Zod del backend.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppRouter = any

// ── NOTA PARA EL EQUIPO ───────────────────────────────────────────────────────
// Este `any` es temporal y deliberado para el Sprint 1.
// Permite que el cliente tRPC compile y funcione mientras configuramos
// la generación automática de tipos.
//
// Para activar el type-safety completo:
//   1. En el backend: añadir script de exportación de tipos
//   2. En el mobile: importar el tipo real
//      import type { AppRouter } from '../../../acontplusTPV-backend/src/routers'
//   O configurar un workspace de npm/yarn que comparta el paquete de tipos.
//
// El impacto de `any` aquí es localizado: solo afecta a los tipos de
// autocompletado del cliente tRPC, no a la seguridad de datos en runtime.
// =============================================================================
