# acontplusTPV-mobile — Sprint 1: Fundamentos

App móvil Offline-First para sistema de Punto de Venta gastronómico.
React Native + Expo Dev Build + PowerSync + tRPC.

## Estructura de carpetas

```
acontplusTPV-mobile/
├── app/                          # Expo Router (file-system routing)
│   ├── _layout.tsx               # Root layout: providers + auth guard
│   ├── (auth)/
│   │   └── login.tsx             # → src/screens/LoginScreen.tsx
│   └── (app)/
│       ├── _layout.tsx           # Bottom tabs (autenticado)
│       ├── index.tsx             # Pantalla principal (mesas/pedidos)
│       └── profile.tsx           # Perfil y logout
│
├── src/
│   ├── lib/
│   │   ├── powersync.ts          # ← SPRINT 1: Schema SQLite + connector
│   │   └── trpc.ts               # ← SPRINT 1: Cliente tRPC + refresh
│   │
│   ├── store/
│   │   └── auth.ts               # ← SPRINT 1: Login + kill switch
│   │
│   ├── screens/
│   │   └── LoginScreen.tsx       # ← SPRINT 1: UI de login con PIN
│   │
│   ├── components/               # Componentes reutilizables (Sprint 2+)
│   ├── hooks/                    # Custom hooks (Sprint 2+)
│   └── types/
│       └── router.ts             # ← SPRINT 1: Tipo AppRouter del backend
│
├── assets/                       # Íconos, splash, fonts
├── app.config.ts                 # ← SPRINT 1: Config Expo + plugins nativos
├── package.json                  # ← SPRINT 1: Dependencias
├── tsconfig.json
└── tailwind.config.js            # Config NativeWind
```

## Setup inicial

```bash
# 1. Instalar dependencias
npm install

# 2. Crear archivo de entorno
echo 'API_URL=https://api.tudominio.com
POWERSYNC_URL=https://powersync.tudominio.com' > .env

# 3. Prebuild (genera android/ e ios/ nativos)
npx expo prebuild --clean

# 4. Correr en Android
npm run android

# 5. Correr en iOS
npm run ios
```

## Variables de entorno

```
API_URL=https://api.tudominio.com
POWERSYNC_URL=https://powersync.tudominio.com
EAS_PROJECT_ID=tu-project-id-de-eas
```

## Pendiente Sprint 2

- `app/_layout.tsx` — Root layout con providers (PowerSync, tRPC, QueryClient)
- `app/(auth)/login.tsx` — Conectar LoginScreen con Expo Router
- `app/(app)/_layout.tsx` — Bottom tabs + guard de autenticación
- `src/screens/TablesScreen.tsx` — Listado de mesas con estado de pedidos
- `src/screens/NewOrderScreen.tsx` — Crear pedido offline
- `tailwind.config.js` — Configuración NativeWind
