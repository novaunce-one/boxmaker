import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Tests target the pure `core/` geometry + image-processing modules (no UI).
export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/renderer/src/core'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts']
  }
})
