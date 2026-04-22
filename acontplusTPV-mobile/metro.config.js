const { getDefaultConfig } = require("expo/metro-config")
const { withNativeWind } = require("nativewind/metro")

const config = getDefaultConfig(__dirname)

// withNativeWind conecta el compilador de Tailwind al bundler de Metro.
// Cualquier clase className que uses en el código pasa por aquí
// y se transforma en StyleSheet de React Native en tiempo de build.
module.exports = withNativeWind(config, { input: "./global.css" })
