// Bundle the Structured Text engine into one self-contained IIFE for embedding in a host JS runtime
// (QuickJS / JS-in-WASM in a native host extension). Output: dist-embedded/oip-plc.js, which assigns the
// flat FFI API to globalThis.OipPlc. See src/plc/embeddedPlc.ts.
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    lib: {
      entry: resolve(root, 'src/plc/embeddedPlc.ts'),
      formats: ['iife'],
      name: 'OipPlcBundle',
      fileName: () => 'oip-plc.js',
    },
    outDir: resolve(root, 'dist-embedded'),
    minify: false,
    emptyOutDir: true,
  },
})

console.log('built dist-embedded/oip-plc.js')
