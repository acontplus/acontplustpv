import { Role, DeviceRole } from '@prisma/client'

export interface AccessTokenPayload {
  sub: string
  tenantId: string
  establishmentId: string
  roles: Role[]
  type?: 'access'
}

export interface RefreshTokenPayload {
  sub: string
  tenantId: string
  type?: 'refresh'
}

export interface DeviceTokenPayload {
  sub: string
}

export interface AuthContext {
  tenantId: string
  establishmentId: string
  userId?: string
  deviceId?: string
  roles: Role[]
  deviceRole?: DeviceRole
}

export interface LoginResponse {
  accessToken: string
  refreshToken: string
  user: {
    id: string
    name: string
    roles: Role[]
    tenantId: string
    establishmentId: string
  }
}

export interface RefreshResponse {
  accessToken: string
}

export interface GenerateDeviceTokenResponse {
  token: string
  deviceId: string
  expiresAt: Date
}