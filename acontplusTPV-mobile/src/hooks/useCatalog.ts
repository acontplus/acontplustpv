// =============================================================================
// src/hooks/useCatalog.ts
// Hook reactivo de catálogo — PowerSync SQLite
// =============================================================================

import { useQuery } from '@powersync/react'

export interface ProductWithCategory {
  id: string
  name: string
  description: string | null
  sale_price: number
  category_id: string
  category_name: string
}

export interface CategoryWithProducts {
  id: string
  name: string
  display_order: number
  products: ProductWithCategory[]
}

export const useCatalog = () => {
  // 1. Obtener categorías activas
  const { data: categories, isLoading: loadingCats } = useQuery<{
    id: string
    name: string
    display_order: number
  }>(`
    SELECT id, name, display_order 
    FROM ProductCategory 
    WHERE is_active = 1 
    ORDER BY display_order ASC
  `)

  // 2. Obtener productos activos
  const { data: products, isLoading: loadingProds } = useQuery<{
    id: string
    name: string
    description: string | null
    sale_price: number
    category_id: string
  }>(`
    SELECT id, name, description, sale_price, category_id 
    FROM Product 
    WHERE is_active = 1
    ORDER BY name ASC
  `)

  const isLoading = loadingCats || loadingProds

  // 3. Agrupar productos dentro de sus respectivas categorías
  const catalog: CategoryWithProducts[] = (categories || []).map(cat => ({
    id: cat.id,
    name: cat.name,
    display_order: cat.display_order,
    products: (products || [])
      .filter(p => p.category_id === cat.id)
      .map(p => ({
        ...p,
        category_name: cat.name
      }))
  }))

  return { catalog, isLoading }
}