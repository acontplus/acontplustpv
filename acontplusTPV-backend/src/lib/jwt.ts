// =============================================================================
// apps/api/src/lib/jwt.ts
// Firma y verificación de tokens JWT y DeviceToken
// =============================================================================

import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import {
  AccessTokenPayload,
  RefreshTokenPayload,
  DeviceTokenPayload,
} from '../types/auth'

// ---------------------------------------------------------------------------
// Variables de entorno requeridas (validadas al arrancar el servidor)
// ---------------------------------------------------------------------------
const ACCESS_TOKEN_SECRET  = process.env.JWT_SECRET!
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET!
const ACCESS_TOKEN_TTL     = '1h'
const REFRESH_TOKEN_TTL    = '7d'

if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error(
    'JWT_SECRET y JWT_REFRESH_SECRET deben estar definidos en las variables de entorno',
  )
}

// ---------------------------------------------------------------------------
// Access Token (vida: 1h)
// Instrucciones §2: JWT de vida corta para WAITER_DEVICE y ADMIN_DEVICE
// ---------------------------------------------------------------------------
export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): string {
  return jwt.sign(
    { ...payload, type: 'access' } satisfies AccessTokenPayload,
    ACCESS_TOKEN_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL },
  )
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, ACCESS_TOKEN_SECRET) as AccessTokenPayload
  if (payload.type !== 'access') {
    throw new Error('Token type inválido: se esperaba access')
  }
  return payload
}

// ---------------------------------------------------------------------------
// Refresh Token (vida: 7d)
// Se guarda como hash en User.refreshTokenHash para permitir revocación
// ---------------------------------------------------------------------------
export function signRefreshToken(
  payload: Omit<RefreshTokenPayload, 'type'>,
): string {
  return jwt.sign(
    { ...payload, type: 'refresh' } satisfies RefreshTokenPayload,
    REFRESH_TOKEN_SECRET,
    { expiresIn: REFRESH_TOKEN_TTL },
  )
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, REFRESH_TOKEN_SECRET) as RefreshTokenPayload
  if (payload.type !== 'refresh') {
    throw new Error('Token type inválido: se esperaba refresh')
  }
  return payload
}

// ---------------------------------------------------------------------------
// Device Token — token opaco de 30 días para PRINT_NODE y KIOSK_DEVICE
// Instrucciones §2: DeviceToken de larga duración, hash almacenado
// ---------------------------------------------------------------------------

/**
 * Genera un token opaco de 48 bytes (96 caracteres hex).
 * El texto claro se devuelve UNA sola vez al admin.
 * En la base de datos solo se guarda el hash SHA-256.
 */
export function generateDeviceToken(): { plain: string; hash: string } {
  const plain = crypto.randomBytes(48).toString('hex')
  const hash  = hashDeviceToken(plain)
  return { plain, hash }
}

export function hashDeviceToken(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex')
}

// ---------------------------------------------------------------------------
// Utilidades de tiempo
// ---------------------------------------------------------------------------
export function deviceTokenExpiresAt(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 30)
  return d
}
