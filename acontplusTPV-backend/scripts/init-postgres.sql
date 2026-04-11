-- =============================================================================
-- scripts/init-postgres.sql
-- Inicialización automática de PostgreSQL en el primer deploy
--
-- Este script se ejecuta UNA SOLA VEZ cuando el volumen postgres_data
-- está vacío (primer arranque del contenedor).
-- Crea el usuario acontplus_auth con BYPASSRLS y mínimos privilegios.
--
-- Variables de entorno usadas (inyectadas por docker-compose):
--   POSTGRES_DB   → nombre de la base de datos
--   POSTGRES_AUTH_USER     → se pasa via envsubst antes de ejecutar
--   POSTGRES_AUTH_PASSWORD → se pasa via envsubst antes de ejecutar
--
-- NOTA: Las variables de entorno del contenedor PostgreSQL no están
-- disponibles en los scripts de initdb como variables SQL directamente.
-- Por eso este script usa un enfoque diferente: el usuario se crea en
-- el entrypoint de PostgreSQL con los valores del entorno.
-- Ver la sección "init-postgres.sql" en el README de despliegue.
-- =============================================================================

-- Crear el rol de autenticación si no existe
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE rolname = 'acontplus_auth'
  ) THEN
    -- La contraseña se configura externamente via ALTER ROLE después del deploy
    -- porque las variables de entorno no están disponibles en initdb scripts
    CREATE ROLE acontplus_auth LOGIN PASSWORD 'PLACEHOLDER_CHANGE_VIA_ALTER_ROLE';
    RAISE NOTICE 'Rol acontplus_auth creado. Ejecutar ALTER ROLE para establecer la contraseña correcta.';
  ELSE
    RAISE NOTICE 'Rol acontplus_auth ya existe, omitiendo creación.';
  END IF;
END
$$;

-- Permisos de conexión
GRANT CONNECT ON DATABASE "acontplusTPV" TO acontplus_auth;
GRANT USAGE ON SCHEMA public TO acontplus_auth;

-- Permisos mínimos: solo las tablas de autenticación (BYPASSRLS)
-- SELECT en las 3 tablas de auth + UPDATE en lastUsedAt de DeviceToken
-- Ver documentación en lib/prisma.ts
DO $$
BEGIN
  -- Los grants sobre tablas se aplican después de que Prisma cree las tablas.
  -- Este script solo crea el rol. Los GRANTs se aplican via:
  --   npx tsx scripts/apply-manual-migrations.ts
  -- o manualmente después del primer deploy.
  RAISE NOTICE 'Rol creado. Los GRANT de tablas se aplicarán después de prisma migrate.';
  RAISE NOTICE 'Ejecutar: GRANT SELECT ON "DeviceToken", "Device", "User" TO acontplus_auth;';
  RAISE NOTICE 'Ejecutar: GRANT UPDATE ("lastUsedAt") ON "DeviceToken" TO acontplus_auth;';
  RAISE NOTICE 'Ejecutar: ALTER ROLE acontplus_auth BYPASSRLS;';
END
$$;
