import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * A VITE_ token is compiled into the JavaScript that every visitor downloads.
 * Warn loudly when a production build is about to carry one.
 * See docs/SECURITY.md.
 */
function warnOnBakedToken(): Plugin {
  return {
    name: 'ringwheel-warn-on-baked-token',
    apply: 'build',
    configResolved(config) {
      const token = config.env.VITE_RINGWHEEL_API_TOKEN || config.env.VITE_SPIN_API_TOKEN
      if (token && !/your-api-token-here/.test(token)) {
        config.logger.warn(
          '\nWARNING: this build contains the Ringwheel API token.\n' +
            'Anyone who can open the built site can read it, and with it the class roster.\n' +
            'Only use this build on your own machine. For a hosted copy, build without the token\n' +
            'and enter it on the Admin page instead. See docs/SECURITY.md.\n'
        )
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), warnOnBakedToken()],
  test: {
    // Unit and contract tests. Browser tests live in e2e/ and run with `npm run test:e2e`.
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
