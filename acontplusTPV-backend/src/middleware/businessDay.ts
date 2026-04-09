// =============================================================================
// apps/api/src/middleware/businessDay.ts
//
// Middleware tRPC que valida que existe una jornada abierta en el
// establecimiento del usuario autenticado antes de procesar cualquier
// transacción (pedidos, cobros, movimientos de inventario, etc.)
//
// USO en routers de transacciones:
//   import { withOpenDay } from '../middleware/businessDay'
//   import { barProcedure } from './auth'
//
//   const createOrder = barProcedure
//     .use(withOpenDay)           // ← garantiza jornada abierta
//     .input(createOrderSchema)
//     .mutation(async ({ ctx }) => {
//       // ctx.businessDay está disponible aquí con tipo completo
//       const { id: businessDayId } = ctx.businessDay
//       ...
//     })
//
// DISEÑO:
//   - Solo consulta la BD una vez por request (no por procedimiento)
//   - Inyecta ctx.businessDay en el contexto para que el router no
//     tenga que volver a buscarlo
//   - La validación ocurre en el servidor aunque el cliente diga que
//     la jornada está abierta (el cliente es offline-first y puede mentir)
// =============================================================================

import { TRPCError }    from '@trpc/server'
import { middleware }   from '../trpc'
import { withTenant }   from '../lib/rls'
import type { BusinessDay } from '@prisma/client'

// Extiende el contexto tRPC con la jornada activa
declare module '../context' {
  interface AuthContext {
    businessDay?: BusinessDay
  }
}

export const withOpenDay = middleware(async ({ ctx, next }) => {
  // Solo aplica a sesiones de usuario autenticado
  if (!ctx.auth?.userId && !ctx.auth?.deviceId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Autenticación requerida' })
  }

  const tenantId        = ctx.auth.tenantId
  const establishmentId = ctx.auth.establishmentId

  const businessDay = await withTenant(tenantId, (tx) =>
    tx.businessDay.findFirst({
      where: {
        tenantId,
        establishmentId,
        isOpen: true,
      },
    }),
  )

  if (!businessDay) {
    throw new TRPCError({
      code:    'PRECONDITION_FAILED',
      message: 'No hay una jornada abierta en este establecimiento. ' +
               'El administrador debe abrir la jornada antes de operar.',
    })
  }

  // Inyectar en el contexto para que el router lo use sin re-consultar
  return next({
    ctx: {
      ...ctx,
      businessDay,
    },
  })
})
