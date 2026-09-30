import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

/**
 * La clave de Soprint para restablecer el PIN de admin (src/rescate.js). NO va al
 * repositorio (*.key está en .gitignore): se crea UNA vez con
 *   node herramientas/codigo-pin-admin.mjs --nueva-clave
 * y hay que guardarla aparte. Si se pierde, los equipos ya instalados no se pueden
 * restablecer. Sin ella no se compila: un paquete sin restablecimiento no sale.
 */
function claveRescate() {
  const f = path.resolve(__dirname, 'sign/rescate.key')
  if (!fs.existsSync(f)) {
    throw new Error('Falta sign/rescate.key (la clave para restablecer el PIN de admin). '
      + 'Cópiela de la copia guardada, o si es la primera vez: node herramientas/codigo-pin-admin.mjs --nueva-clave')
  }
  const k = fs.readFileSync(f, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(k)) {
    throw new Error('sign/rescate.key no tiene el formato esperado (64 caracteres hexadecimales)')
  }
  return k
}

// Mínima a propósito, igual que la del agente de CloudPrint: JavaScript plano contra
// la API global `pedk` del firmware. `pedk-build` toma dist/ y arma el TAR.
export default defineConfig(({ command }) => ({
  assetsInclude: ['**/*.bmp'],
  define: command === 'build' ? { __CLAVE_RESCATE__: JSON.stringify(claveRescate()) } : {},
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
}))
