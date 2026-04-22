module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      // jsxImportSource: "nativewind" activa el soporte de className
      // en componentes React Native sin necesidad de import explícito
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    // NOTA: react-native-reanimated/plugin se añade aquí cuando se
    // incorporen animaciones a la app. Requiere react-native-worklets
    // instalado. Por ahora no se usa Reanimated en ninguna pantalla.
    plugins: [],
  }
}
