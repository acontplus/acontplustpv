// =============================================================================
// app/(auth)/login.tsx
// Ruta de login — archivo de ruta thin (thin route file)
//
// Este archivo solo registra la ruta "/(auth)/login" en Expo Router
// e importa el componente de pantalla real desde src/screens/.
//
// Separación intencionada:
//   - app/(auth)/login.tsx  → contrato de ruta (Expo Router)
//   - src/screens/LoginScreen.tsx → lógica y UI de la pantalla
//
// Esta separación permite que LoginScreen sea reutilizable e importable
// en tests unitarios sin depender del contexto de Expo Router.
//
// IMPORTANTE — sobre la navegación post-login:
//   LoginScreen llama a router.replace('/(app)') tras login exitoso para
//   navegación inmediata. Además, el Root Layout en app/_layout.tsx observa
//   isAuthenticated y redirige de forma reactiva como respaldo.
//   Esta combinación cubre tanto el login interactivo como la restauración
//   de sesión desde SecureStore al arrancar la app.
// =============================================================================

import LoginScreen from '../../src/screens/LoginScreen'

export default LoginScreen
