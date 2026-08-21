import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              // ws's buffer-util.js does a try/catch require('bufferutil')
              // (an optional native perf addon we don't install) -- Vite's
              // bundler resolves that eagerly and fails since it's not
              // present, even though ws handles its absence fine at
              // runtime. Same treatment as node-pty/electron-store: load
              // the real module from node_modules instead of bundling it.
              external: ['electron', 'node-pty', 'electron-store', 'ws']
            }
          }
        }
      },
      {
        entry: 'src/preload/index.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload'
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@preload': resolve(__dirname, 'src/preload')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
