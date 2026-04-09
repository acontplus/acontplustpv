// =============================================================================
// apps/api/src/lib/prisma.ts
// Clientes Prisma — dos instancias con propósitos distintos
//
// prisma     → cliente principal, sujeto a RLS.
//              TODA consulta de negocio debe pasar por withTenant() para
//              establecer app.current_tenant_id antes de leer/escribir.
//              Sin tenant configurado → cero filas visibles (fail-closed).
//
// prismaAuth → cliente de autenticación, conectado con DATABASE_URL_AUTH.
//              Usa un usuario PostgreSQL con BYPASSRLS para las tablas de
//              autenticación (DeviceToken, Device, User).
//              SOLO debe usarse en context.ts y server.ts para resolver
//              tokens ANTES de saber a qué tenant pertenecen.
//              NUNCA usarlo para consultas de negocio.
//
// Configuración .env requerida:
//   DATABASE_URL      → usuario 'acontplus_app'  (sujeto a RLS)
//   DATABASE_URL_AUTH → usuario 'acontplus_auth' (BYPASSRLS, mínimo privilegio)
//
// Crear el usuario en PostgreSQL (ejecutar una sola vez como superusuario):
//   CREATE ROLE acontplus_auth LOGIN PASSWORD 'CONTRASEÑA_SEGURA';
//   GRANT CONNECT ON DATABASE "acontplusTPV" TO acontplus_auth;
//   GRANT USAGE ON SCHEMA public TO acontplus_auth;
//   GRANT SELECT ON "DeviceToken", "Device", "User" TO acontplus_auth;
//   GRANT UPDATE ("lastUsedAt") ON "DeviceToken" TO acontplus_auth;
//   ALTER ROLE acontplus_auth BYPASSRLS;
// =============================================================================

import { PrismaClient } from '@prisma/client'

// ─── Cliente principal (sujeto a RLS) ─────────────────────────────────────────
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development'
      ? ['query', 'warn', 'error']
      : ['warn', 'error'],
    datasources: {
      db: { url: process.env.DATABASE_URL },
    },
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// ─── Cliente de autenticación (BYPASSRLS, pool pequeño) ───────────────────────
// Solo para context.ts y server.ts — resolución de tokens pre-tenant.
// En producción DATABASE_URL_AUTH debe apuntar a un usuario con BYPASSRLS.
const globalForPrismaAuth = globalThis as unknown as {
  prismaAuth: PrismaClient | undefined
}

export const prismaAuth =
  globalForPrismaAuth.prismaAuth ??
  new PrismaClient({
    log: ['warn', 'error'],
    datasources: {
      db: {
        url: process.env.DATABASE_URL_AUTH ?? process.env.DATABASE_URL,
      },
    },
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrismaAuth.prismaAuth = prismaAuth
}

if (
  process.env.NODE_ENV === 'production' &&
  !process.env.DATABASE_URL_AUTH
) {
  console.warn(
    '[SEGURIDAD] DATABASE_URL_AUTH no está definida. ' +
    'prismaAuth usa la misma conexión que prisma. ' +
    'Configura un usuario PostgreSQL con BYPASSRLS para producción.',
  )
}
