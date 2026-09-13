import { parentPort, workerData } from 'node:worker_threads'
import { BlackBoxStore } from './blackBoxStore'

const store = new BlackBoxStore(workerData.dir, workerData.run)
const attempt = (work: () => void) => { try { work() } catch { parentPort?.postMessage({ type: 'io-failed' }) } }
attempt(() => store.start())
let lastHeartbeat = Date.now()
let delayed = false
const timer = setInterval(() => {
  if (Date.now() - lastHeartbeat > 15_000 && !delayed) {
    delayed = true
    attempt(() => store.write('main-heartbeat-delayed', { lag_ms: Date.now() - lastHeartbeat }))
  }
}, 5_000)
parentPort?.on('message', message => {
  if (message.type === 'record') {
    attempt(() => store.write(message.event, message.details, message.at))
    parentPort?.postMessage({ type: 'ack' })
  } else if (message.type === 'heartbeat') {
    lastHeartbeat = Date.now()
    if (delayed) attempt(() => store.write('main-heartbeat-restored', {}))
    delayed = false
    attempt(() => store.checkpoint(false))
  } else if (message.type === 'close') {
    clearInterval(timer)
    attempt(() => { store.write('session-clean-close', {}); store.checkpoint(true) })
    parentPort?.postMessage({ type: 'closed' })
    parentPort?.close()
  }
})
