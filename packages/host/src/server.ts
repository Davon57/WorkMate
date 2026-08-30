/**
 * Agent Console - Host 服务入口
 *
 * 启动 Express 服务器，提供 REST API。
 */

import { createGateway } from './gateway.js'

const PORT = process.env.PORT ?? 3800

const app = createGateway()

app.listen(PORT, () => {
  console.log('')
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║   Agent Console - Host Server                ║')
  console.log('╠══════════════════════════════════════════════')
  console.log(`║   API:  http://localhost:${PORT}                  ║`)
  console.log('║                                              ║')
  console.log('║   前端: npm run dev:client (Vite)            ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log('')
})
