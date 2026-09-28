import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorizationTypes } from '@x402/evm'

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const KEY = '0x' + '5a'.repeat(32)
export const CHANNEL = '0x' + 'ab'.repeat(32)
export const GAS_WALLET = '0x' + '77'.repeat(20)
export const SELLER_WALLET = '0x' + '66'.repeat(20)
export const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')

const readBody = async (req) => { let b = ''; for await (const d of req) b += d; return b }
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }

export const refundSentence = (url) =>
  `what you don't spend is yours: POST ${url} with {channelId, issued, signature} signed by the payer. We send it; if this channel's fees don't cover the gas (about $0.004029), you sign a gasless USDC payment of exactly that gas and we send both together. One refund per channel per hour. {"selfSend": true} gives you a signed refund to send yourself at your own gas.`

export function passTerms(base, refundPath = '/agents/refund') {
  return {
    x402Version: 2,
    error: 'payment_required',
    resource: { url: `${base}/agents/mcp`, description: 'Adds two numbers.', mimeType: 'application/json' },
    accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: USDC, payTo: SELLER_WALLET, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }],
    pricing: '$0.01 per call, exactly. A call whose work fails is not charged.',
    refund: refundSentence(`${base}${refundPath}`),
  }
}

export function gasQuote(payer, { gasMicroUSD = 4029, returnedMicroUSD = 90000 } = {}) {
  const authorization = { from: payer, to: GAS_WALLET, value: String(gasMicroUSD), validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: '0x' + 'c3'.repeat(32) }
  return {
    op: 'refund_quote', code: 'gas_payment_needed', why: "this channel's fees do not cover the gas of sending your refund",
    leftMicroUSD: returnedMicroUSD, returnedMicroUSD, gasMicroUSD, payTo: GAS_WALLET, authorization,
    sign: { domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC }, types: authorizationTypes, primaryType: 'TransferWithAuthorization', message: authorization },
  }
}

export async function fakeSeller({ refund = () => ({ status: 404, body: { error: 'not_found' } }), paid = () => ({ content: [{ type: 'text', text: '{"sum":3}' }] }), http402 = true } = {}) {
  const seen = { refunds: [], mcp: [], http: [], wellKnown: 0, pay: 0 }
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const path = new URL(req.url, 'http://x').pathname
    const base = `http://127.0.0.1:${srv.address().port}`
    if (path === '/.well-known/x402') { seen.wellKnown++; return json(res, 404, { error: 'not_found' }) }
    if (path === '/pay') { seen.pay++; res.writeHead(404); return res.end() }
    if (path.endsWith('/refund') && req.method === 'POST') {
      const j = JSON.parse(body || '{}')
      seen.refunds.push({ path, body: j, headers: req.headers })
      const a = await refund(j, seen.refunds.length, base)
      return json(res, a.status, a.body)
    }
    if (path === '/agents/mcp') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      const m = JSON.parse(body)
      seen.mcp.push({ method: m.method, headers: req.headers, params: m.params })
      if (m.id === undefined) { res.writeHead(202); return res.end() }
      if (m.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-pass', version: '1' } } })
      if (m.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }] } })
      if (m.method === 'tools/call') {
        const payment = m.params?._meta?.['x402/payment']
        if (!payment) {
          const terms = passTerms(base, '/elsewhere/refund')
          return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { isError: true, structuredContent: terms, content: [{ type: 'text', text: JSON.stringify(terms) }] } })
        }
        return json(res, 200, { jsonrpc: '2.0', id: m.id, result: { ...paid(payment), _meta: { 'x402/payment-response': { success: true, transaction: '0x' + '0'.repeat(8), network: 'eip155:8453', payer: payment?.payload?.authorization?.from } } } })
      }
      return json(res, 200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })
    }
    if (path.startsWith('/agents/v1/')) {
      seen.http.push({ path, headers: req.headers })
      if (http402 && !req.headers['payment-signature']) {
        const terms = passTerms(base)
        return json(res, 402, terms, { 'payment-required': Buffer.from(JSON.stringify(terms)).toString('base64') })
      }
      return json(res, 200, { sum: 3 })
    }
    res.writeHead(404); res.end()
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${srv.address().port}`
  return { base, seen, close: () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok) }) }
}

export async function fakeRpc(answers) {
  const seen = []
  const srv = http.createServer(async (req, res) => {
    const m = JSON.parse(await readBody(req))
    const one = (x) => { seen.push(x.method); const r = answers[x.method]; return r === undefined ? { jsonrpc: '2.0', id: x.id, error: { code: -32601, message: `fake rpc has no ${x.method}` } } : { jsonrpc: '2.0', id: x.id, result: typeof r === 'function' ? r(x.params) : r } }
    json(res, 200, Array.isArray(m) ? m.map(one) : one(m))
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok) }) }
}

export function stateWithChannel(ctx = { balance: '100000', chargedCumulativeAmount: '10000', signedMaxClaimable: '10000', signature: '0x01' }) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
  mkdirSync(join(dir, 'client'), { recursive: true })
  writeFileSync(join(dir, 'client', `${CHANNEL}.json`), JSON.stringify(ctx))
  return dir
}

export const channelFile = (dir) => JSON.parse(readFileSync(join(dir, 'client', `${CHANNEL}.json`), 'utf8'))

export function bridge(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, X402_RPC_URL: 'http://127.0.0.1:9', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const kill = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('exit', (code) => { clearTimeout(kill); let out = null; try { out = JSON.parse(stdout) } catch { } ; resolve({ code, stdout, stderr, out }) })
  })
}
