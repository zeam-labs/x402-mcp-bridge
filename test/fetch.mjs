import assert from 'node:assert/strict'
import http from 'node:http'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http as rpc } from 'viem'
import { base } from 'viem/chains'
import { makeFetchTool } from '../fetch.mjs'

const encodePaymentRequiredHeader = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
const decodePaymentSignatureHeader = (h) => JSON.parse(Buffer.from(h, 'base64').toString('utf8'))
const account = privateKeyToAccount('0x' + '11'.repeat(32))
const pub = createPublicClient({ chain: base, transport: rpc('http://127.0.0.1:1') })
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const req = (amount, asset = USDC) => ({ scheme: 'exact', network: 'eip155:8453', asset, amount, payTo: '0x000000000000000000000000000000000000dEaD', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } })

const seen = []
const server = http.createServer((q, r) => {
  const price = { '/free': null, '/zero': '0', '/cheap': '2500', '/dear': '9000000', '/weth': '1000' }[q.url.split('?')[0]]
  const sig = q.headers['payment-signature']
  if (price === null) return r.end(JSON.stringify({ free: true }))
  if (sig) { seen.push(decodePaymentSignatureHeader(sig)); return r.end(JSON.stringify({ served: q.url })) }
  const body = { x402Version: 2, resource: { url: `http://x${q.url}` }, accepts: [req(price, q.url === '/weth' ? WETH : USDC)] }
  r.writeHead(402, { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body), 'content-type': 'application/json' }).end(JSON.stringify(body))
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const base_ = `http://127.0.0.1:${server.address().port}`

let spent = 0
const tool = makeFetchTool({ signer: account, pub, network: 'eip155:8453', budget: { allows: (u) => spent + u <= 10_000, spend: (u) => { spent += u } } })
const call = async (a) => { const r = await tool(a); return { isError: Boolean(r.isError), ...JSON.parse(r.content[0].text) } }
let n = 0; const ok = (name, cond) => { n++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); assert.ok(cond, name) }

const free = await call({ url: `${base_}/free` })
ok('a URL that does not ask for payment is fetched and nothing is paid', free.status === 200 && !free.paid && free.body.free === true)
const quote = await call({ url: `${base_}/cheap`, pay: false })
ok('pay:false returns the terms and pays nothing', quote.status === 402 && !quote.paid && quote.accepts[0].amount === '2500' && seen.length === 0)
const zero = await call({ url: `${base_}/zero` })
ok('a payment of zero is signed, admits, and counts as not paid', zero.ok && !zero.paid && zero.body.served === '/zero' && seen.length === 1 && spent === 0)
ok('the signature is for the zero requirement, from this key', seen[0].accepted.amount === '0' && seen[0].payload.authorization.from.toLowerCase() === account.address.toLowerCase())
const cheap = await call({ url: `${base_}/cheap`, body: { q: 1 } })
ok('a priced URL is paid once and counted against the cap', cheap.ok && cheap.paid && cheap.amount === '2500' && spent === 2500)
const over = await call({ url: `${base_}/cheap`, maxAmount: '100' })
ok('maxAmount refuses a quote above it, before signing', over.isError && over.error === 'over_max' && seen.length === 2)
const dear = await call({ url: `${base_}/dear` })
ok('a payment that would pass X402_MAX_SPEND is refused', dear.isError && dear.error === 'x402_bridge_spend_cap_reached' && seen.length === 2)
const weth = await call({ url: `${base_}/weth` })
ok('a quote in an asset the cap cannot value needs maxAmount', weth.isError && weth.error === 'max_required')
const bad = await call({ url: 'file:///etc/passwd' })
ok('only http and https', bad.isError && bad.error === 'bad_url')
const granted = makeFetchTool({ signer: account, pub, network: 'eip155:8453', grant: 'g-1' })
let grantSeen = null
const gsrv = http.createServer((q, r) => { grantSeen = q.headers['x-grant'] ?? null; r.end('{}') })
await new Promise((ok) => gsrv.listen(0, '127.0.0.1', ok))
await granted({ url: `http://127.0.0.1:${gsrv.address().port}/` })
gsrv.close()
ok('X402_GRANT rides as x-grant', grantSeen === 'g-1')
const keyless = await makeFetchTool({ signer: null, pub, network: 'eip155:8453' })({ url: `${base_}/cheap` })
ok('with no key, the terms come back with what a key would need', JSON.parse(keyless.content[0].text).error === 'no_key')

server.close()
console.log(`fetch: ${n}/${n}`)
