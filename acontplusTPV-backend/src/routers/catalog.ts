// =============================================================================
// apps/api/src/routers/catalog.ts
// CRUD de Categorías y Productos
//
// Lecturas:  anyUserRoleProcedure — mesero y kiosco necesitan el menú
// Escrituras: adminProcedure — solo ADMIN modifica el catálogo
//
// Soft delete: deletedAt — los registros no se borran físicamente.
// La app móvil nunca ve productos con deletedAt != null gracias a RLS
// y al filtro isActive=true en todas las queries de lectura.
// =============================================================================

import { z }          from 'zod'
import { TRPCError }  from '@trpc/server'
import { router }     from '../trpc'
import { adminProcedure, anyUserRoleProcedure } from '../middleware/auth'
import { withTenant } from '../lib/rls'
import { ProductUnit } from '@prisma/client'

// =============================================================================
// SCHEMAS
// =============================================================================

const categoryCreateInput = z.object({
  name:         z.string().min(1).max(100),
  description:  z.string().max(500).optional(),
  displayOrder: z.number().int().min(0).default(0),
})

const categoryUpdateInput = z.object({
  id:           z.string().uuid(),
  name:         z.string().min(1).max(100).optional(),
  description:  z.string().max(500).nullish(),
  displayOrder: z.number().int().min(0).optional(),
  isActive:     z.boolean().optional(),
})

const productCreateInput = z.object({
  categoryId:   z.string().uuid(),
  name:         z.string().min(1).max(200),
  description:  z.string().max(1000).optional(),
  salePrice:    z.number().positive(),
  reorderPoint: z.number().min(0).default(0),
  unit:         z.nativeEnum(ProductUnit).default(ProductUnit.UNIT),
})

const productUpdateInput = z.object({
  id:           z.string().uuid(),
  categoryId:   z.string().uuid().optional(),
  name:         z.string().min(1).max(200).optional(),
  description:  z.string().max(1000).nullish(),
  salePrice:    z.number().positive().optional(),
  reorderPoint: z.number().min(0).optional(),
  unit:         z.nativeEnum(ProductUnit).optional(),
  isActive:     z.boolean().optional(),
})

// =============================================================================
// ROUTER
// =============================================================================

export const catalogRouter = router({

  // ──────────────────────────────────────────────────────────────────────────
  // CATEGORÍAS
  // ──────────────────────────────────────────────────────────────────────────

  // Lista todas las categorías activas — disponible para mesero y kiosco
  listCategories: anyUserRoleProcedure
    .query(async ({ ctx }) => {
      const { tenantId } = ctx.auth

      const categories = await withTenant(tenantId, (tx) =>
        tx.productCategory.findMany({
          where: {
            tenantId,
            isActive:  true,
            deletedAt: null,
          },
          select: {
            id:           true,
            name:         true,
            description:  true,
            displayOrder: true,
            isActive:     true,
          },
          orderBy: [
            { displayOrder: 'asc' },
            { name:         'asc' },
          ],
        }),
      )

      return { categories, total: categories.length }
    }),

  // Lista con conteo de productos — para el panel de admin
  listCategoriesAdmin: adminProcedure
    .query(async ({ ctx }) => {
      const { tenantId } = ctx.auth

      const categories = await withTenant(tenantId, (tx) =>
        tx.productCategory.findMany({
          where:   { tenantId, deletedAt: null },
          select: {
            id:           true,
            name:         true,
            description:  true,
            displayOrder: true,
            isActive:     true,
            createdAt:    true,
            _count: {
              select: {
                products: {
                  where: { deletedAt: null },
                },
              },
            },
          },
          orderBy: [
            { displayOrder: 'asc' },
            { name:         'asc' },
          ],
        }),
      )

      return {
        categories: categories.map(c => ({
          ...c,
          productCount: c._count.products,
        })),
        total: categories.length,
      }
    }),

  createCategory: adminProcedure
    .input(categoryCreateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Nombre único por tenant
      const existing = await withTenant(tenantId, (tx) =>
        tx.productCategory.findFirst({
          where: { tenantId, name: input.name, deletedAt: null },
          select: { id: true },
        }),
      )

      if (existing) {
        throw new TRPCError({
          code:    'CONFLICT',
          message: `Ya existe una categoría con el nombre "${input.name}"`,
        })
      }

      const category = await withTenant(tenantId, (tx) =>
        tx.productCategory.create({
          data: {
            tenantId,
            name:         input.name,
            description:  input.description ?? null,
            displayOrder: input.displayOrder,
            isActive:     true,
          },
        }),
      )

      return { category }
    }),

  updateCategory: adminProcedure
    .input(categoryUpdateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const category = await withTenant(tenantId, (tx) =>
        tx.productCategory.findFirst({
          where: { id: input.id, tenantId, deletedAt: null },
          select: { id: true },
        }),
      )

      if (!category) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Categoría no encontrada' })
      }

      // Verificar unicidad de nombre si se está cambiando
      if (input.name) {
        const nameConflict = await withTenant(tenantId, (tx) =>
          tx.productCategory.findFirst({
            where: {
              tenantId,
              name:      input.name!,
              deletedAt: null,
              id:        { not: input.id },
            },
            select: { id: true },
          }),
        )
        if (nameConflict) {
          throw new TRPCError({
            code:    'CONFLICT',
            message: `Ya existe una categoría con el nombre "${input.name}"`,
          })
        }
      }

      const updated = await withTenant(tenantId, (tx) =>
        tx.productCategory.update({
          where: { id: input.id },
          data: {
            ...(input.name         !== undefined && { name:         input.name }),
            ...(input.description  !== undefined && { description:  input.description }),
            ...(input.displayOrder !== undefined && { displayOrder: input.displayOrder }),
            ...(input.isActive     !== undefined && { isActive:     input.isActive }),
          },
        }),
      )

      return { category: updated }
    }),

  deleteCategory: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Verificar que no tenga productos activos
      const productCount = await withTenant(tenantId, (tx) =>
        tx.product.count({
          where: {
            categoryId: input.id,
            tenantId,
            deletedAt:  null,
          },
        }),
      )

      if (productCount > 0) {
        throw new TRPCError({
          code:    'PRECONDITION_FAILED',
          message: `No se puede eliminar la categoría porque tiene ${productCount} producto(s) asociado(s). ` +
                   'Desactívalos o muévelos a otra categoría primero.',
        })
      }

      await withTenant(tenantId, (tx) =>
        tx.productCategory.update({
          where: { id: input.id },
          data:  { deletedAt: new Date(), isActive: false },
        }),
      )

      return { success: true }
    }),

  // ──────────────────────────────────────────────────────────────────────────
  // PRODUCTOS
  // ──────────────────────────────────────────────────────────────────────────

  // Catálogo completo para la app del mesero y el kiosco
  // Incluye el stock actual de la bodega default para mostrar disponibilidad
  listProducts: anyUserRoleProcedure
    .input(z.object({
      categoryId:     z.string().uuid().optional(),
      includeInactive: z.boolean().default(false),
    }).default({}))
    .query(async ({ input, ctx }) => {
      const { tenantId, establishmentId } = ctx.auth

      const products = await withTenant(tenantId, (tx) =>
        tx.product.findMany({
          where: {
            tenantId,
            deletedAt:  null,
            isActive:   input.includeInactive ? undefined : true,
            ...(input.categoryId && { categoryId: input.categoryId }),
          },
          select: {
            id:                 true,
            categoryId:         true,
            name:               true,
            description:        true,
            salePrice:          true,
            currentAverageCost: true,
            reorderPoint:       true,
            unit:               true,
            isActive:           true,
            category: {
              select: { id: true, name: true, displayOrder: true },
            },
            // Stock de la bodega default del establecimiento
            stockLevels: {
              where: {
                warehouse: {
                  establishmentId,
                  isDefault:  true,
                  isActive:   true,
                  deletedAt:  null,
                },
              },
              select: {
                quantity:   true,
                warehouseId: true,
              },
              take: 1,
            },
          },
          orderBy: [
            { category: { displayOrder: 'asc' } },
            { name:     'asc' },
          ],
        }),
      )

      return {
        products: products.map(p => ({
          ...p,
          salePrice:          Number(p.salePrice),
          currentAverageCost: Number(p.currentAverageCost),
          reorderPoint:       Number(p.reorderPoint),
          currentStock:       p.stockLevels[0]
            ? Number(p.stockLevels[0].quantity)
            : null,
          stockLevels: undefined, // no exponer el array crudo
        })),
        total: products.length,
      }
    }),

  // Detalle de un producto — incluye todos los stock levels por bodega
  getProduct: anyUserRoleProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const product = await withTenant(tenantId, (tx) =>
        tx.product.findFirst({
          where: { id: input.id, tenantId, deletedAt: null },
          include: {
            category: {
              select: { id: true, name: true },
            },
            stockLevels: {
              include: {
                warehouse: {
                  select: { id: true, name: true, type: true, isDefault: true },
                },
              },
            },
          },
        }),
      )

      if (!product) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Producto no encontrado' })
      }

      return {
        product: {
          ...product,
          salePrice:          Number(product.salePrice),
          currentAverageCost: Number(product.currentAverageCost),
          reorderPoint:       Number(product.reorderPoint),
          stockLevels: product.stockLevels.map(sl => ({
            ...sl,
            quantity: Number(sl.quantity),
          })),
        },
      }
    }),

  createProduct: adminProcedure
    .input(productCreateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // Verificar que la categoría existe y pertenece al tenant
      const category = await withTenant(tenantId, (tx) =>
        tx.productCategory.findFirst({
          where: { id: input.categoryId, tenantId, deletedAt: null, isActive: true },
          select: { id: true, name: true },
        }),
      )

      if (!category) {
        throw new TRPCError({
          code:    'NOT_FOUND',
          message: 'Categoría no encontrada o inactiva',
        })
      }

      // Nombre único por tenant dentro de la misma categoría
      const existing = await withTenant(tenantId, (tx) =>
        tx.product.findFirst({
          where: {
            tenantId,
            categoryId: input.categoryId,
            name:       input.name,
            deletedAt:  null,
          },
          select: { id: true },
        }),
      )

      if (existing) {
        throw new TRPCError({
          code:    'CONFLICT',
          message: `Ya existe un producto con el nombre "${input.name}" en la categoría "${category.name}"`,
        })
      }

      const product = await withTenant(tenantId, (tx) =>
        tx.product.create({
          data: {
            tenantId,
            categoryId:         input.categoryId,
            name:               input.name,
            description:        input.description ?? null,
            salePrice:          input.salePrice,
            currentAverageCost: 0,    // se actualiza con las primeras compras
            reorderPoint:       input.reorderPoint,
            unit:               input.unit,
            isActive:           true,
          },
          include: {
            category: { select: { id: true, name: true } },
          },
        }),
      )

      return {
        product: {
          ...product,
          salePrice:          Number(product.salePrice),
          currentAverageCost: Number(product.currentAverageCost),
          reorderPoint:       Number(product.reorderPoint),
        },
      }
    }),

  updateProduct: adminProcedure
    .input(productUpdateInput)
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      const product = await withTenant(tenantId, (tx) =>
        tx.product.findFirst({
          where:  { id: input.id, tenantId, deletedAt: null },
          select: { id: true, categoryId: true, name: true },
        }),
      )

      if (!product) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Producto no encontrado' })
      }

      // Si se cambia de categoría, verificar que la nueva existe
      if (input.categoryId && input.categoryId !== product.categoryId) {
        const category = await withTenant(tenantId, (tx) =>
          tx.productCategory.findFirst({
            where:  { id: input.categoryId!, tenantId, deletedAt: null },
            select: { id: true },
          }),
        )
        if (!category) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Categoría destino no encontrada' })
        }
      }

      const updated = await withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: input.id },
          data: {
            ...(input.categoryId  !== undefined && { categoryId:  input.categoryId }),
            ...(input.name        !== undefined && { name:        input.name }),
            ...(input.description !== undefined && { description: input.description }),
            ...(input.salePrice   !== undefined && { salePrice:   input.salePrice }),
            ...(input.reorderPoint !== undefined && { reorderPoint: input.reorderPoint }),
            ...(input.unit        !== undefined && { unit:        input.unit }),
            ...(input.isActive    !== undefined && { isActive:    input.isActive }),
          },
          include: {
            category: { select: { id: true, name: true } },
          },
        }),
      )

      return {
        product: {
          ...updated,
          salePrice:          Number(updated.salePrice),
          currentAverageCost: Number(updated.currentAverageCost),
          reorderPoint:       Number(updated.reorderPoint),
        },
      }
    }),

  deleteProduct: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { tenantId } = ctx.auth

      // No se puede eliminar si hay orderItems activos asociados
      const activeOrders = await withTenant(tenantId, (tx) =>
        tx.orderItem.count({
          where: {
            productId: input.id,
            tenantId,
            order: {
              status: {
                notIn: ['CANCELLED', 'EXPIRED', 'PAID_CASH',
                        'PAID_TRANSFER_CONFIRMED', 'PAID_CREDIT'],
              },
            },
          },
        }),
      )

      if (activeOrders > 0) {
        throw new TRPCError({
          code:    'PRECONDITION_FAILED',
          message: 'No se puede eliminar el producto porque tiene pedidos activos asociados',
        })
      }

      await withTenant(tenantId, (tx) =>
        tx.product.update({
          where: { id: input.id },
          data:  { deletedAt: new Date(), isActive: false },
        }),
      )

      return { success: true }
    }),
})
