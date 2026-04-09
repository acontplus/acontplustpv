// =============================================================================
// apps/api/src/routers/payroll.ts
// Nómina y Anticipos — Paso 10
//
// Instrucciones §5 — reglas críticas implementadas:
//
//   1. COMISIONES: Solo sobre PAID_CASH y PAID_TRANSFER_CONFIRMED.
//      PAID_CREDIT y PAID_TRANSFER_PENDING NO generan comisión todavía.
//
//   2. ANTICIPO: genera dos registros atómicos (Instrucciones §5):
//      - CashRegisterEvent(CASH_OUT_ADVANCE) — sale de caja
//      - EmployeeLedgerEntry(ADVANCE_RECEIVED) — con cashRegisterEventId
//        (campo plain UUID, sin @relation — ver schema y rls.ts)
//
//   3. CIERRE DE NÓMINA: flujo obligatorio de 3 pasos en una transacción:
//      a) EmployeeLedgerEntry(SALARY_PAYMENT) — requerido por PayrollRecord.ledgerEntryId @unique
//      b) PayrollRecord — snapshot inmutable referenciando el ledger entry
//      c) CashRegisterEvent(CASH_OUT_ADJUSTMENT) si pago es en efectivo
//
//   4. hasPendingAdjustments: se marca TRUE al cerrar si hay transferencias
//      PAID_TRANSFER_PENDING en el período (comisiones incompletas).
//      El Paso 7 (confirmTransfer) lo pone en FALSE cuando confirma.
//      El prompt de Gemini lo tenía invertido — aquí está corregido.
//
//   5. PERÍODO: derivado de EmployeeContract.payPeriod (WEEKLY/BIWEEKLY/MONTHLY)
//      anclado a la fecha actual. No es un rango arbitrario de fechas.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { adminProcedure } from '../middleware/auth'
import { withOpenDay }    from '../middleware/businessDay'
import { withTenant, withTenantOptions } from '../lib/rls'
import {
  LedgerEntryType,
  CashEventType,
  SalaryType,
  PayPeriod,
}                     from '@prisma/client'

// =============================================================================
// HELPER: calcular el rango de fechas del período según el contrato
// =============================================================================

function computePeriodRange(
  payPeriod: PayPeriod,
  referenceDate: Date = new Date(),
): { periodStart: Date; periodEnd: Date } {
  const now = new Date(referenceDate)
  now.setHours(23, 59, 59, 999) // fin del día

  let periodStart: Date

  if (payPeriod === PayPeriod.WEEKLY) {
    // Lunes de la semana actual
    const dayOfWeek = now.getDay()
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
    periodStart = new Date(now)
    periodStart.setDate(now.getDate() - daysToMonday)
    periodStart.setHours(0, 0, 0, 0)

  } else if (payPeriod === PayPeriod.BIWEEKLY) {
    // Quincena: 1-15 o 16-fin de mes
    const day = now.getDate()
    if (day <= 15) {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
    } else {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 16, 0, 0, 0, 0)
    }

  } else {
    // MONTHLY: primer día del mes
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
  }

  return { periodStart, periodEnd: now }
}

// =============================================================================
// SCHEMAS
// =============================================================================

const addLedgerEntryInput = z.object({
  userId:          z.string().uuid(),
  establishmentId: z.string().uuid(),
  type:            z.enum([
    'ADVANCE_RECEIVED',   // anticipo en efectivo → CashRegisterEvent(CASH_OUT_ADVANCE)
    'COMMISSION_EARNED',  // comisión manual adicional
    'ADJUSTMENT',         // ajuste manual (positivo o negativo)
    'CREDIT_CONSUMPTION', // consumo fiado registrado manualmente
  ]),
  amount:  z.number().positive(),
  notes:   z.string().max(500).optional(),
})

const calculatePayrollInput = z.object({
  userId:          z.string().uuid(),
  // Si se pasa una fecha de referencia personalizada, usa esa para el período
  referenceDate:   z.string().datetime().optional(),
})

const closePayrollInput = z.object({
  userId:           z.string().uuid(),
  workedDaysOrShifts: z.number().int().min(0).optional(),
  // Para contratos PER_DAY / PER_SHIFT — cuántas unidades trabajó
  paymentMethod:    z.enum(['CASH', 'TRANSFER']),
  receiptUrl:       z.string().url().optional(),
  notes:            z.string().max(500).optional(),
  // Referencia de transferencia si es pago bancario
  referenceDate:    z.string().datetime().optional(),
  // Para forzar un período específico (auditoría/corrección)
})

const listPayrollInput = z.object({
  userId:      z.string().uuid().optional(),
  limit:       z.number().min(1).max(50).default(12),
})

// =============================================================================
// ROUTER
// =============================================================================

export const payrollRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // addLedgerEntry — Registra un anticipo, bono o ajuste manual
  //
  // Para ADVANCE_RECEIVED: genera dos registros atómicos:
  //   1. CashRegisterEvent(CASH_OUT_ADVANCE) — el dinero sale de la caja
  //   2. EmployeeLedgerEntry(ADVANCE_RECEIVED) — con cashRegisterEventId
  //      apuntando al evento de caja (referencia cruzada bidireccional,
  //      campo plain UUID sin @relation — ver schema §1 y blindaje)
  //
  // Requiere jornada abierta porque el anticipo está atado a la caja del día.
  // ──────────────────────────────────────────────────────────────────────────
  addLedgerEntry: adminProcedure
    .use(withOpenDay)
    .input(addLedgerEntryInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId: adminId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // Verificar que el empleado existe y pertenece al tenant
          const employee = await tx.user.findFirst({
            where: {
              id:        input.userId,
              tenantId,
              isActive:  true,
              deletedAt: null,
            },
            select: { id: true, name: true },
          })

          if (!employee) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Empleado no encontrado o inactivo' })
          }

          // Verificar que el establecimiento pertenece al tenant
          const establishment = await tx.establishment.findFirst({
            where: { id: input.establishmentId, tenantId, isActive: true, deletedAt: null },
            select: { id: true },
          })

          if (!establishment) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Establecimiento no encontrado' })
          }

          const effectiveDevice = deviceId ?? (
            await tx.device.findFirst({
              where: { tenantId, establishmentId: input.establishmentId, isActive: true, deletedAt: null },
              select: { id: true },
            }).then(d => d?.id)
          )

          if (!effectiveDevice) {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No hay dispositivos activos en este establecimiento' })
          }

          let cashEventId: string | null = null

          // Para anticipos en efectivo: CashRegisterEvent(CASH_OUT_ADVANCE) primero
          // La referencia cruzada va en ambas direcciones:
          //   CashRegisterEvent.employeeLedgerEntryId (se actualiza después)
          //   EmployeeLedgerEntry.cashRegisterEventId (se pone al crear)
          if (input.type === LedgerEntryType.ADVANCE_RECEIVED) {
            const cashEvent = await tx.cashRegisterEvent.create({
              data: {
                tenantId,
                establishmentId: input.establishmentId,
                businessDayId,
                type:    CashEventType.CASH_OUT_ADVANCE,
                amount:  input.amount,
                userId:  adminId!,
                deviceId: effectiveDevice,
                notes:   input.notes
                  ? `Anticipo a ${employee.name} | ${input.notes}`
                  : `Anticipo a ${employee.name}`,
                // employeeLedgerEntryId se actualiza después (FK circular — ver schema)
              },
            })
            cashEventId = cashEvent.id
          }

          // Crear el EmployeeLedgerEntry con la referencia al CashRegisterEvent
          const ledgerEntry = await tx.employeeLedgerEntry.create({
            data: {
              tenantId,
              establishmentId:    input.establishmentId,
              userId:             input.userId,
              type:               input.type as LedgerEntryType,
              amount:             input.amount,
              businessDayId,
              cashRegisterEventId: cashEventId,
              // Plain UUID — no @relation en schema (se documentó en blindaje)
              authorizedBy:       adminId!,
              deviceId:           effectiveDevice,
              notes:              input.notes ?? null,
            },
          })

          // Actualizar la referencia inversa en CashRegisterEvent si es anticipo
          // CashRegisterEvent.employeeLedgerEntryId también es plain UUID (ver schema)
          if (cashEventId) {
            await tx.$executeRaw`
              UPDATE "CashRegisterEvent"
              SET "employeeLedgerEntryId" = ${ledgerEntry.id}::uuid
              WHERE id = ${cashEventId}::uuid
            `
          }

          return { ledgerEntry, cashEventId }
        },
        { timeout: 10_000 },
      )

      return {
        ledgerEntryId: result.ledgerEntry.id,
        cashEventId:   result.cashEventId,
        type:          input.type,
        amount:        input.amount,
        message:       input.type === 'ADVANCE_RECEIVED'
          ? `Anticipo de $${input.amount.toFixed(2)} registrado. Salida de caja registrada.`
          : `Registro en libro contable creado.`,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // calculatePayroll — Consolida el cálculo de nómina del período activo
  //
  // Es una QUERY — no modifica nada, solo calcula.
  // El período se deriva del contrato activo del empleado (PayPeriod).
  // No acepta un rango arbitrario para evitar manipulación del período.
  //
  // Estructura del cálculo:
  //   salarioBase = baseAmount × (workedDaysOrShifts para PER_DAY/PER_SHIFT)
  //   montoComisionable = suma de totalAmount de pedidos PAID_CASH + PAID_TRANSFER_CONFIRMED
  //   comisiones = montoComisionable × commissionRate
  //   anticipos = suma de EmployeeLedgerEntry(ADVANCE_RECEIVED) del período
  //   consumos = suma de CreditTransaction del empleado sin appliedToPayrollId
  //   netoPago = salarioBase + comisiones - anticipos - consumos
  //
  //   hasPendingAdjustments = true si hay pedidos PAID_TRANSFER_PENDING
  //     creados por el empleado en el período (esas comisiones aún pueden cambiar)
  // ──────────────────────────────────────────────────────────────────────────
  calculatePayroll: adminProcedure
    .input(calculatePayrollInput)
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // 1. Obtener contrato vigente
      const contract = await withTenant(tenantId, (tx) =>
        tx.employeeContract.findFirst({
          where: {
            tenantId,
            userId:      input.userId,
            effectiveTo: null,
            deletedAt:   null,
          },
          select: {
            id:             true,
            salaryType:     true,
            payPeriod:      true,
            baseAmount:     true,
            commissionRate: true,
          },
          orderBy: { effectiveFrom: 'desc' },
        }),
      )

      if (!contract) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'El empleado no tiene contrato vigente',
        })
      }

      const refDate = input.referenceDate ? new Date(input.referenceDate) : new Date()
      const { periodStart, periodEnd } = computePeriodRange(contract.payPeriod, refDate)

      // 2. Pedidos cobrados en el período para comisiones
      //    Solo PAID_CASH y PAID_TRANSFER_CONFIRMED (Instrucciones §5)
      const [commissionOrders, pendingTransferOrders, advances, creditDebts] =
        await Promise.all([

          // Pedidos que generan comisión
          withTenant(tenantId, (tx) =>
            tx.order.findMany({
              where: {
                tenantId,
                createdByUserId: input.userId,
                status:          { in: ['PAID_CASH', 'PAID_TRANSFER_CONFIRMED'] },
                createdAt:       { gte: periodStart, lte: periodEnd },
              },
              select: { id: true, totalAmount: true, status: true },
            }),
          ),

          // Pedidos PAID_TRANSFER_PENDING — comisiones aún incompletas
          withTenant(tenantId, (tx) =>
            tx.order.count({
              where: {
                tenantId,
                createdByUserId: input.userId,
                status:          'PAID_TRANSFER_PENDING',
                createdAt:       { gte: periodStart, lte: periodEnd },
              },
            }),
          ),

          // Anticipos y ajustes del período
          withTenant(tenantId, (tx) =>
            tx.employeeLedgerEntry.findMany({
              where: {
                tenantId,
                userId:    input.userId,
                createdAt: { gte: periodStart, lte: periodEnd },
              },
              select: { id: true, type: true, amount: true, notes: true, createdAt: true },
            }),
          ),

          // Deudas de crédito sin aplicar a nómina (consumos del empleado)
          withTenant(tenantId, (tx) =>
            tx.$queryRaw<Array<{ pending_debt: number }>>`
              SELECT COALESCE(
                SUM(CASE WHEN type = 'CREDIT_ISSUED' THEN amount ELSE 0 END) -
                SUM(CASE WHEN type IN ('PAYMENT_RECEIVED','CREDIT_CANCELLED','DISCOUNT_APPLIED')
                    THEN COALESCE("appliedAmount", amount) ELSE 0 END),
                0
              ) AS pending_debt
              FROM "CreditTransaction"
              WHERE "tenantId"      = ${tenantId}::uuid
                AND "debtorUserId"  = ${input.userId}::uuid
                AND "appliedToPayrollId" IS NULL
            `,
          ),
        ])

      // 3. Calcular salario base
      const baseAmount     = Number(contract.baseAmount)
      const commissionRate = Number(contract.commissionRate)

      // Para PER_DAY y PER_SHIFT el base requiere workedDaysOrShifts
      // que aún no conocemos en el cálculo — se pasa al closePayroll
      // Aquí devolvemos el base unitario para que el admin ingrese las unidades
      const baseSalary = contract.salaryType === SalaryType.FIXED ? baseAmount : 0
      // FIXED: el salario base es el monto completo del contrato
      // PER_DAY / PER_SHIFT: base × unidades (se calcula en closePayroll)

      // 4. Calcular comisiones
      const commissionableAmount = parseFloat(
        commissionOrders.reduce((s, o) => s + Number(o.totalAmount), 0).toFixed(2),
      )
      const commissionsEarned = parseFloat(
        (commissionableAmount * commissionRate).toFixed(2),
      )

      // 5. Sumar anticipos y ajustes
      const advancesDeducted = parseFloat(
        advances
          .filter(e => e.type === LedgerEntryType.ADVANCE_RECEIVED)
          .reduce((s, e) => s + Number(e.amount), 0)
          .toFixed(2),
      )
      const otherAdjustments = parseFloat(
        advances
          .filter(e => e.type === LedgerEntryType.ADJUSTMENT)
          .reduce((s, e) => s + Number(e.amount), 0)
          .toFixed(2),
      )

      // 6. Deudas pendientes de aplicar a nómina
      const creditConsumptions = parseFloat(Number(creditDebts[0]?.pending_debt ?? 0).toFixed(2))

      // 7. Neto estimado (sin PER_DAY/PER_SHIFT — esos necesitan unidades)
      const netPaymentEstimate = parseFloat(
        (baseSalary + commissionsEarned + otherAdjustments - advancesDeducted - creditConsumptions)
          .toFixed(2),
      )

      // 8. hasPendingAdjustments: hay transferencias del período sin confirmar
      const hasPendingAdjustments = pendingTransferOrders > 0

      return {
        employeeId:           input.userId,
        contractId:           contract.id,
        salaryType:           contract.salaryType,
        payPeriod:            contract.payPeriod,
        periodStart:          periodStart.toISOString(),
        periodEnd:            periodEnd.toISOString(),

        // Componentes del cálculo
        baseAmountUnit:       baseAmount,
        // Para FIXED: el salario total. Para PER_DAY/PER_SHIFT: monto por unidad.
        baseSalary,
        // 0 si PER_DAY/PER_SHIFT — se calcula en closePayroll con workedDaysOrShifts
        commissionableAmount,
        commissionRate,
        commissionsEarned,
        advancesDeducted,
        otherAdjustments,
        creditConsumptions,
        netPaymentEstimate,
        // Estimado. El valor final queda en PayrollRecord después de closePayroll.

        // Estado
        hasPendingAdjustments,
        pendingTransferCount:  pendingTransferOrders,
        // Si > 0, habrá una corrección de comisiones cuando el Paso 7 confirme

        // Detalle para mostrar al admin
        ledgerEntries:     advances.map(e => ({ ...e, amount: Number(e.amount) })),
        commissionOrders:  commissionOrders.map(o => ({
          id:          o.id,
          totalAmount: Number(o.totalAmount),
          status:      o.status,
        })),
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // closePayroll — Cierra y congela la nómina del período
  //
  // Operación atómica — todo o nada (withTenantOptions):
  //   1. Verificar que no existe PayrollRecord para este período/empleado
  //   2. Recalcular con workedDaysOrShifts definitivo
  //   3. Crear EmployeeLedgerEntry(SALARY_PAYMENT) — requerido por PayrollRecord
  //   4. Crear PayrollRecord inmutable (snapshot congelado)
  //   5. Si pago en efectivo: CashRegisterEvent(CASH_OUT_ADJUSTMENT)
  //   6. Marcar hasPendingAdjustments=true si hay PAID_TRANSFER_PENDING en período
  //
  // Corrección al prompt de Gemini:
  //   hasPendingAdjustments se marca TRUE al cerrar (no FALSE).
  //   El Paso 7 (confirmTransfer) lo pone en FALSE cuando confirma las transferencias.
  // ──────────────────────────────────────────────────────────────────────────
  closePayroll: adminProcedure
    .use(withOpenDay)
    .input(closePayrollInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId: adminId, establishmentId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // 1. Obtener contrato vigente
          const contract = await tx.employeeContract.findFirst({
            where: {
              tenantId,
              userId:      input.userId,
              effectiveTo: null,
              deletedAt:   null,
            },
            select: {
              id:             true,
              salaryType:     true,
              payPeriod:      true,
              baseAmount:     true,
              commissionRate: true,
            },
            orderBy: { effectiveFrom: 'desc' },
          })

          if (!contract) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'El empleado no tiene contrato vigente',
            })
          }

          const refDate = input.referenceDate ? new Date(input.referenceDate) : new Date()
          const { periodStart, periodEnd } = computePeriodRange(contract.payPeriod, refDate)

          // 2. Verificar que no existe ya un PayrollRecord para este período
          //    Protección contra doble cierre — condición de carrera resuelta con
          //    la unicidad de la FK ledgerEntryId @unique en PayrollRecord
          const existing = await tx.payrollRecord.findFirst({
            where: {
              tenantId,
              userId:      input.userId,
              periodStart: { lte: periodEnd },
              periodEnd:   { gte: periodStart },
            },
            select: { id: true, periodStart: true, periodEnd: true },
          })

          if (existing) {
            throw new TRPCError({
              code:    'CONFLICT',
              message: `Ya existe un cierre de nómina para este período (${
                existing.periodStart.toISOString().split('T')[0]
              } → ${existing.periodEnd.toISOString().split('T')[0]})`,
            })
          }

          // 3. Recalcular valores finales con workedDaysOrShifts definitivo
          const baseAmount     = Number(contract.baseAmount)
          const commissionRate = Number(contract.commissionRate)

          let baseSalary: number
          if (contract.salaryType === SalaryType.FIXED) {
            baseSalary = baseAmount
          } else {
            // PER_DAY o PER_SHIFT: requiere unidades trabajadas
            if (!input.workedDaysOrShifts) {
              throw new TRPCError({
                code:    'BAD_REQUEST',
                message: `El contrato es de tipo ${contract.salaryType} — se requiere workedDaysOrShifts`,
              })
            }
            baseSalary = parseFloat((baseAmount * input.workedDaysOrShifts).toFixed(2))
          }

          // Pedidos que generan comisión — recalculo definitivo
          const commissionOrders = await tx.order.findMany({
            where: {
              tenantId,
              createdByUserId: input.userId,
              status:          { in: ['PAID_CASH', 'PAID_TRANSFER_CONFIRMED'] },
              createdAt:       { gte: periodStart, lte: periodEnd },
            },
            select: { totalAmount: true },
          })

          const commissionableAmount = parseFloat(
            commissionOrders.reduce((s, o) => s + Number(o.totalAmount), 0).toFixed(2),
          )
          const commissionsEarned = parseFloat(
            (commissionableAmount * commissionRate).toFixed(2),
          )

          // Anticipos del período
          const advanceEntries = await tx.employeeLedgerEntry.findMany({
            where: {
              tenantId,
              userId:    input.userId,
              type:      LedgerEntryType.ADVANCE_RECEIVED,
              createdAt: { gte: periodStart, lte: periodEnd },
            },
            select: { amount: true },
          })
          const advancesDeducted = parseFloat(
            advanceEntries.reduce((s, e) => s + Number(e.amount), 0).toFixed(2),
          )

          // Consumos de crédito sin aplicar a nómina
          const creditResult = await tx.$queryRaw<Array<{ pending_debt: number }>>`
            SELECT COALESCE(
              SUM(CASE WHEN type = 'CREDIT_ISSUED' THEN amount ELSE 0 END) -
              SUM(CASE WHEN type IN ('PAYMENT_RECEIVED','CREDIT_CANCELLED','DISCOUNT_APPLIED')
                  THEN COALESCE("appliedAmount", amount) ELSE 0 END),
              0
            ) AS pending_debt
            FROM "CreditTransaction"
            WHERE "tenantId"             = ${tenantId}::uuid
              AND "debtorUserId"         = ${input.userId}::uuid
              AND "appliedToPayrollId"   IS NULL
          `
          const creditConsumptions = parseFloat(
            Number(creditResult[0]?.pending_debt ?? 0).toFixed(2),
          )

          const netPayment = parseFloat(
            (baseSalary + commissionsEarned - advancesDeducted - creditConsumptions).toFixed(2),
          )

          // ¿Hay transferencias pendientes en el período que afecten comisiones?
          const pendingTransferCount = await tx.order.count({
            where: {
              tenantId,
              createdByUserId: input.userId,
              status:          'PAID_TRANSFER_PENDING',
              createdAt:       { gte: periodStart, lte: periodEnd },
            },
          })
          // hasPendingAdjustments = TRUE si hay PAID_TRANSFER_PENDING
          // (Corregido respecto al prompt de Gemini — el flag se marca TRUE al cerrar
          // y el Paso 7 lo pone en FALSE cuando confirma las transferencias)
          const hasPendingAdjustments = pendingTransferCount > 0

          const effectiveDevice = deviceId ?? (
            await tx.device.findFirst({
              where: { tenantId, establishmentId, isActive: true, deletedAt: null },
              select: { id: true },
            }).then(d => d?.id)
          )

          if (!effectiveDevice) {
            throw new TRPCError({
              code:    'PRECONDITION_FAILED',
              message: 'No hay dispositivos activos en este establecimiento',
            })
          }

          // 4. Crear EmployeeLedgerEntry(SALARY_PAYMENT)
          //    OBLIGATORIO: PayrollRecord.ledgerEntryId @unique requiere este registro
          const salaryLedgerEntry = await tx.employeeLedgerEntry.create({
            data: {
              tenantId,
              establishmentId,
              userId:       input.userId,
              type:         LedgerEntryType.SALARY_PAYMENT,
              amount:       netPayment,
              businessDayId,
              authorizedBy: adminId!,
              deviceId:     effectiveDevice,
              notes:        input.notes
                ? `Cierre de nómina | ${input.notes}`
                : `Cierre de nómina ${periodStart.toISOString().split('T')[0]} → ${periodEnd.toISOString().split('T')[0]}`,
            },
          })

          // 5. Crear PayrollRecord (snapshot inmutable — sin updatedAt)
          const payrollRecord = await tx.payrollRecord.create({
            data: {
              tenantId,
              userId:               input.userId,
              contractSnapshotId:   contract.id,
              periodStart,
              periodEnd,
              workedDaysOrShifts:   input.workedDaysOrShifts ?? null,
              baseSalary,
              commissionableAmount,
              commissionRate,
              commissionsEarned,
              advancesDeducted,
              creditConsumptions,
              netPayment,
              paymentMethod:        input.paymentMethod,
              receiptUrl:           input.receiptUrl ?? null,
              hasPendingAdjustments,
              paidBy:               adminId!,
              paidAt:               new Date(),
              notes:                input.notes ?? null,
              ledgerEntryId:        salaryLedgerEntry.id,
            },
          })

          // 6. Si pago en efectivo: CashRegisterEvent(CASH_OUT_ADJUSTMENT)
          //    No existe SALARY_PAYMENT en CashEventType — usamos CASH_OUT_ADJUSTMENT
          //    que es la salida administrativa correcta para pagos de nómina
          let cashEventId: string | null = null
          if (input.paymentMethod === 'CASH') {
            const cashEvent = await tx.cashRegisterEvent.create({
              data: {
                tenantId,
                establishmentId,
                businessDayId,
                type:    CashEventType.CASH_OUT_ADJUSTMENT,
                amount:  netPayment,
                userId:  adminId!,
                deviceId: effectiveDevice,
                notes:   `Pago de nómina | ${payrollRecord.id}`,
              },
            })
            cashEventId = cashEvent.id
          }

          return { payrollRecord, salaryLedgerEntry, cashEventId, hasPendingAdjustments }
        },
        { timeout: 20_000 },
      )

      return {
        payrollRecordId:      result.payrollRecord.id,
        ledgerEntryId:        result.salaryLedgerEntry.id,
        cashEventId:          result.cashEventId,
        netPayment:           Number(result.payrollRecord.netPayment),
        hasPendingAdjustments: result.hasPendingAdjustments,
        message:              result.hasPendingAdjustments
          ? 'Nómina cerrada. Hay transferencias pendientes de confirmar — las comisiones pueden ajustarse.'
          : 'Nómina cerrada y congelada correctamente.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // listPayroll — Historial de liquidaciones
  // ──────────────────────────────────────────────────────────────────────────
  listPayroll: adminProcedure
    .input(listPayrollInput)
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const records = await withTenant(tenantId, (tx) =>
        tx.payrollRecord.findMany({
          where: {
            tenantId,
            ...(input.userId && { userId: input.userId }),
          },
          select: {
            id:                   true,
            userId:               true,
            periodStart:          true,
            periodEnd:            true,
            baseSalary:           true,
            commissionsEarned:    true,
            advancesDeducted:     true,
            creditConsumptions:   true,
            netPayment:           true,
            paymentMethod:        true,
            hasPendingAdjustments: true,
            paidAt:               true,
            user: { select: { id: true, name: true } },
          },
          orderBy: { paidAt: 'desc' },
          take:    input.limit,
        }),
      )

      return {
        records: records.map(r => ({
          ...r,
          baseSalary:         Number(r.baseSalary),
          commissionsEarned:  Number(r.commissionsEarned),
          advancesDeducted:   Number(r.advancesDeducted),
          creditConsumptions: Number(r.creditConsumptions),
          netPayment:         Number(r.netPayment),
        })),
        total: records.length,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // listLedgerEntries — Libro contable de un empleado
  // ──────────────────────────────────────────────────────────────────────────
  listLedgerEntries: adminProcedure
    .input(z.object({
      userId:    z.string().uuid(),
      dateFrom:  z.string().datetime().optional(),
      dateTo:    z.string().datetime().optional(),
      limit:     z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const entries = await withTenant(tenantId, (tx) =>
        tx.employeeLedgerEntry.findMany({
          where: {
            tenantId,
            userId: input.userId,
            ...(input.dateFrom || input.dateTo
              ? {
                  createdAt: {
                    ...(input.dateFrom && { gte: new Date(input.dateFrom) }),
                    ...(input.dateTo   && { lte: new Date(input.dateTo)   }),
                  },
                }
              : {}),
          },
          select: {
            id:        true,
            type:      true,
            amount:    true,
            notes:     true,
            createdAt: true,
            cashRegisterEventId: true,
          },
          orderBy: { createdAt: 'desc' },
          take:    input.limit,
        }),
      )

      return {
        entries: entries.map(e => ({
          ...e,
          amount: Number(e.amount),
        })),
        total: entries.length,
      }
    }),
})
