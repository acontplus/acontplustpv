module.exports = function (api) {
  api.cache(true)
  return {
    presets: [
      // jsxImportSource: "nativewind" activa el soporte de className
      // en componentes React Native sin necesidad de import explícito
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
    plugins: [
      // react-native-reanimated debe ir SIEMPRE al final
      "react-native-reanimated/plugin",
    ],
  }
}
