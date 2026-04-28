// =============================================================================
// apps/api/src/routers/auth.ts
// Router de autenticación
//
// Procedimientos públicos (sin autenticación):
//   - login                → PIN + tenantSlug → accessToken + refreshToken
//   - refresh              → refreshToken → nuevo accessToken
//   - listEstablishments   → tenantSlug → lista de establecimientos activos
//
// Procedimientos protegidos:
//   - logout             → invalida el refreshToken del usuario actual
//   - generateDeviceToken → ADMIN genera token para PRINT_NODE o KIOSK_DEVICE
//   - revokeDeviceToken  → ADMIN revoca un DeviceToken existente
// =============================================================================

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, procedure } from '../trpc'
import { adminProcedure, userProcedure } from '../middleware/auth'
import { prisma } from '../lib/prisma'
import { withTenant } from '../lib/rls'
import { verifyPin } from '../lib/bcrypt'
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  generateDeviceToken,
  hashDeviceToken,
  deviceTokenExpiresAt,
} from '../lib/jwt'
import { LoginResponse, RefreshResponse, GenerateDeviceTokenResponse } from '../types/auth'
import { DeviceRole } from '@prisma/client'

export const authRouter = router({

  // ---------------------------------------------------------------------------
  // listEstablishments
  // Endpoint público — retorna establecimientos activos de un tenant por slug.
  // Se llama ANTES del login para que el usuario seleccione su establecimiento.
  // No requiere autenticación — el slug del tenant es información pública
  // compartida por todos los empleados del negocio.
  // ---------------------------------------------------------------------------
  listEstablishments: procedure
    .input(z.object({ tenantSlug: z.string().min(1) }))
    .query(async ({ input }) => {
      const tenant = await prisma.tenant.findUnique({
        where: { slug: input.tenantSlug },
      })

      if (!tenant || !tenant.isActive) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Tenant no encontrado',
        })
      }

      const establishments = await withTenant(tenant.id, (tx) =>
        tx.establishment.findMany({
          where: {
            tenantId:  tenant.id,
            isActive:  true,
            deletedAt: null,
          },
          select: {
            id:   true,
            name: true,
            code: true,
          },
          orderBy: { code: 'asc' },
        }),
      )

      return establishments
    }),

  // ---------------------------------------------------------------------------
  // login
  // El PIN viaja por HTTPS y se hashea en el servidor (Decisión §Auth-2)
  // ---------------------------------------------------------------------------
  login: procedure
    .input(
      z.object({
        tenantSlug:      z.string().min(1),
        pin:             z.string().regex(/^\d{4}$/, 'El PIN debe ser 4 dígitos'),
        establishmentId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input }): Promise<LoginResponse> => {
      // 1. Resolver el tenant por slug
      const tenant = await prisma.tenant.findUnique({
        where: { slug: input.tenantSlug },
      })

      if (!tenant || !tenant.isActive) {
        throw new TRPCError({
          code:    'UNAUTHORIZED',
          message: 'Credenciales inválidas',
          // Mensaje genérico — no revelar si el tenant existe o no
        })
      }

      // 2. Buscar usuarios activos del tenant con sus roles
      //    Usamos withTenant para que RLS filtre correctamente
      const user = await withTenant(tenant.id, (tx) =>
        tx.user.findFirst({
          where: {
            tenantId:  tenant.id,
            isActive:  true,
            deletedAt: null,
          },
          include: { roles: true },
        }),
      )

      // Nota: aquí buscamos todos los usuarios activos y verificamos PIN uno a uno.
      // En producción con muchos usuarios sería más eficiente buscar por un
      // identificador adicional (ej: número de empleado). Para 4-10 usuarios
      // por tenant este enfoque es perfectamente viable.

      // 3. Verificar PIN contra todos los usuarios activos del tenant
      //    (el PIN de 4 dígitos no es único entre usuarios, pero el tenant sí acota el scope)
      const allUsers = await withTenant(tenant.id, (tx) =>
        tx.user.findMany({
          where: {
            tenantId:  tenant.id,
            isActive:  true,
            deletedAt: null,
          },
          include: { roles: true },
        }),
      )

      let matchedUser: typeof allUsers[0] | null = null
      for (const candidate of allUsers) {
        const match = await verifyPin(input.pin, candidate.pinHash)
        if (match) {
          matchedUser = candidate
          break
        }
      }

      if (!matchedUser) {
        throw new TRPCError({
          code:    'UNAUTHORIZED',
          message: 'Credenciales inválidas',
        })
      }

      // 4. Verificar que el establecimiento pertenece al tenant
      const establishment = await withTenant(tenant.id, (tx) =>
        tx.establishment.findFirst({
          where: {
            id:        input.establishmentId,
            tenantId:  tenant.id,
            isActive:  true,
            deletedAt: null,
          },
        }),
      )

      if (!establishment) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'Establecimiento no encontrado o inactivo',
        })
      }

      // 5. Generar tokens
      const roles = matchedUser.roles.map((r) => r.role)

      const accessToken = signAccessToken({
        sub:             matchedUser.id,
        tenantId:        tenant.id,
        establishmentId: establishment.id,
        roles,
      })

      const refreshToken = signRefreshToken({
        sub:      matchedUser.id,
        tenantId: tenant.id,
      })

      // 6. Guardar hash del refreshToken en el usuario
      //    Permite revocación inmediata al desactivar el usuario
      await withTenant(tenant.id, (tx) =>
        tx.user.update({
          where: { id: matchedUser!.id },
          data:  { refreshTokenHash: hashDeviceToken(refreshToken) },
        }),
      )

      return {
        accessToken,
        refreshToken,
        user: {
          id:              matchedUser.id,
          name:            matchedUser.name,
          roles,
          tenantId:        tenant.id,
          establishmentId: establishment.id,
        },
      }
    }),

  // ---------------------------------------------------------------------------
  // refresh
  // Instrucciones §2: la app ejecuta disconnectAndClear() SOLO en 401 por
  // isActive = false, no por expiración natural del token
  // ---------------------------------------------------------------------------
  refresh: procedure
    .input(z.object({ refreshToken: z.string().min(1) }))
    .mutation(async ({ input }): Promise<RefreshResponse> => {
      // 1. Verificar firma y expiración del refreshToken
      let payload: ReturnType<typeof verifyRefreshToken>
      try {
        payload = verifyRefreshToken(input.refreshToken)
      } catch {
        throw new TRPCError({
          code:    'UNAUTHORIZED',
          message: 'Refresh token inválido o expirado',
        })
      }

      // 2. Buscar el usuario y verificar que el hash coincide y está activo
      const user = await withTenant(payload.tenantId, (tx) =>
        tx.user.findFirst({
          where: {
            id:        payload.sub,
            tenantId:  payload.tenantId,
            deletedAt: null,
          },
          include: { roles: true },
        }),
      )

      if (!user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Usuario no encontrado' })
      }

      // 3. Verificar que el refreshToken almacenado coincide
      //    Esto invalida tokens anteriores si el usuario hizo login desde otro dispositivo
      const storedHash = user.refreshTokenHash
      const incomingHash = hashDeviceToken(input.refreshToken)

      if (!storedHash || storedHash !== incomingHash) {
        throw new TRPCError({
          code:    'UNAUTHORIZED',
          message: 'Refresh token inválido',
        })
      }

      // 4. Verificar isActive — AQUÍ está el kill switch
      //    Si isActive = false → 401 → la app ejecuta disconnectAndClear()
      if (!user.isActive) {
        throw new TRPCError({
          code:    'UNAUTHORIZED',
          message: 'Usuario desactivado',
          // La app móvil detecta este 401 específico y ejecuta:
          // await db.disconnectAndClear()
          // Instrucciones §2: Kill switch
        })
      }

      // 5. Obtener el establecimiento activo del usuario
      //    Reutilizamos el primer establecimiento activo del tenant como fallback
      const establishment = await withTenant(payload.tenantId, (tx) =>
        tx.establishment.findFirst({
          where: {
            tenantId:  payload.tenantId,
            isActive:  true,
            deletedAt: null,
          },
          orderBy: { code: 'asc' },
        }),
      )

      if (!establishment) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Sin establecimientos activos' })
      }

      // 6. Emitir nuevo accessToken
      const roles = user.roles.map((r) => r.role)
      const accessToken = signAccessToken({
        sub:             user.id,
        tenantId:        payload.tenantId,
        establishmentId: establishment.id,
        roles,
      })

      return { accessToken }
    }),

  // ---------------------------------------------------------------------------
  // logout
  // Invalida el refreshToken del usuario actual
  // ---------------------------------------------------------------------------
  logout: userProcedure
    .mutation(async ({ ctx }) => {
      await withTenant(ctx.auth.tenantId, (tx) =>
        tx.user.update({
          where: { id: ctx.auth.userId },
          data:  { refreshTokenHash: null },
        }),
      )
      return { success: true }
    }),

  // ---------------------------------------------------------------------------
  // generateDeviceToken
  // Solo ADMIN puede generar tokens para PRINT_NODE o KIOSK_DEVICE
  // Instrucciones §2: DeviceToken de 30 días para dispositivos desatendidos
  // ---------------------------------------------------------------------------
  generateDeviceToken: adminProcedure
    .input(
      z.object({
        deviceId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<GenerateDeviceTokenResponse> => {
      // 1. Verificar que el dispositivo pertenece al tenant del admin
      const device = await withTenant(ctx.auth.tenantId, (tx) =>
        tx.device.findFirst({
          where: {
            id:        input.deviceId,
            tenantId:  ctx.auth.tenantId,
            isActive:  true,
            deletedAt: null,
          },
        }),
      )

      if (!device) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Dispositivo no encontrado o inactivo',
        })
      }

      // 2. Solo PRINT_NODE y KIOSK_DEVICE usan DeviceToken
      if (
        device.role !== DeviceRole.PRINT_NODE &&
        device.role !== DeviceRole.KIOSK_DEVICE
      ) {
        throw new TRPCError({
          code:    'BAD_REQUEST',
          message: 'Los DeviceToken solo se emiten para PRINT_NODE y KIOSK_DEVICE',
        })
      }

      // 3. Revocar cualquier token activo previo del dispositivo
      await withTenant(ctx.auth.tenantId, (tx) =>
        tx.deviceToken.updateMany({
          where: {
            deviceId:  input.deviceId,
            tenantId:  ctx.auth.tenantId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        }),
      )

      // 4. Generar nuevo token
      const { plain, hash } = generateDeviceToken()
      const expiresAt = deviceTokenExpiresAt()

      await withTenant(ctx.auth.tenantId, (tx) =>
        tx.deviceToken.create({
          data: {
            tenantId:  ctx.auth.tenantId,
            deviceId:  input.deviceId,
            tokenHash: hash,
            expiresAt,
          },
        }),
      )

      return {
        token:    plain, // Se muestra UNA sola vez — nunca se almacena en claro
        deviceId: input.deviceId,
        expiresAt,
      }
    }),

  // ---------------------------------------------------------------------------
  // revokeDeviceToken
  // Solo ADMIN puede revocar un DeviceToken
  // ---------------------------------------------------------------------------
  revokeDeviceToken: adminProcedure
    .input(z.object({ deviceId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const count = await withTenant(ctx.auth.tenantId, (tx) =>
        tx.deviceToken.updateMany({
          where: {
            deviceId:  input.deviceId,
            tenantId:  ctx.auth.tenantId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        }),
      )

      return {
        success:  true,
        revoked:  count.count,
      }
    }),
})