module.exports = {
  name: "acontplusTPV",
  slug: "acontplustpv",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.acontplus.tpv"
  },
  android: {
    package: "com.acontplus.tpv",
    permissions: [
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.INTERNET"
    ]
  },
  extra: {
    apiUrl: "https://api.tudominio.com",
    powerSyncUrl: "https://powersync.tudominio.com"
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-splash-screen",
    "react-native-reanimated/plugin",
    "@powersync/react-native",
    ["react-native-quick-crypto", { "enableAutoReplace": true }]
  ],
  scheme: "acontplustpv"
}
