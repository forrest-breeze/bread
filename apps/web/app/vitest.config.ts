import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: [
        'src/lib/github/**',
        'src/app/api/github/**',
        'src/lib/ingest/**',
        'src/lib/synthesis/**',
        'src/app/api/topics/**',
        'src/app/api/workflows/**',
        'src/lib/api/workflows.ts',
        'src/lib/billing/catalog.ts',
        'src/lib/billing/model-costs.ts',
        'src/lib/db/workspace.ts',
        'src/lib/document-nav-preferences.ts',
        'src/lib/settings-catalog.ts',
        'src/lib/settings-search.ts',
        'src/lib/settings-search-server.ts',
        'src/lib/text-diff.ts',
        'src/lib/utils.ts',
        'src/lib/workspace-settings.ts',
      ],
      exclude: [
        'src/lib/github/api/**',
        'src/test/**',
        '**/*.test.*',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
})
