// =============================================================================
// apps/api/src/routers/warehouse.ts
// CRUD de Bodegas
//
// Las bodegas pertenecen a un Establishment específico (no al tenant global).
// Regla crítica (Instrucciones §6):
//   isDefault = true → bodega desde la que se descuentan ventas automáticamente.
//   Solo puede haber UNA bodega default por establecimiento.
//   Al marcar una como default, se desmarca la anterior en la misma transacción.
//
// Lecturas: anyUserRoleProcedure — el mesero y el PRINT_NODE necesitan saber
//           a qué bodega apuntar al descontar stock.
// Escrituras: adminProcedure.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { adminProcedure, anyUserRoleProcedure } from '../middleware/auth'
import { withTenant, withTenantOptions } from '../lib/rls'
import { WarehouseType } from '@prisma/client'

const warehouseCreateInput = z.object({
  establishmentId: z.string().uuid(),
  name:            z.string().min(1).max(100),
  type:            z.nativeEnum(WarehouseType).default(WarehouseType.MAIN_STORAGE),
  isDefault:       z.boolean().default(false),
})

const warehouseUpdateInput = z.object({
  id:        z.string().uuid(),
  name:      z.string().min(1).max(100).optional(),
  type:      z.nativeEnum(WarehouseType).optional(),
  isDefault: z.boolean().optional(),
  isActive:  z.boolean().optional(),
})

export const warehouseRouter = router({

  // Lista bodegas de un establecimiento
  list: anyUserRoleProcedure
    .input(z.object({
      establishmentId: z.string().uuid(),
      includeInactive: z.boolean().default(false),
    }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Verificar que el establecimiento pertenece al tenant
      const establishment = await withTenant(tenantId, (tx) =>
        tx.establishment.findFirst({
          where:  { id: input.establishmentId, tenantId, deletedAt: null },
          select: { id: true, name: true },
        }),
      )

      if (!establishment) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Establecimiento no encontrado',
        })
      }

      const warehouses = await withTenant(tenantId, (tx) =>
        tx.warehouse.findMany({
          where: {
            tenantId,
            establishmentId: input.establishmentId,
            deletedAt:       null,
            isActive:        input.includeInactive ? undefined : true,
          },
          select: {
            id:              true,
            name:            true,
            type:            true,
            isDefault:       true,
            isActive:        true,
            establishmentId: true,
          },
          orderBy: [
            { isDefault: 'desc' }, // la default primero
            { name:      'asc' },
          ],
        }),
      )

      return {
        warehouses,
        establishment,
        total: warehouses.length,
      }
    }),

  getById: anyUserRoleProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const warehouse = await withTenant(tenantId, (tx) =>
        tx.warehouse.findFirst({
          where: { id: input.id, tenantId, deletedAt: null },
          include: {
            establishment: {
              select: { id: true, name: true, code: true },
            },
            stockLevels: {
              where: { product: { isActive: true, deletedAt: null } },
              include: {
                product: {
                  select: { id: true, name: true, unit: true, reorderPoint: true },
                },
              },
              orderBy: { product: { name: 'asc' } },
            },
          },
        }),
      )

      if (!warehouse) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Bodega no encontrada' })
      }

      return {
        warehouse: {
          ...warehouse,
          stockLevels: warehouse.stockLevels.map(sl => ({
            ...sl,
            quantity:     Number(sl.quantity),
            belowReorder: Number(sl.quantity) < Number(sl.product.reorderPoint),
          })),
        },
      }
    }),

  create: adminProcedure
    .input(warehouseCreateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Verificar que el establecimiento pertenece al tenant
      const establishment = await withTenant(tenantId, (tx) =>
        tx.establishment.findFirst({
          where:  { id: input.establishmentId, tenantId, deletedAt: null, isActive: true },
          select: { id: true, name: true },
        }),
      )

      if (!establishment) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Establecimiento no encontrado o inactivo',
        })
      }

      // Nombre único dentro del establecimiento (constraint del schema)
      const existing = await withTenant(tenantId, (tx) =>
        tx.warehouse.findFirst({
          where: {
            tenantId,
            establishmentId: input.establishmentId,
            name:            input.name,
            deletedAt:       null,
          },
          select: { id: true },
        }),
      )

      if (existing) {
        throw new TRPCError({
          code:    'CONFLICT',
          message: `Ya existe una bodega con el nombre "${input.name}" en este establecimiento`,
        })
      }

      // Si isDefault=true, desmarcar la anterior y marcar la nueva en una transacción
      const warehouse = await withTenantOptions(
        tenantId,
        async (tx) => {
          if (input.isDefault) {
            await tx.warehouse.updateMany({
              where: {
                tenantId,
                establishmentId: input.establishmentId,
                isDefault:       true,
              },
              data: { isDefault: false },
            })
          }

          return tx.warehouse.create({
            data: {
              tenantId,
              establishmentId: input.establishmentId,
              name:            input.name,
              type:            input.type,
              isDefault:       input.isDefault,
              isActive:        true,
            },
          })
        },
        { timeout: 10_000 },
      )

      return { warehouse }
    }),

  update: adminProcedure
    .input(warehouseUpdateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const warehouse = await withTenant(tenantId, (tx) =>
        tx.warehouse.findFirst({
          where:  { id: input.id, tenantId, deletedAt: null },
          select: { id: true, establishmentId: true, isDefault: true },
        }),
      )

      if (!warehouse) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Bodega no encontrada' })
      }

      // Verificar unicidad de nombre si se cambia
      if (input.name) {
        const conflict = await withTenant(tenantId, (tx) =>
          tx.warehouse.findFirst({
            where: {
              tenantId,
              establishmentId: warehouse.establishmentId,
              name:            input.name!,
              deletedAt:       null,
              id:              { not: input.id },
            },
            select: { id: true },
          }),
        )
        if (conflict) {
          throw new TRPCError({
            code:    'CONFLICT',
            message: `Ya existe una bodega con el nombre "${input.name}" en este establecimiento`,
          })
        }
      }

      // Si se marca como default, desmarcar la anterior en la misma transacción
      const updated = await withTenantOptions(
        tenantId,
        async (tx) => {
          if (input.isDefault === true && !warehouse.isDefault) {
            await tx.warehouse.updateMany({
              where: {
                tenantId,
                establishmentId: warehouse.establishmentId,
                isDefault:       true,
              },
              data: { isDefault: false },
            })
          }

          return tx.warehouse.update({
            where: { id: input.id },
            data: {
              ...(input.name      !== undefined && { name:      input.name }),
              ...(input.type      !== undefined && { type:      input.type }),
              ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
              ...(input.isActive  !== undefined && { isActive:  input.isActive }),
            },
          })
        },
        { timeout: 10_000 },
      )

      return { warehouse: updated }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const warehouse = await withTenant(tenantId, (tx) =>
        tx.warehouse.findFirst({
          where:  { id: input.id, tenantId, deletedAt: null },
          select: { id: true, isDefault: true, name: true },
        }),
      )

      if (!warehouse) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Bodega no encontrada' })
      }

      // No se puede eliminar la bodega default
      if (warehouse.isDefault) {
        throw new TRPCError({
          code:    'PRECONDITION_FAILED',
          message: 'No se puede eliminar la bodega predeterminada. ' +
                   'Asigna otra bodega como predeterminada primero.',
        })
      }

      // Verificar que no tenga stock activo
      const stockCount = await withTenant(tenantId, (tx) =>
        tx.stockLevel.count({
          where: {
            warehouseId: input.id,
            tenantId,
            quantity:    { gt: 0 },
          },
        }),
      )

      if (stockCount > 0) {
        throw new TRPCError({
          code:    'PRECONDITION_FAILED',
          message: `La bodega tiene stock activo en ${stockCount} producto(s). ` +
                   'Transfiere o ajusta el inventario antes de eliminarla.',
        })
      }

      await withTenant(tenantId, (tx) =>
        tx.warehouse.update({
          where: { id: input.id },
          data:  { deletedAt: new Date(), isActive: false },
        }),
      )

      return { success: true }
    }),
})
