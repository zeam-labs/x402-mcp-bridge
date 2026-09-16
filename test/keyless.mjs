//   PRISM_TEST_URL=https://mcp.zeamprism.com node test/keyless.mjs
//
// A stock MCP client adds this bridge before it has a wallet. It must see the
// catalog and be able to call the free tools; a paid call must come back as the
// server's quote, not as silence. Glama's sandbox is such a client.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const url = process.env.PRISM_TEST_URL ?? 'https://mcp.zeamprism.com'
const env = { ...process.env, X402_MCP_URL: `${url}/mcp` }
delete env.X402_PRIVATE_KEY; delete env.PRISM_PRIVATE_KEY; delete env.X402_STATE_DIR

const rpc = (child, msgs) => new Promise((resolve, reject) => {
  const out = []; let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (line.trim()) { try { out.push(JSON.parse(line)) } catch {} }
      if (out.length >= msgs.filter(m => m.id !== undefined).length) resolve(out)
    }
  })
  child.on('exit', (code) => reject(new Error(`bridge exited ${code} before answering`)))
  setTimeout(() => reject(new Error('no answer in 25s')), 25_000)
  for (const m of msgs) child.stdin.write(JSON.stringify(m) + '\n')
})

const child = spawn(process.execPath, [join(here, '..', 'index.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
let stderr = ''; child.stderr.on('data', (d) => { stderr += d })

let n = 0
const step = (name, ok, note = '') => { n++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`); if (!ok) { console.error(stderr); process.exit(1) } }

try {
  const [init, tools, sample, paid] = await rpc(child, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'keyless-probe', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sample', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rpc', arguments: { chain: 'base', method: 'eth_blockNumber', params: [] } } },
  ])
  step('the bridge starts with no key', !!init?.result, init?.result?.serverInfo?.name)
  const names = (tools?.result?.tools ?? []).map(t => t.name)
  step('and serves the catalog', names.length >= 10, names.join(' '))
  const s = JSON.parse(sample?.result?.content?.[0]?.text ?? '{}')
  step('a free tool answers', !sample?.result?.isError && s.rpc_response !== undefined, `chain ${s.chain}`)
  const q = JSON.parse(paid?.result?.content?.[0]?.text ?? '{}')
  step('a paid call comes back as the quote, not silence', paid?.result?.isError === true && Array.isArray(q.accepts) && q.accepts.length > 0, `${q.accepts?.length} accepts`)
  step('and the quote carries what to hand a human', typeof q.for_your_human === 'string' && /refused rpc\./.test(q.for_your_human))
  assert.ok(/no key/i.test(stderr), 'stderr says it is running without a key')
  step('stderr says so, once, without exiting', true)
  console.log(`\n  keyless: ${n} passed`)
  child.kill()
  process.exit(0)
} catch (e) {
  console.error(`  FAIL  ${e.message}`); console.error(stderr); child.kill(); process.exit(1)
}
