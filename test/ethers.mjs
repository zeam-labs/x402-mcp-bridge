// Drive the ethers provider against a live Prism. Spends real money from the key.
//
//   PRISM_TEST_URL=https://mcp.zeamprism.com X402_PRIVATE_KEY=0x... node test/ethers.mjs
import { Contract, id } from 'ethers'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrismProvider } from '../ethers.mjs'

const url = process.env.PRISM_TEST_URL ?? 'https://mcp.zeamprism.com'
const key = process.env.X402_PRIVATE_KEY
if (!key) { console.error('set X402_PRIVATE_KEY'); process.exit(2) }
let pass = 0, fail = 0
const is = (c, n, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const ms = async (fn) => { const t = Date.now(); const v = await fn(); return [v, Date.now() - t] }

const stateDir = process.env.PRISM_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'prism-ethers-'))
const provider = new PrismProvider({ url, key, chain: 'base', stateDir, log: (...a) => console.error('   ', ...a) })

console.log('\nfirst calls fund the channel, detect the network, and buy a block')
const [net, t0] = await ms(() => provider.getNetwork())
is(net.chainId === 8453n, 'ethers detects Base through the door', `chainId ${net.chainId} in ${t0}ms`)
const [n1, t1] = await ms(() => provider.getBlockNumber())
is(Number.isInteger(n1) && n1 > 0, 'getBlockNumber answers', `${n1} in ${t1}ms`)
is(Boolean(provider.state().channelId), 'a channel exists now', provider.state().channelId?.slice(0, 14))

console.log('\ncalls that keep coming ride a line, and ethers batches them')
const [many, tb] = await ms(() => Promise.all(Array.from({ length: 8 }, () => provider.getBlockNumber())))
is(many.every((n) => n >= n1), 'eight concurrent calls in one batch answer', `${tb}ms for the batch`)
const st = provider.state()
is(st.line && st.metering, 'a line is open and the meter is on', JSON.stringify(st))

console.log('\nthe archive answers a real read')
const usdc = new Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ['event Transfer(address indexed from, address indexed to, uint256 value)', 'function totalSupply() view returns (uint256)'], provider)
const [supply] = await ms(() => usdc.totalSupply())
is(supply > 0n, 'USDC totalSupply via eth_call', `${supply}`)
const head = await provider.getBlockNumber()
const [logs, tl] = await ms(() => provider.getLogs({ address: usdc.target, topics: [id('Transfer(address,address,uint256)')], fromBlock: head - 50, toBlock: head }))
is(logs.length > 0, 'USDC transfers over 50 blocks', `${logs.length} logs in ${tl}ms`)

console.log('\nthe meter goes off when calls stop, and on again when they resume')
await new Promise((r) => setTimeout(r, 1800))
const idle = provider.state()
is(idle.line && !idle.metering, 'idle: line held, meter off', JSON.stringify(idle))
const before = idle.msRemaining
await new Promise((r) => setTimeout(r, 1000))
is(Math.abs(provider.state().msRemaining - before) <= 5, 'a second off burned nothing', `${before} -> ${provider.state().msRemaining}`)
const [n2] = await ms(() => provider.getBlockNumber())
is(n2 >= n1 && provider.state().metering, 'the next call switches the meter on and answers', `${n2}`)

console.log('\nrefund')
const r = await provider.refund()
is(r.op === 'refunded', 'the collateral and the unburned time come back', r.op === 'refunded' ? `${r.microUSD} micro-USD ${String(r.transaction).slice(0, 14)}` : (r.why ?? r.error))
provider.destroy()
console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
