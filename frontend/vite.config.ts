import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    // Forward all worker route groups in local dev
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/open_api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/auth': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/user_api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/admin_api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      },
      '/telegram_api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
