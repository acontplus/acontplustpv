// =============================================================================
// apps/api/src/lib/bcrypt.ts
// Hash y verificación del PIN de usuario usando bcrypt
//
// Decisión arquitectónica (§Autenticación):
//   El PIN viaja en texto claro por HTTPS y se hashea en el servidor.
//   El cliente nunca implementa bcrypt — simplifica la app móvil y garantiza
//   que el algoritmo de hash sea consistente en todos los clientes.
// =============================================================================

import bcrypt from 'bcrypt'

const SALT_ROUNDS = 10

/**
 * Genera el hash bcrypt de un PIN de 4 dígitos.
 * Usar al crear o actualizar el PIN de un usuario.
 */
export async function hashPin(pin: string): Promise<string> {
  if (!/^\d{4}$/.test(pin)) {
    throw new Error('El PIN debe ser exactamente 4 dígitos numéricos')
  }
  return bcrypt.hash(pin, SALT_ROUNDS)
}

/**
 * Verifica un PIN contra su hash almacenado.
 * Devuelve true si coincide, false si no.
 * Nunca lanza error por mismatch — solo por errores internos de bcrypt.
 */
export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash)
}
