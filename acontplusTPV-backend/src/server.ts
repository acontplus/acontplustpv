// =============================================================================
// apps/api/src/server.ts
//
// OPERACIÓN BLINDAJE B2:
//   La validación de usuario en /auth/powersync-token usa prismaAuth
//   (BYPASSRLS) en lugar de prisma. En ese endpoint ya tenemos el JWT
//   del usuario verificado (payload.sub, payload.tenantId), pero el RLS
//   fail-closed requiere un withTenant() para leer "User". Usar prismaAuth
//   aquí es correcto porque:
//   1. Ya verificamos la firma del JWT — sabemos que payload.sub es legítimo.
//   2. Solo leemos isActive y sin exponer datos de negocio.
//   3. Alternativa (withTenant) añadiría una transacción extra por request
//      de PowerSync, que puede ser frecuente en reconexiones offline.
// =============================================================================

import Fastify                  from 'fastify'
import cors                     from '@fastify/cors'
import { fastifyTRPCPlugin }    from '@trpc/server/adapters/fastify'
import { appRouter }            from './routers'
import { createContext }        from './context'
import { verifyAccessToken }    from './lib/jwt'
import { prismaAuth }           from './lib/prisma'
import jwt                      from 'jsonwebtoken'

const POWERSYNC_SECRET = process.env.POWERSYNC_JWT_SECRET!

if (!POWERSYNC_SECRET) {
  throw new Error('POWERSYNC_JWT_SECRET debe estar definido en las variables de entorno')
}

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'info',
    },
  })

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------
  await app.register(cors, {
    origin:      process.env.CORS_ORIGINS?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  })

  // ---------------------------------------------------------------------------
  // tRPC — API principal
  // ---------------------------------------------------------------------------
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router:  appRouter,
      createContext,
      onError: ({ error, path }: { error: Error; path?: string }) => {
        if (process.env.NODE_ENV === 'development') {
          console.error(`tRPC error en ${path}:`, error)
        }
      },
    },
  })

  // ---------------------------------------------------------------------------
  // PowerSync JWT endpoint
  //
  // BLINDAJE B2: usa prismaAuth (BYPASSRLS) para verificar isActive del
  // usuario. Ya tenemos payload.sub y payload.tenantId del JWT verificado,
  // pero necesitamos confirmar que el usuario no fue desactivado (kill switch).
  // prismaAuth tiene acceso SELECT a "User" con BYPASSRLS.
  // ---------------------------------------------------------------------------
  app.post('/auth/powersync-token', async (request, reply) => {
    const authHeader = request.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Token requerido' })
    }

    const accessToken = authHeader.slice(7)

    try {
      const payload = verifyAccessToken(accessToken)

      // prismaAuth: BYPASSRLS — verificar kill switch sin withTenant()
      // Solo necesitamos id + isActive, no datos de negocio del usuario.
      const user = await prismaAuth.user.findFirst({
        where: {
          id:       payload.sub,
          tenantId: payload.tenantId,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true },
      })

      if (!user) {
        return reply.status(401).send({ error: 'Usuario inactivo o no encontrado' })
      }

      const powerSyncToken = jwt.sign(
        {
          sub:             payload.sub,
          tenantId:        payload.tenantId,
          establishmentId: payload.establishmentId,
          roles:           payload.roles,
          iat:             Math.floor(Date.now() / 1000),
          exp:             Math.floor(Date.now() / 1000) + 3600,
        },
        POWERSYNC_SECRET,
        { algorithm: 'HS256' },
      )

      return reply.send({ token: powerSyncToken })
    } catch {
      return reply.status(401).send({ error: 'Token inválido' })
    }
  })

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  return app
}

async function main() {
  const app = await buildServer()

  try {
    const port = Number(process.env.API_PORT ?? 3000)
    const host = process.env.API_HOST ?? '0.0.0.0'
    await app.listen({ port, host })
    console.log(`API corriendo en http://${host}:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

main()
