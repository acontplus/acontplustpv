// =============================================================================
// apps/api/src/routers/supplier.ts
// CRUD de Proveedores
//
// Los proveedores son entidades a nivel de tenant (compartidos entre
// establecimientos). Solo ADMIN puede crear/editar/eliminar.
// Cualquier rol autenticado puede listarlos (necesario para el formulario
// de órdenes de compra en el Paso 9).
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { adminProcedure, anyUserRoleProcedure } from '../middleware/auth'
import { withTenant } from '../lib/rls'

const supplierCreateInput = z.object({
  name:    z.string().min(1).max(200),
  phone:   z.string().max(20).optional(),
  email:   z.string().email().optional(),
  address: z.string().max(500).optional(),
})

const supplierUpdateInput = z.object({
  id:       z.string().uuid(),
  name:     z.string().min(1).max(200).optional(),
  phone:    z.string().max(20).nullish(),
  email:    z.string().email().nullish(),
  address:  z.string().max(500).nullish(),
  isActive: z.boolean().optional(),
})

export const supplierRouter = router({

  list: anyUserRoleProcedure
    .input(z.object({
      includeInactive: z.boolean().default(false),
    }).default({}))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const suppliers = await withTenant(tenantId, (tx) =>
        tx.supplier.findMany({
          where: {
            tenantId,
            deletedAt: null,
            isActive:  input.includeInactive ? undefined : true,
          },
          select: {
            id:       true,
            name:     true,
            phone:    true,
            email:    true,
            address:  true,
            isActive: true,
          },
          orderBy: { name: 'asc' },
        }),
      )

      return { suppliers, total: suppliers.length }
    }),

  getById: anyUserRoleProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const supplier = await withTenant(tenantId, (tx) =>
        tx.supplier.findFirst({
          where:  { id: input.id, tenantId, deletedAt: null },
          select: {
            id:        true,
            name:      true,
            phone:     true,
            email:     true,
            address:   true,
            isActive:  true,
            createdAt: true,
            _count: {
              select: { purchaseOrders: true },
            },
          },
        }),
      )

      if (!supplier) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proveedor no encontrado' })
      }

      return {
        supplier: {
          ...supplier,
          purchaseOrderCount: supplier._count.purchaseOrders,
        },
      }
    }),

  create: adminProcedure
    .input(supplierCreateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Nombre único por tenant (constraint del schema)
      const existing = await withTenant(tenantId, (tx) =>
        tx.supplier.findFirst({
          where: { tenantId, name: input.name, deletedAt: null },
          select: { id: true },
        }),
      )

      if (existing) {
        throw new TRPCError({
          code:    'CONFLICT',
          message: `Ya existe un proveedor con el nombre "${input.name}"`,
        })
      }

      const supplier = await withTenant(tenantId, (tx) =>
        tx.supplier.create({
          data: {
            tenantId,
            name:    input.name,
            phone:   input.phone   ?? null,
            email:   input.email   ?? null,
            address: input.address ?? null,
            isActive: true,
          },
        }),
      )

      return { supplier }
    }),

  update: adminProcedure
    .input(supplierUpdateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const supplier = await withTenant(tenantId, (tx) =>
        tx.supplier.findFirst({
          where:  { id: input.id, tenantId, deletedAt: null },
          select: { id: true },
        }),
      )

      if (!supplier) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Proveedor no encontrado' })
      }

      if (input.name) {
        const conflict = await withTenant(tenantId, (tx) =>
          tx.supplier.findFirst({
            where: {
              tenantId,
              name:      input.name!,
              deletedAt: null,
              id:        { not: input.id },
            },
            select: { id: true },
          }),
        )
        if (conflict) {
          throw new TRPCError({
            code:    'CONFLICT',
            message: `Ya existe un proveedor con el nombre "${input.name}"`,
          })
        }
      }

      const updated = await withTenant(tenantId, (tx) =>
        tx.supplier.update({
          where: { id: input.id },
          data: {
            ...(input.name     !== undefined && { name:     input.name }),
            ...(input.phone    !== undefined && { phone:    input.phone }),
            ...(input.email    !== undefined && { email:    input.email }),
            ...(input.address  !== undefined && { address:  input.address }),
            ...(input.isActive !== undefined && { isActive: input.isActive }),
          },
        }),
      )

      return { supplier: updated }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // No borrar si tiene órdenes de compra
      const orderCount = await withTenant(tenantId, (tx) =>
        tx.purchaseOrder.count({
          where: { supplierId: input.id, tenantId },
        }),
      )

      if (orderCount > 0) {
        throw new TRPCError({
          code:    'PRECONDITION_FAILED',
          message: `No se puede eliminar el proveedor porque tiene ${orderCount} orden(es) de compra registrada(s)`,
        })
      }

      await withTenant(tenantId, (tx) =>
        tx.supplier.update({
          where: { id: input.id },
          data:  { deletedAt: new Date(), isActive: false },
        }),
      )

      return { success: true }
    }),
})
