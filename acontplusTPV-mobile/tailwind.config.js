/** @type {import('tailwindcss').Config} */
module.exports = {
  // Escanear todos los archivos de la app y src para detectar clases usadas
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  // Preset de NativeWind — reemplaza los valores por defecto de Tailwind
  // con equivalentes para React Native (unidades, colores, etc.)
  presets: [require("nativewind/preset")],
  theme: {
    extend: {},
  },
  plugins: [],
}
