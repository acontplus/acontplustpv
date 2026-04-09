// =============================================================================
// apps/api/src/middleware/auth.ts
// Middleware tRPC de autenticación y autorización por roles
// =============================================================================

import { TRPCError } from '@trpc/server'
import { middleware, procedure } from '../trpc'
import { Role, DeviceRole } from '@prisma/client'

// ---------------------------------------------------------------------------
// Middleware base: verifica que el request está autenticado
// ---------------------------------------------------------------------------
const isAuthenticated = middleware(({ ctx, next }) => {
  if (!ctx.auth) {
    throw new TRPCError({
      code:    'UNAUTHORIZED',
      message: 'Token de autenticación requerido',
    })
  }
  return next({
    ctx: {
      ...ctx,
      auth: ctx.auth, // narrowing: auth no es null a partir de aquí
    },
  })
})

// ---------------------------------------------------------------------------
// Middleware de usuario: verifica que hay un userId (no solo deviceId)
// Previene que PRINT_NODE o KIOSK_DEVICE accedan a procedimientos de usuario
// ---------------------------------------------------------------------------
const isUser = middleware(({ ctx, next }) => {
  if (!ctx.auth?.userId) {
    throw new TRPCError({
      code:    'FORBIDDEN',
      message: 'Este procedimiento requiere autenticación de usuario, no de dispositivo',
    })
  }
  return next({
    ctx: {
      ...ctx,
      auth: {
        ...ctx.auth!,
        userId: ctx.auth!.userId as string,
      },
    },
  })
})

// ---------------------------------------------------------------------------
// Factory: crea un middleware que verifica uno o más roles
// ---------------------------------------------------------------------------
function requireRoles(...requiredRoles: Role[]) {
  return middleware(({ ctx, next }) => {
    if (!ctx.auth?.userId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Autenticación de usuario requerida' })
    }
    const hasRole = requiredRoles.some((r) => ctx.auth!.roles.includes(r))
    if (!hasRole) {
      throw new TRPCError({
        code:    'FORBIDDEN',
        message: `Roles requeridos: ${requiredRoles.join(', ')}. Tu rol actual no tiene permiso.`,
      })
    }
    return next({ ctx })
  })
}

// ---------------------------------------------------------------------------
// Factory: verifica que el dispositivo tiene el DeviceRole esperado
// ---------------------------------------------------------------------------
function requireDeviceRole(...requiredRoles: DeviceRole[]) {
  return middleware(({ ctx, next }) => {
    if (!ctx.auth?.deviceRole) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Autenticación de dispositivo requerida' })
    }
    if (!requiredRoles.includes(ctx.auth.deviceRole)) {
      throw new TRPCError({
        code:    'FORBIDDEN',
        message: `Rol de dispositivo requerido: ${requiredRoles.join(', ')}`,
      })
    }
    return next({ ctx })
  })
}

// ---------------------------------------------------------------------------
// Procedimientos pre-configurados para uso en routers
// ---------------------------------------------------------------------------

/** Cualquier token válido (usuario o dispositivo) */
export const authenticatedProcedure = procedure.use(isAuthenticated)

/** Solo usuarios autenticados (no dispositivos desatendidos) */
export const userProcedure = procedure.use(isAuthenticated).use(isUser)

/** Solo ADMIN */
export const adminProcedure = userProcedure.use(requireRoles(Role.ADMIN))

/** ADMIN o CASHIER */
export const cashierProcedure = userProcedure.use(requireRoles(Role.ADMIN, Role.CASHIER))

/** ADMIN, CASHIER o BARMAN */
export const barProcedure = userProcedure.use(
  requireRoles(Role.ADMIN, Role.CASHIER, Role.BARMAN),
)

/** Cualquier rol de usuario (ADMIN, CASHIER, BARMAN, WAITER) */
export const anyUserRoleProcedure = userProcedure.use(
  requireRoles(Role.ADMIN, Role.CASHIER, Role.BARMAN, Role.WAITER),
)

/** Solo PRINT_NODE */
export const printNodeProcedure = authenticatedProcedure.use(
  requireDeviceRole(DeviceRole.PRINT_NODE),
)

/** Solo KIOSK_DEVICE */
export const kioskProcedure = authenticatedProcedure.use(
  requireDeviceRole(DeviceRole.KIOSK_DEVICE),
)
