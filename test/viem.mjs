// Drive the viem transport against a live Prism. Spends real money from the key.
//
//   PRISM_TEST_URL=https://mcp.zeamprism.com X402_PRIVATE_KEY=0x... node test/viem.mjs
import { createPublicClient, parseAbiItem } from 'viem'
import { base } from 'viem/chains'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prism } from '../viem.mjs'

const url = process.env.PRISM_TEST_URL ?? 'https://mcp.zeamprism.com'
const key = process.env.X402_PRIVATE_KEY
if (!key) { console.error('set X402_PRIVATE_KEY'); process.exit(2) }
let pass = 0, fail = 0
const is = (c, n, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const ms = async (fn) => { const t = Date.now(); const v = await fn(); return [v, Date.now() - t] }

const stateDir = process.env.PRISM_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'prism-viem-'))
const transport = prism({ url, key, chain: 'base', stateDir, log: (...a) => console.error('   ', ...a) })
const client = createPublicClient({ chain: base, transport })

console.log('\nfirst call funds the channel and buys a block')
const [n1, t1] = await ms(() => client.getBlockNumber())
is(typeof n1 === 'bigint' && n1 > 0n, 'getBlockNumber answers through the door', `${n1} in ${t1}ms`)
is(Boolean(transport.state().channelId), 'a channel exists now', transport.state().channelId?.slice(0, 14))

console.log('\ncalls that keep coming ride a line')
const times = []
for (let i = 0; i < 10; i++) { const [, t] = await ms(() => client.getChainId()); times.push(t) }
const st = transport.state()
is(st.line && st.metering, 'a line is open and the meter is on', JSON.stringify(st))
is(times.slice(2).every((t) => t < 1500), 'ten calls answered', `${times.join(' ')} ms`)

console.log('\nthe archive answers a real read')
const head = await client.getBlockNumber()
const [logs, tl] = await ms(() => client.getLogs({
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  fromBlock: head - 50n, toBlock: head }))
is(Array.isArray(logs) && logs.length > 0, 'USDC transfers over 50 blocks', `${logs.length} logs in ${tl}ms`)
const [bal] = await ms(() => client.getBalance({ address: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003' }))
is(typeof bal === 'bigint', 'getBalance on the escrow', `${bal} wei`)

console.log('\nthe meter goes off when calls stop, and on again when they resume')
await new Promise((r) => setTimeout(r, 1800))
const idle = transport.state()
is(idle.line && !idle.metering, 'idle: line held, meter off', JSON.stringify(idle))
const before = idle.msRemaining
await new Promise((r) => setTimeout(r, 1000))
is(Math.abs(transport.state().msRemaining - before) <= 5, 'a second off burned nothing', `${before} -> ${transport.state().msRemaining}`)
const [n2] = await ms(() => client.getBlockNumber())
is(n2 >= n1 && transport.state().metering, 'the next call switches the meter on and answers', `${n2}`)

console.log('\nrefund')
const r = await transport.refund()
is(r.op === 'refunded', 'the collateral and the unburned time come back', r.op === 'refunded' ? `${r.microUSD} micro-USD ${String(r.transaction).slice(0, 14)}` : (r.why ?? r.error))

console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
