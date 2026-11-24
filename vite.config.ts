import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * RingWheel reads no build-time environment variables. A backend address or
 * token set as a VITE_ variable is therefore never compiled into the site.
 * This notice tells whoever is building that such a variable is being ignored,
 * and where the connection is configured instead. See docs/SECURITY.md.
 */
function noticeOnUnusedConnectionEnv(): Plugin {
  return {
    name: 'ringwheel-notice-on-unused-connection-env',
    configResolved(config) {
      const unused = ['VITE_SPIN_API_URL', 'VITE_RINGWHEEL_API_TOKEN', 'VITE_SPIN_API_TOKEN'].filter((name) => config.env[name])
      if (unused.length > 0) {
        config.logger.warn(
          `\nNOTICE: ${unused.join(', ')} is set but RingWheel no longer reads it.\n` +
            'Nothing from it is included in the site. To use your Google Sheet, open the Admin page\n' +
            'and enter the backend address and token under "Where data is kept". See docs/SECURITY.md.\n'
        )
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), noticeOnUnusedConnectionEnv()],
  test: {
    // Unit and contract tests. Browser tests live in e2e/ and run with `npm run test:e2e`.
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
