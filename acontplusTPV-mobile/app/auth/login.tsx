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
//   LoginScreen NO llama a router.replace() cuando el login es exitoso.
//   Solo actualiza el store de Zustand (isAuthenticated → true).
//   El Guard en app/(app)/_layout.tsx detecta el cambio y hace el redirect.
//   Este patrón evita el problema de sesión restaurada desde SecureStore:
//   en ese flujo el usuario nunca pasa por esta pantalla, pero el Guard
//   siempre se ejecuta.
// =============================================================================

import LoginScreen from '../../src/screens/LoginScreen'

export default LoginScreen
