// =============================================================================
// apps/api/src/context.ts
// Constructor del contexto tRPC
//
// OPERACIÓN BLINDAJE B2:
//   La resolución de DeviceToken usa prismaAuth (BYPASSRLS) en lugar de
//   prisma. Esto es necesario porque en este punto del request aún no
//   sabemos a qué tenant pertenece el token — no podemos llamar withTenant().
//   prismaAuth conecta con un usuario PostgreSQL que tiene BYPASSRLS solo
//   sobre las tablas DeviceToken, Device y User.
//   Ver lib/prisma.ts para instrucciones de configuración del usuario.
// =============================================================================

import { FastifyRequest, FastifyReply } from 'fastify'
import { inferAsyncReturnType }         from '@trpc/server'
import { prisma, prismaAuth }           from './lib/prisma'
import { verifyAccessToken, hashDeviceToken } from './lib/jwt'
import { AuthContext } from './types/auth'
import { Role }       from '@prisma/client'

interface CreateContextOptions {
  req: FastifyRequest
  res: FastifyReply
}

export async function createContext({ req }: CreateContextOptions) {
  let auth: AuthContext | null = null

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return { prisma, auth }
  }

  const token = authHeader.slice(7)

  // ---------------------------------------------------------------------------
  // Intento 1: verificar como JWT de usuario (WAITER_DEVICE, ADMIN_DEVICE)
  // No toca la BD — solo verifica la firma del JWT.
  // ---------------------------------------------------------------------------
  try {
    const payload = verifyAccessToken(token)
    auth = {
      tenantId:        payload.tenantId,
      establishmentId: payload.establishmentId,
      userId:          payload.sub,
      roles:           payload.roles,
    }
    return { prisma, auth }
  } catch {
    // No es un accessToken válido — intentar como DeviceToken
  }

  // ---------------------------------------------------------------------------
  // Intento 2: verificar como DeviceToken (PRINT_NODE, KIOSK_DEVICE)
  //
  // BLINDAJE B2: usa prismaAuth (BYPASSRLS) porque aún no tenemos tenantId.
  // La consulta busca por tokenHash (SHA-256 del token opaco) — un atacante
  // necesitaría el token en claro para obtener un hash válido.
  // Una vez obtenido el deviceToken, el tenantId está en device.tenantId
  // y todas las consultas posteriores del request van por withTenant().
  // ---------------------------------------------------------------------------
  try {
    const tokenHash = hashDeviceToken(token)

    // prismaAuth: BYPASSRLS — necesario porque no tenemos tenant todavía
    const deviceToken = await prismaAuth.deviceToken.findUnique({
      where:   { tokenHash },
      include: {
        device: true,
        // No incluimos establishment aquí — tenemos establishmentId directo
        // en device.establishmentId, evitando un JOIN innecesario.
      },
    })

    if (
      !deviceToken            ||
      deviceToken.revokedAt !== null ||
      deviceToken.expiresAt < new Date() ||
      !deviceToken.device.isActive
    ) {
      return { prisma, auth: null }
    }

    // Actualizar lastUsedAt sin bloquear el request (fire-and-forget)
    // Usa prismaAuth porque el DeviceToken tampoco tiene tenant en sesión aquí.
    prismaAuth.deviceToken
      .update({
        where: { id: deviceToken.id },
        data:  { lastUsedAt: new Date() },
      })
      .catch(() => {
        // No crítico — no interrumpir el request si falla el update
      })

    auth = {
      tenantId:        deviceToken.device.tenantId,
      establishmentId: deviceToken.device.establishmentId,
      deviceId:        deviceToken.deviceId,
      roles:           [] as Role[],
      deviceRole:      deviceToken.device.role,
    }

    return { prisma, auth }
  } catch {
    // Token inválido — auth permanece null
  }

  return { prisma, auth }
}

export type Context = inferAsyncReturnType<typeof createContext>
