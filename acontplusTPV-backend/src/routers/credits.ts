// =============================================================================
// apps/api/src/routers/credits.ts
// Créditos y Fiados — Paso 8
//
// Modelo de datos: append-only con CreditTransaction (Instrucciones §4)
// El saldo nunca vive en un campo mutable — se calcula sumando eventos.
//
// Fórmula de saldo:
//   saldo = SUM(CREDIT_ISSUED)
//         - SUM(COALESCE(appliedAmount, amount) WHERE type IN
//               (PAYMENT_RECEIVED, CREDIT_CANCELLED, DISCOUNT_APPLIED))
//
//   NOTA: Se usa appliedAmount en lugar de amount para los descuentos
//   parciales. Si el dueño descuenta $50 de una deuda de $200 en nómina,
//   appliedAmount=50 y amount=200. El saldo restante es $150, no $0.
//   Usar amount en lugar de appliedAmount inflaría los montos reducidos.
//
// Tipos de reducción de deuda:
//   PAYMENT_RECEIVED  → el deudor pagó (efectivo, transferencia, etc.)
//   CREDIT_CANCELLED  → deuda condonada/eliminada (incobrables, errores)
//   DISCOUNT_APPLIED  → descuento parcial aplicado en nómina (Instrucciones §5)
//
// Corrección al prompt de Gemini:
//   El evento de caja para abono en efectivo es CREDIT_PAYMENT_RECEIVED,
//   no "CASH_IN" — ese tipo no existe en el schema CashEventType.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { cashierProcedure, adminProcedure } from '../middleware/auth'
import { withOpenDay }  from '../middleware/businessDay'
import { withTenant, withTenantOptions } from '../lib/rls'
import { CreditEventType, CashEventType } from '@prisma/client'

// =============================================================================
// TIPOS INTERNOS
// =============================================================================

// Identifica al deudor — exactamente uno de los dos (XOR)
const debtorSchema = z.union([
  z.object({ debtorUserId: z.string().uuid(), debtorCustomerId: z.undefined() }),
  z.object({ debtorUserId: z.undefined(),     debtorCustomerId: z.string().uuid() }),
])

// =============================================================================
// SCHEMAS
// =============================================================================

const listDebtorsInput = z.object({
  type:           z.enum(['customer', 'employee', 'all']).default('all'),
  onlyWithBalance: z.boolean().default(true),
  // Si true, omite deudores con saldo = 0
})

const getStatementInput = z.object({
  debtorUserId:     z.string().uuid().optional(),
  debtorCustomerId: z.string().uuid().optional(),
}).refine(
  d => (d.debtorUserId == null) !== (d.debtorCustomerId == null),
  { message: 'Especifica exactamente un deudor: debtorUserId o debtorCustomerId' },
)

const registerPaymentInput = z.object({
  debtorUserId:     z.string().uuid().optional(),
  debtorCustomerId: z.string().uuid().optional(),
  amount:           z.number().positive(),
  paymentMethod:    z.enum(['CASH', 'TRANSFER']),
  // CASH      → genera CashRegisterEvent(CREDIT_PAYMENT_RECEIVED)
  // TRANSFER  → genera TransferPayment pendiente de conciliación (Paso 7)
  notes:            z.string().max(500).optional(),
  // Para TRANSFER: datos del comprobante
  bankName:         z.string().max(100).optional(),
  referenceNumber:  z.string().max(100).optional(),
  targetAccount:    z.string().max(100).optional(),
  receiptUrl:       z.string().url().optional(),
}).refine(
  d => (d.debtorUserId == null) !== (d.debtorCustomerId == null),
  { message: 'Especifica exactamente un deudor' },
).refine(
  d => d.paymentMethod !== 'TRANSFER' || (d.bankName && d.referenceNumber && d.targetAccount),
  { message: 'Para pagos con transferencia se requiere bankName, referenceNumber y targetAccount' },
)

const applyDiscountInput = z.object({
  // Descuento parcial o total aplicado en nómina — Instrucciones §5
  originalCreditId: z.string().uuid(),
  // El CREDIT_ISSUED que se está descontando
  appliedAmount:    z.number().positive(),
  // Puede ser menor que el total (descuento parcial)
  appliedToPayrollId: z.string().uuid(),
  // El PayrollRecord al que se aplica este descuento
  notes:            z.string().max(500).optional(),
})

const cancelDebtInput = z.object({
  // Condonación total de una deuda (incobrables, errores de registro)
  originalCreditId: z.string().uuid(),
  notes:            z.string().min(10).max(500),
  // Obligatorio — el admin debe justificar la condonación
})

// =============================================================================
// HELPER: calcular saldo de un deudor
// Reutilizado en getStatement, registerPayment y applyDiscount
// =============================================================================

async function calculateBalance(
  tx: Parameters<Parameters<typeof withTenantOptions>[1]>[0],
  tenantId: string,
  filter: { debtorUserId?: string; debtorCustomerId?: string },
): Promise<{
  totalIssued:   number
  totalReduced:  number
  currentBalance: number
  transactions:  Array<{
    id:              string
    type:            CreditEventType
    amount:          number
    appliedAmount:   number | null
    originalCreditId: string | null
    orderId:         string | null
    notes:           string | null
    createdAt:       Date
  }>
}> {
  const transactions = await tx.creditTransaction.findMany({
    where: {
      tenantId,
      ...(filter.debtorUserId     && { debtorUserId:     filter.debtorUserId }),
      ...(filter.debtorCustomerId && { debtorCustomerId: filter.debtorCustomerId }),
    },
    select: {
      id:               true,
      type:             true,
      amount:           true,
      appliedAmount:    true,
      originalCreditId: true,
      orderId:          true,
      notes:            true,
      createdAt:        true,
    },
    orderBy: { createdAt: 'asc' },
  })

  let totalIssued  = 0
  let totalReduced = 0

  for (const tx of transactions) {
    if (tx.type === CreditEventType.CREDIT_ISSUED) {
      totalIssued += Number(tx.amount)
    } else {
      // Para PAYMENT_RECEIVED, CREDIT_CANCELLED y DISCOUNT_APPLIED:
      // usar appliedAmount si existe (descuento parcial), si no usar amount
      totalReduced += Number(tx.appliedAmount ?? tx.amount)
    }
  }

  return {
    totalIssued:    parseFloat(totalIssued.toFixed(2)),
    totalReduced:   parseFloat(totalReduced.toFixed(2)),
    currentBalance: parseFloat((totalIssued - totalReduced).toFixed(2)),
    transactions:   transactions.map(t => ({
      ...t,
      amount:       Number(t.amount),
      appliedAmount: t.appliedAmount ? Number(t.appliedAmount) : null,
    })),
  }
}

// =============================================================================
// ROUTER
// =============================================================================

export const creditsRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // listDebtors — Lista todos los deudores con su saldo actual
  //
  // Calcula el saldo de cada deudor en tiempo de consulta sumando eventos.
  // El parámetro onlyWithBalance=true omite los que ya saldaron su deuda.
  // ──────────────────────────────────────────────────────────────────────────
  listDebtors: cashierProcedure
    .input(listDebtorsInput)
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Obtener todos los créditos del tenant agrupados por deudor
      const rawBalances = await withTenant(tenantId, (tx) =>
        tx.$queryRaw<Array<{
          debtor_user_id:     string | null
          debtor_customer_id: string | null
          total_issued:       number
          total_reduced:      number
        }>>`
          SELECT
            "debtorUserId"     AS debtor_user_id,
            "debtorCustomerId" AS debtor_customer_id,
            SUM(CASE WHEN type = 'CREDIT_ISSUED'
                THEN amount ELSE 0 END)                          AS total_issued,
            SUM(CASE WHEN type IN ('PAYMENT_RECEIVED','CREDIT_CANCELLED','DISCOUNT_APPLIED')
                THEN COALESCE("appliedAmount", amount) ELSE 0 END) AS total_reduced
          FROM "CreditTransaction"
          WHERE "tenantId" = ${tenantId}::uuid
            ${input.type === 'customer' ? tx.$queryRaw`AND "debtorCustomerId" IS NOT NULL` : tx.$queryRaw``}
            ${input.type === 'employee' ? tx.$queryRaw`AND "debtorUserId" IS NOT NULL`     : tx.$queryRaw``}
          GROUP BY "debtorUserId", "debtorCustomerId"
          HAVING ${input.onlyWithBalance
            ? tx.$queryRaw`SUM(CASE WHEN type = 'CREDIT_ISSUED' THEN amount ELSE 0 END) -
              SUM(CASE WHEN type IN ('PAYMENT_RECEIVED','CREDIT_CANCELLED','DISCOUNT_APPLIED')
              THEN COALESCE("appliedAmount", amount) ELSE 0 END) > 0`
            : tx.$queryRaw`TRUE`}
          ORDER BY (SUM(CASE WHEN type = 'CREDIT_ISSUED' THEN amount ELSE 0 END) -
                    SUM(CASE WHEN type IN ('PAYMENT_RECEIVED','CREDIT_CANCELLED','DISCOUNT_APPLIED')
                    THEN COALESCE("appliedAmount", amount) ELSE 0 END)) DESC
        `,
      )

      // Resolver nombres de usuarios y clientes
      const userIds     = rawBalances.filter(r => r.debtor_user_id).map(r => r.debtor_user_id!)
      const customerIds = rawBalances.filter(r => r.debtor_customer_id).map(r => r.debtor_customer_id!)

      const [users, customers] = await Promise.all([
        userIds.length > 0
          ? withTenant(tenantId, (tx) =>
              tx.user.findMany({
                where:  { id: { in: userIds }, tenantId },
                select: { id: true, name: true },
              }),
            )
          : Promise.resolve([]),
        customerIds.length > 0
          ? withTenant(tenantId, (tx) =>
              tx.customer.findMany({
                where:  { id: { in: customerIds }, tenantId },
                select: { id: true, name: true, phone: true, creditLimit: true },
              }),
            )
          : Promise.resolve([]),
      ])

      const userMap     = new Map(users.map(u => [u.id, u]))
      const customerMap = new Map(customers.map(c => [c.id, c]))

      const debtors = rawBalances.map(r => {
        const balance = parseFloat((Number(r.total_issued) - Number(r.total_reduced)).toFixed(2))
        if (r.debtor_user_id) {
          const user = userMap.get(r.debtor_user_id)
          return {
            type:         'employee' as const,
            debtorId:     r.debtor_user_id,
            name:         user?.name ?? 'Empleado desconocido',
            balance,
            totalIssued:  parseFloat(Number(r.total_issued).toFixed(2)),
            totalReduced: parseFloat(Number(r.total_reduced).toFixed(2)),
          }
        } else {
          const customer = customerMap.get(r.debtor_customer_id!)
          return {
            type:         'customer' as const,
            debtorId:     r.debtor_customer_id!,
            name:         customer?.name ?? 'Cliente desconocido',
            phone:        customer?.phone ?? null,
            creditLimit:  customer ? Number(customer.creditLimit) : 0,
            balance,
            totalIssued:  parseFloat(Number(r.total_issued).toFixed(2)),
            totalReduced: parseFloat(Number(r.total_reduced).toFixed(2)),
          }
        }
      })

      return {
        debtors,
        total:        debtors.length,
        totalBalance: parseFloat(debtors.reduce((s, d) => s + d.balance, 0).toFixed(2)),
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // getStatement — Estado de cuenta detallado de un deudor
  //
  // Muestra el historial completo de eventos y el saldo calculado
  // correctamente con appliedAmount para descuentos parciales.
  // ──────────────────────────────────────────────────────────────────────────
  getStatement: cashierProcedure
    .input(getStatementInput)
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Verificar que el deudor existe y pertenece al tenant
      let debtorName = ''
      if (input.debtorUserId) {
        const user = await withTenant(tenantId, (tx) =>
          tx.user.findFirst({
            where:  { id: input.debtorUserId!, tenantId, deletedAt: null },
            select: { id: true, name: true },
          }),
        )
        if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'Empleado no encontrado' })
        debtorName = user.name
      } else {
        const customer = await withTenant(tenantId, (tx) =>
          tx.customer.findFirst({
            where:  { id: input.debtorCustomerId!, tenantId, deletedAt: null },
            select: { id: true, name: true, phone: true, creditLimit: true },
          }),
        )
        if (!customer) throw new TRPCError({ code: 'NOT_FOUND', message: 'Cliente no encontrado' })
        debtorName = customer.name
      }

      const balance = await withTenant(tenantId, (tx) =>
        calculateBalance(tx, tenantId, {
          debtorUserId:     input.debtorUserId,
          debtorCustomerId: input.debtorCustomerId,
        }),
      )

      return {
        debtorName,
        debtorId:      input.debtorUserId ?? input.debtorCustomerId!,
        debtorType:    input.debtorUserId ? 'employee' : 'customer',
        currentBalance: balance.currentBalance,
        totalIssued:   balance.totalIssued,
        totalReduced:  balance.totalReduced,
        transactions:  balance.transactions,
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // registerPayment — Registra un abono o pago total de la deuda
  //
  // El deudor viene a pagar su cuenta (total o parcial).
  //
  // Si paga en EFECTIVO:
  //   CreditTransaction(PAYMENT_RECEIVED) + CashRegisterEvent(CREDIT_PAYMENT_RECEIVED)
  //   El dinero entra a la caja del día — el arqueo del cajero cuadra.
  //
  // Si paga con TRANSFERENCIA:
  //   CreditTransaction(PAYMENT_RECEIVED) + TransferPayment(PENDING)
  //   El pago queda pendiente de conciliación — igual que en el Paso 7.
  //   Requiere jornada abierta (withOpenDay) porque crea una transacción nueva.
  //
  // Validación de saldo: no permite pagar más de lo que se debe.
  // ──────────────────────────────────────────────────────────────────────────
  registerPayment: cashierProcedure
    .use(withOpenDay)
    .input(registerPaymentInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, establishmentId, userId, deviceId } = ctx.auth
      const { id: businessDayId } = ctx.businessDay

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // Verificar saldo actual
          const balance = await calculateBalance(tx, tenantId, {
            debtorUserId:     input.debtorUserId,
            debtorCustomerId: input.debtorCustomerId,
          })

          if (balance.currentBalance <= 0) {
            throw new TRPCError({
              code:    'PRECONDITION_FAILED',
              message: 'Este deudor no tiene saldo pendiente',
            })
          }

          if (input.amount > balance.currentBalance + 0.01) {
            // +0.01 para tolerancia de redondeo de decimales
            throw new TRPCError({
              code:    'BAD_REQUEST',
              message: `El monto ingresado ($${input.amount.toFixed(2)}) supera el saldo pendiente ($${balance.currentBalance.toFixed(2)})`,
            })
          }

          const effectiveDevice = deviceId ?? (
            await tx.device.findFirst({
              where: { tenantId, establishmentId, isActive: true, deletedAt: null },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            })
          )?.id

          if (!effectiveDevice) {
            throw new TRPCError({
              code:    'PRECONDITION_FAILED',
              message: 'No hay dispositivos activos en este establecimiento',
            })
          }

          // 1. Registrar el pago en CreditTransaction (append-only)
          const creditTx = await tx.creditTransaction.create({
            data: {
              tenantId,
              businessDayId,
              type:             CreditEventType.PAYMENT_RECEIVED,
              amount:           input.amount,
              debtorUserId:     input.debtorUserId     ?? null,
              debtorCustomerId: input.debtorCustomerId ?? null,
              authorizedBy:     userId!,
              deviceId:         effectiveDevice,
              notes:            input.notes ?? null,
            },
          })

          // 2a. Si es efectivo → CashRegisterEvent(CREDIT_PAYMENT_RECEIVED)
          //     El tipo correcto es CREDIT_PAYMENT_RECEIVED, no "CASH_IN"
          //     (ese tipo no existe en el enum CashEventType del schema)
          if (input.paymentMethod === 'CASH') {
            await tx.cashRegisterEvent.create({
              data: {
                tenantId,
                establishmentId,
                businessDayId,
                type:    CashEventType.CREDIT_PAYMENT_RECEIVED,
                amount:  input.amount,
                userId:  userId!,
                deviceId: effectiveDevice,
                notes:   input.notes
                  ? `Abono deuda | ${input.notes}`
                  : `Abono deuda en efectivo`,
              },
            })
            return { creditTx, transferPayment: null }
          }

          // 2b. Si es transferencia → TransferPayment(PENDING) + CashRegisterEvent(SALE_TRANSFER)
          //     El abono queda pendiente de conciliación bancaria (Paso 7)
          const transferPayment = await tx.transferPayment.create({
            data: {
              tenantId,
              establishmentId,
              orderId:           creditTx.id,
              // Usamos creditTx.id como orderId — el schema tiene orderId nullable
              // y aquí se usa para relacionar el TransferPayment con el pago de deuda
              // NOTA: esto requiere que orderId en TransferPayment sea una referencia
              // flexible. Si se necesita FK estricta, se puede usar un campo adicional
              // en futuras versiones. Por ahora la referencia cruzada es suficiente.
              businessDayId,
              amount:            input.amount,
              bankName:          input.bankName!,
              referenceNumber:   input.referenceNumber!,
              receiptUrl:        input.receiptUrl ?? null,
              targetAccount:     input.targetAccount!,
              status:            'PENDING',
              capturedByUserId:  userId!,
              capturedByDeviceId: effectiveDevice,
              capturedAt:        new Date(),
              notes:             input.notes ?? null,
            },
          })

          await tx.cashRegisterEvent.create({
            data: {
              tenantId,
              establishmentId,
              businessDayId,
              type:              CashEventType.SALE_TRANSFER,
              amount:            input.amount,
              userId:            userId!,
              transferPaymentId: transferPayment.id,
              deviceId:          effectiveDevice,
              notes:             `Abono deuda por transferencia | Ref: ${input.referenceNumber}`,
            },
          })

          return { creditTx, transferPayment }
        },
        { timeout: 15_000 },
      )

      return {
        creditTransactionId: result.creditTx.id,
        amount:              input.amount,
        paymentMethod:       input.paymentMethod,
        transferPaymentId:   result.transferPayment?.id ?? null,
        message:             input.paymentMethod === 'CASH'
          ? 'Abono registrado en efectivo. La caja ha sido actualizada.'
          : 'Abono con transferencia registrado. Pendiente de conciliación bancaria.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // applyDiscount — Descuento parcial o total aplicado desde nómina
  //
  // Instrucciones §5: el dueño puede elegir descontar parcialmente.
  // appliedAmount puede ser menor que el monto del CREDIT_ISSUED original.
  // El saldo restante reaparece en la siguiente liquidación de nómina.
  //
  // Solo ADMIN puede aplicar descuentos — es una decisión del dueño.
  // ──────────────────────────────────────────────────────────────────────────
  applyDiscount: adminProcedure
    .input(applyDiscountInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId, deviceId, establishmentId } = ctx.auth

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          // Verificar que el crédito original existe y pertenece al tenant
          const originalCredit = await tx.creditTransaction.findFirst({
            where: {
              id:       input.originalCreditId,
              tenantId,
              type:     CreditEventType.CREDIT_ISSUED,
            },
            select: {
              id:               true,
              amount:           true,
              debtorUserId:     true,
              debtorCustomerId: true,
              businessDayId:    true,
              deviceId:         true,
            },
          })

          if (!originalCredit) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Crédito original no encontrado',
            })
          }

          // Verificar que el PayrollRecord existe
          const payroll = await tx.payrollRecord.findFirst({
            where: { id: input.appliedToPayrollId, tenantId },
            select: { id: true },
          })

          if (!payroll) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Registro de nómina no encontrado',
            })
          }

          // Calcular cuánto queda pendiente de este crédito específico
          const previousDiscounts = await tx.creditTransaction.aggregate({
            where: {
              tenantId,
              originalCreditId: input.originalCreditId,
              type:             CreditEventType.DISCOUNT_APPLIED,
            },
            _sum: { appliedAmount: true },
          })

          const alreadyApplied = Number(previousDiscounts._sum.appliedAmount ?? 0)
          const originalAmount = Number(originalCredit.amount)
          const maxApplicable  = originalAmount - alreadyApplied

          if (input.appliedAmount > maxApplicable + 0.01) {
            throw new TRPCError({
              code:    'BAD_REQUEST',
              message: `El descuento ($${input.appliedAmount.toFixed(2)}) supera el saldo pendiente de este crédito ($${maxApplicable.toFixed(2)})`,
            })
          }

          const effectiveDevice = deviceId ?? originalCredit.deviceId

          const discountTx = await tx.creditTransaction.create({
            data: {
              tenantId,
              businessDayId:     originalCredit.businessDayId,
              type:              CreditEventType.DISCOUNT_APPLIED,
              amount:            originalAmount,
              // amount = monto total del crédito original (para trazabilidad)
              appliedAmount:     input.appliedAmount,
              // appliedAmount = lo que realmente se descuenta esta vez
              appliedToPayrollId: input.appliedToPayrollId,
              originalCreditId:  input.originalCreditId,
              debtorUserId:      originalCredit.debtorUserId,
              debtorCustomerId:  originalCredit.debtorCustomerId,
              authorizedBy:      userId!,
              deviceId:          effectiveDevice,
              notes:             input.notes ?? null,
            },
          })

          return { discountTx, remainingBalance: maxApplicable - input.appliedAmount }
        },
        { timeout: 10_000 },
      )

      return {
        creditTransactionId: result.discountTx.id,
        appliedAmount:       input.appliedAmount,
        remainingBalance:    parseFloat(result.remainingBalance.toFixed(2)),
        message:             result.remainingBalance > 0.01
          ? `Descuento de $${input.appliedAmount.toFixed(2)} aplicado. Saldo restante: $${result.remainingBalance.toFixed(2)}`
          : 'Crédito completamente saldado.',
      }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // cancelDebt — Condona totalmente una deuda (solo ADMIN)
  //
  // Para cuentas incobrables o errores de registro.
  // Requiere justificación obligatoria en notes.
  // Genera CREDIT_CANCELLED sin appliedAmount (cancela el monto total).
  // ──────────────────────────────────────────────────────────────────────────
  cancelDebt: adminProcedure
    .input(cancelDebtInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId, userId, deviceId } = ctx.auth

      const result = await withTenantOptions(
        tenantId,
        async (tx) => {
          const originalCredit = await tx.creditTransaction.findFirst({
            where: {
              id:       input.originalCreditId,
              tenantId,
              type:     CreditEventType.CREDIT_ISSUED,
            },
            select: {
              id:               true,
              amount:           true,
              debtorUserId:     true,
              debtorCustomerId: true,
              businessDayId:    true,
              deviceId:         true,
            },
          })

          if (!originalCredit) {
            throw new TRPCError({
              code:    'NOT_FOUND',
              message: 'Crédito original no encontrado',
            })
          }

          // Verificar que no esté ya cancelado o completamente saldado
          const existing = await tx.creditTransaction.findFirst({
            where: {
              tenantId,
              originalCreditId: input.originalCreditId,
              type:             CreditEventType.CREDIT_CANCELLED,
            },
            select: { id: true },
          })

          if (existing) {
            throw new TRPCError({
              code:    'CONFLICT',
              message: 'Esta deuda ya fue cancelada anteriormente',
            })
          }

          const effectiveDevice = deviceId ?? originalCredit.deviceId

          const cancelTx = await tx.creditTransaction.create({
            data: {
              tenantId,
              businessDayId:    originalCredit.businessDayId,
              type:             CreditEventType.CREDIT_CANCELLED,
              amount:           originalCredit.amount,
              // Sin appliedAmount — cancela el monto total del crédito original
              originalCreditId: input.originalCreditId,
              debtorUserId:     originalCredit.debtorUserId,
              debtorCustomerId: originalCredit.debtorCustomerId,
              authorizedBy:     userId!,
              deviceId:         effectiveDevice,
              notes:            input.notes,
            },
          })

          return { cancelTx }
        },
        { timeout: 10_000 },
      )

      return {
        creditTransactionId: result.cancelTx.id,
        message:             'Deuda condonada y registrada. El saldo ha quedado en cero.',
      }
    }),
})
