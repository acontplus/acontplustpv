# =============================================================================
# Dockerfile — acontplusTPV-backend
#
# Estrategia: multi-stage con tsx como runtime de producción.
# El proyecto no tiene script "build" ni outDir configurado en tsconfig.json —
# ejecuta TypeScript directamente con tsx (igual que en desarrollo).
# tsx usa esbuild internamente: arranque rápido, sin paso de compilación.
#
# Stage 1 (deps):   instala solo dependencias de producción
# Stage 2 (runner): imagen final mínima lista para producción
# =============================================================================

# ── Stage 1: dependencias ────────────────────────────────────────────────────
FROM node:22-alpine AS deps

# bcrypt necesita compilación nativa (node-gyp)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copiar manifiestos primero para aprovechar la caché de capas de Docker.
# Si package.json no cambia, npm ci no se vuelve a ejecutar en rebuilds.
COPY package.json package-lock.json ./

# Instalar TODAS las dependencias (incluyendo devDeps que tsx necesita).
# tsx y esbuild son devDependencies pero son el runtime de producción aquí.
RUN npm ci --ignore-scripts

# Reinstalar bcrypt con compilación nativa para la arquitectura del contenedor
RUN npm rebuild bcrypt --build-from-source


# ── Stage 2: runner ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Dependencias de sistema mínimas para bcrypt en runtime
RUN apk add --no-cache libstdc++

# Usuario no-root para reducir superficie de ataque
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 fastify

WORKDIR /app

# Copiar dependencias compiladas desde stage anterior
COPY --from=deps /app/node_modules ./node_modules

# Copiar el código fuente y archivos de configuración necesarios en runtime
COPY src/        ./src/
COPY prisma/     ./prisma/
COPY package.json tsconfig.json ./

# Cambiar propietario al usuario no-root
RUN chown -R fastify:nodejs /app

USER fastify

# Puerto que expone el servidor Fastify (configurable via API_PORT en .env)
EXPOSE 3000

# Health check: verifica que el servidor responda antes de declararlo "healthy"
# --interval: cada 30s  --timeout: falla si no responde en 10s
# --start-period: esperar 15s antes del primer check (tiempo de arranque)
# --retries: 3 fallos consecutivos = unhealthy
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Generar cliente Prisma y arrancar con tsx
# prisma generate se ejecuta al iniciar para garantizar que el cliente
# esté sincronizado con el schema en cada deploy, sin necesidad de
# un paso de build separado.
CMD ["sh", "-c", "npx prisma generate && npx tsx src/server.ts"]
