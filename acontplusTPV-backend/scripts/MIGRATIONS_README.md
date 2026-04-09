# ACONTPLUS SaaS — Guía de Migraciones Manuales

## Contexto

Prisma genera la estructura base de tablas con `prisma migrate dev`.
Las siguientes 10 reglas de seguridad y rendimiento **no se pueden expresar
en Prisma Schema Language** y deben aplicarse por separado:

| # | Migración                             | Tipo         | Crítica |
|---|---------------------------------------|--------------|---------|
| 1 | Una jornada abierta por local         | Unique index | Sí      |
| 2 | Autoría obligatoria en pedidos        | CHECK        | Sí      |
| 3 | Ubicación en pedidos confirmados      | CHECK        | Sí      |
| 4 | Deudor XOR en créditos                | CHECK        | Sí      |
| 5 | Row-Level Security (27 tablas)        | RLS policy   | Sí      |
| 6 | Índice PRINT_NODE (comandas)          | Partial idx  | No      |
| 7 | Índice Sync Rules mesero              | Partial idx  | No      |
| 8 | Contrato vigente único por empleado   | Unique index | No      |
| 9 | Número tributario único por POS       | Unique index | No      |
|10 | Función assign_order_number           | PG function  | No      |

---

## Paso 1 — Preparar dependencias

En el directorio raíz del proyecto:

```bash
npm install tsx --save-dev
# tsx ejecuta TypeScript directamente sin compilar
```

Si ya tienes tsx instalado, omite este paso.

---

## Paso 2 — Verificar variables de entorno

El script usa `DATABASE_URL` del archivo `.env`:

```bash
# .env (ya debe existir desde `prisma migrate dev`)
DATABASE_URL="postgresql://usuario:contraseña@87.99.134.35:5432/acontplusTPV"
```

**Verificar conexión antes de ejecutar:**

```bash
npx prisma db execute --stdin <<< "SELECT version();"
```

Si responde con la versión de PostgreSQL, la conexión es correcta.

---

## Paso 3 — Ejecutar desde tu máquina local (Windows)

Abre PowerShell en el directorio raíz del proyecto:

```powershell
# Opción A: Ejecutar TODAS las migraciones (recomendado la primera vez)
npx tsx scripts/apply-manual-migrations.ts

# Opción B: Primero verificar sin modificar nada (dry-run)
npx tsx scripts/apply-manual-migrations.ts --dry-run

# Opción C: Ejecutar solo una migración específica
npx tsx scripts/apply-manual-migrations.ts --migration 5
```

**Salida esperada al ejecutar todas:**

```
╔══════════════════════════════════════════════════════════╗
║      ACONTPLUS SaaS — Manual Migrations Runner           ║
╚══════════════════════════════════════════════════════════╝

[01] unique_open_day_per_establishment............... OK ✓
[02] order_author_required........................... OK ✓
[03] order_location_when_confirmed................... OK ✓
[04] credit_debtor_xor............................... OK ✓
[05] rls_tenant_isolation........................... OK ✓
[06] idx_orders_print_pending....................... OK ✓
[07] idx_orders_waiter_sync......................... OK ✓
[08] unique_active_contract_per_employee............ OK ✓
[09] unique_order_number_per_pos.................... OK ✓
[10] fn_assign_order_number......................... OK ✓

─────────────────────────────────────────────
  Aplicadas: 10
  Saltadas:  0
  Fallidas:  0
─────────────────────────────────────────────

✓ Base de datos completamente configurada y blindada.

Verificando RLS en tablas principales...
  business_day              ✓ RLS activo
  cash_register_event       ✓ RLS activo
  credit_transaction        ✓ RLS activo
  device                    ✓ RLS activo
  establishment             ✓ RLS activo
  order                     ✓ RLS activo
  point_of_sale             ✓ RLS activo
  transfer_payment          ✓ RLS activo
  user                      ✓ RLS activo
```

---

## Paso 4 — Verificar el estado en cualquier momento

```powershell
npx tsx scripts/verify-migrations.ts
```

---

## Paso 5 — Si necesitas revertir (desarrollo/testing)

```sql
-- Conectar con psql o DBeaver y ejecutar:

-- Deshabilitar RLS (reversible)
ALTER TABLE establishment        DISABLE ROW LEVEL SECURITY;
ALTER TABLE "order"              DISABLE ROW LEVEL SECURITY;
-- (repetir para las 27 tablas)

-- Eliminar índices
DROP INDEX IF EXISTS unique_open_day_per_establishment;
DROP INDEX IF EXISTS idx_orders_print_pending;
DROP INDEX IF EXISTS idx_orders_waiter_sync;
DROP INDEX IF EXISTS unique_active_contract_per_employee;
DROP INDEX IF EXISTS unique_order_number_per_pos;

-- Eliminar constraints
ALTER TABLE "order"         DROP CONSTRAINT IF EXISTS order_author_required;
ALTER TABLE "order"         DROP CONSTRAINT IF EXISTS order_location_when_confirmed;
ALTER TABLE credit_transaction DROP CONSTRAINT IF EXISTS credit_debtor_xor;

-- Eliminar funciones
DROP FUNCTION IF EXISTS assign_order_number(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS current_tenant_id();
```

---

## Notas importantes

### Por qué `"user"`, `"order"`, `"table"` van entre comillas

`user`, `order` y `table` son palabras reservadas de PostgreSQL.
Prisma las genera con comillas dobles en el DDL. El script las
maneja correctamente. Si ejecutas SQL manual, siempre usa comillas:

```sql
-- Correcto
SELECT * FROM "user" WHERE tenant_id = $1;
SELECT * FROM "order" WHERE status = 'CONFIRMED';

-- Incorrecto (error de sintaxis)
SELECT * FROM user WHERE tenant_id = $1;
```

### Comportamiento del RLS con el backend

El RLS está configurado para que:
- Si `app.current_tenant_id` está configurado → filtra por ese tenant
- Si no está configurado (NULL) → el usuario ve todos los datos

Esto significa que:
- Las conexiones de `prisma migrate dev` siguen funcionando (ven todo)
- Las conexiones de la app siempre pasan por `withTenant()` en `rls.ts`
- Las herramientas de administración (DBeaver, psql directo) ven todo

### La migración 5 y 10 son idempotentes por diseño

Las migraciones 5 (RLS) y 10 (función) usan `CREATE OR REPLACE` y
`DROP POLICY IF EXISTS`, por lo que re-ejecutarlas es seguro y actualiza
las definiciones si cambiaron.

### Ejecutar desde el servidor (alternativa)

Si prefieres ejecutar directamente en el VPS:

```bash
# SSH al servidor
ssh usuario@87.99.134.35

# En el servidor
cd /app  # o donde esté el proyecto
npx tsx scripts/apply-manual-migrations.ts
```

El resultado es idéntico porque `DATABASE_URL` apunta a `localhost`
desde el servidor, lo que es ligeramente más rápido.
