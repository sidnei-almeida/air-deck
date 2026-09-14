import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Dev only: receives diagnostics from src/lib/debug.ts and appends them to debug/session.jsonl. */
function debugLogPlugin(): Plugin {
  return {
    name: 'airdeck-debug-log',
    apply: 'serve',
    configureServer(server) {
      const dir = resolve(server.config.root, 'debug')
      mkdirSync(dir, { recursive: true })
      const file = resolve(dir, 'session.jsonl')
      server.middlewares.use('/__airdeck/log', (req, res) => {
        let body = ''
        req.on('data', chunk => (body += chunk))
        req.on('end', () => {
          const at = new Date().toISOString()
          const lines = body
            .split('\n')
            .filter(line => line.startsWith('{"'))
            .map(line => `{"at":"${at}",${line.slice(1)}`)
          if (lines.length) appendFileSync(file, lines.join('\n') + '\n')
          res.statusCode = 204
          res.end()
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), debugLogPlugin()],
  // The hand tracking worker loads MediaPipe's ES module build.
  worker: { format: 'es' },
})
