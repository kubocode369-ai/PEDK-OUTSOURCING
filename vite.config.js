import { defineConfig } from 'vite'
import path from 'path'

// Mínima a propósito, igual que la del agente de CloudPrint: JavaScript plano contra
// la API global `pedk` del firmware. `pedk-build` toma dist/ y arma el TAR.
export default defineConfig({
  assetsInclude: ['**/*.bmp'],
  build: {
    // Sin minificar: en el equipo el único diagnóstico es la consola.
    minify: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/app.js'),
      output: {
        entryFileNames: 'app.js',
        assetFileNames: 'resources/media/[name]-[hash][extname]',
      },
    },
  },
})
