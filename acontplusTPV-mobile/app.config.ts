// =============================================================================
// app.config.ts — Expo Application Configuration
// acontplusTPV-mobile
//
// Dev Build requerido (NO Expo Go) porque usamos:
//   - @powersync/react-native: módulo nativo de SQLite (op-sqlite)
//   - react-native-quick-crypto: crypto nativo para PowerSync
//   - expo-secure-store: Keychain/Keystore para tokens JWT
// =============================================================================

import type { ExpoConfig, ConfigContext } from 'expo/config'

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name:        'acontplusTPV',
  slug:        'acontplustpv',
  version:     '1.0.0',
  orientation: 'portrait',
  icon:        './assets/icon.png',
  userInterfaceStyle: 'light',

  // ── Splash screen ──────────────────────────────────────────────────────────
  splash: {
    image:           './assets/splash.png',
    resizeMode:      'contain',
    backgroundColor: '#1e293b',
  },

  // ── Assets ─────────────────────────────────────────────────────────────────
  assetBundlePatterns: ['**/*'],

  // ── iOS ────────────────────────────────────────────────────────────────────
  ios: {
    supportsTablet:          true,
    bundleIdentifier:        'com.acontplus.tpv',
    // Face ID / Touch ID para SecureStore
    usesAppleSignIn:         false,
    infoPlist: {
      NSFaceIDUsageDescription: 'Usamos Face ID para proteger el acceso al sistema de caja.',
    },
  },

  // ── Android ────────────────────────────────────────────────────────────────
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#1e293b',
    },
    package:     'com.acontplus.tpv',
    permissions: [
      // Necesario para que la app detecte reconexión y sincronice
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.INTERNET',
    ],
  },

  // ── Web (no usado — solo por completitud) ──────────────────────────────────
  web: {
    favicon: './assets/favicon.png',
  },

  // ── Extra: variables de entorno en tiempo de build ─────────────────────────
  // En producción estas las define EAS (eas.json environment variables)
  // En desarrollo las toma de .env local
  extra: {
    apiUrl:        process.env.API_URL         ?? 'https://api.tudominio.com',
    powerSyncUrl:  process.env.POWERSYNC_URL   ?? 'https://powersync.tudominio.com',
    eas: {
      projectId: process.env.EAS_PROJECT_ID ?? 'REEMPLAZAR_CON_EAS_PROJECT_ID',
    },
  },

  // ── Plugins de Expo ─────────────────────────────────────────────────────────
  plugins: [
    // expo-router: file-system routing (reemplaza @react-navigation en config)
    'expo-router',

    // expo-secure-store: almacenamiento seguro de tokens (Keychain en iOS, Keystore en Android)
    'expo-secure-store',

    // expo-splash-screen: control programático del splash screen
    'expo-splash-screen',

    // react-native-quick-crypto: crypto nativo requerido por PowerSync para TLS
    [
      'react-native-quick-crypto',
      {
        // Reemplaza el módulo crypto de Node.js con la implementación nativa
        enableAutoReplace: true,
      },
    ],
  ],

  // ── Scheme para deep linking ────────────────────────────────────────────────
  // Permite abrir la app con: acontplustpv://...
  scheme: 'acontplustpv',
})