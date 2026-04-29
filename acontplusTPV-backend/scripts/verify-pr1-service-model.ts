// =============================================================================
// scripts/verify-pr1-service-model.ts
// Verificación post-migración PR1 — ServiceModel en Establishment
// =============================================================================

import { PrismaClient, ServiceModel } from '@prisma/client'

const prisma = new PrismaClient()

const GREEN  = '\x1b[32m'
const RED    = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET  = '\x1b[0m'
const BOLD   = '\x1b[1m'

let allPassed = true

function pass(msg: string)  { console.log(`${GREEN}  ✓ ${msg}${RESET}`) }
function fail(msg: string)  { console.log(`${RED}  ✗ ${msg}${RESET}`); allPassed = false }
function warn(msg: string)  { console.log(`${YELLOW}  ⚠ ${msg}${RESET}`) }
function title(msg: string) { console.log(`\n${BOLD}${msg}${RESET}`) }

async function main() {
  console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`)
  console.log(`${BOLD}  PR1 — Verificación: ServiceModel en Establishment${RESET}`)
  console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}`)

  title('CHECK 1: Enum ServiceModel — existencia y valores exactos')
  try {
    const enumValues = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'ServiceModel'
      ORDER BY e.enumsortorder
    `
    const values = enumValues.map(r => r.enumlabel)
    const expected = ['COUNTER', 'DINE_IN']

    if (values.length === 0) {
      fail('Enum ServiceModel NO existe en PostgreSQL')
      warn('Ejecutar: npx prisma migrate dev')
    } else if (JSON.stringify(values) === JSON.stringify(expected)) {
      pass(`Enum correcto con valores exactos: [${values.join(', ')}]`)
    } else {
      fail(`Enum existe pero con valores incorrectos: [${values.join(', ')}]`)
      fail(`Se esperaba exactamente: [${expected.join(', ')}]`)
    }
  } catch (err) {
    fail(`Error al consultar pg_enum: ${err}`)
  }

  title('CHECK 2: Columna serviceModel — tipo, NOT NULL y default DINE_IN')
  try {
    const colInfo = await prisma.$queryRaw<{
      is_nullable: string
      column_default: string | null
      udt_name: string
    }[]>`
      SELECT is_nullable, column_default, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'Establishment'
        AND column_name  = 'serviceModel'
    `

    if (colInfo.length === 0) {
      fail('Columna serviceModel NO existe en tabla Establishment')
    } else {
      const col = colInfo[0]!

      if (col.udt_name === 'ServiceModel') {
        pass(`Tipo correcto: ${col.udt_name}`)
      } else {
        fail(`Tipo incorrecto: ${col.udt_name} (esperado: ServiceModel)`)
      }

      col.is_nullable === 'NO'
        ? pass('NOT NULL — correcto')
        : fail('Columna admite NULL — constraint NOT NULL no aplicado')

      if (col.column_default !== null && col.column_default.includes('DINE_IN')) {
        pass(`Default = DINE_IN (expresión en catálogo: ${col.column_default})`)
      } else if (col.column_default === null) {
        fail('Default DINE_IN NO está en el catálogo de PostgreSQL')
      } else {
        fail(`Default inesperado: ${col.column_default} (esperado: expresión con DINE_IN)`)
      }
    }
  } catch (err) {
    fail(`Error al consultar information_schema: ${err}`)
  }

  title('CHECK 3: Integridad de datos — 0 filas con serviceModel NULL')
  try {
    const result = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM "Establishment" WHERE "serviceModel" IS NULL
    `
    const count = Number(result[0]?.count ?? 0)
    count === 0
      ? pass('0 filas con serviceModel NULL')
      : fail(`${count} fila(s) tienen serviceModel NULL — backfill incompleto`)
  } catch (err) {
    fail(`Error: ${err}`)
  }

  title('CHECK 4: Lectura via Prisma Client')
  try {
    const sample = await prisma.establishment.findFirst({
      select: { id: true, name: true, serviceModel: true },
    })
    if (sample) {
      pass(`OK: "${sample.name}" → ${sample.serviceModel}`)
    } else {
      warn('Sin filas en Establishment — columna accesible pero sin datos de muestra')
    }
  } catch (err) {
    fail(`Prisma NO puede leer serviceModel: ${err}`)
  }

  title('CHECK 5: TypeScript ServiceModel enum (@prisma/client)')
  try {
    const tsValues = Object.values(ServiceModel)
    const hasCounter = tsValues.includes('COUNTER' as ServiceModel)
    const hasDineIn  = tsValues.includes('DINE_IN'  as ServiceModel)

    if (hasCounter && hasDineIn) {
      pass(`Enum sincronizado: [${tsValues.join(', ')}]`)
    } else {
      fail(`Enum desincronizado: [${tsValues.join(', ')}]`)
    }
  } catch (err) {
    fail(`Error al leer @prisma/client ServiceModel: ${err}`)
  }

  console.log(`\n${BOLD}═══════════════════════════════════════════════════${RESET}`)
  if (allPassed) {
    console.log(`${GREEN}${BOLD}  ✅ PR1 APROBADO — Criterio de salida cumplido${RESET}`)
  } else {
    console.log(`${RED}${BOLD}  ❌ PR1 FALLIDO — Resolver errores antes de continuar${RESET}`)
    process.exit(1)
  }
  console.log(`${BOLD}═══════════════════════════════════════════════════${RESET}\n`)
}

main()
  .catch(err => { console.error(`${RED}Error fatal:${RESET}`, err); process.exit(1) })
  .finally(() => prisma.$disconnect())
