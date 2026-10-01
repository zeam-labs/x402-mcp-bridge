import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authorizationTypes } from '@x402/evm'
import { recoverMessageAddress } from 'viem'

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

const ROWS = {
  exact: { scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: USDC, payTo: SELLER_WALLET, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } },
  batch: { scheme: 'batch-settlement', network: 'eip155:8453', amount: '10000', asset: USDC, payTo: SELLER_WALLET, maxTimeoutSeconds: 240, extra: { name: 'USD Coin', version: '2', receiverAuthorizer: SELLER_WALLET, withdrawDelay: 86400 } },
}

export function passTerms(base, refundPath = '/agents/refund', row = 'exact') {
  return {
    x402Version: 2,
    error: 'payment_required',
    resource: { url: `${base}/agents/mcp`, description: 'Adds two numbers.', mimeType: 'application/json' },
    accepts: [ROWS[row]],
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
        const terms = passTerms(base, '/agents/refund', 'batch')
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

export const TIME_ROW = { scheme: 'batch-settlement', network: 'eip155:8453', amount: '250', asset: USDC, payTo: SELLER_WALLET, maxTimeoutSeconds: 240, extra: { name: 'USD Coin', version: '2', receiverAuthorizer: SELLER_WALLET, withdrawDelay: 86400 } }

const TIME_TAG = { per: 'time', blockUSD: '0.00025', blockMs: 250, callUSD: '0.00025', callMs: 250 }
const TIME_TOOLS = [
  { name: 'buy_time', description: 'Buys line time.', inputSchema: { type: 'object', properties: { blocks: { type: 'integer', minimum: 1 } } }, outputSchema: { type: 'object', properties: { boughtMs: { type: 'number' }, msRemaining: { type: 'number' } } }, _meta: { 'zeam-pass/price': { usd: '0.00025', per: 'block', blockMs: 250, maxBlocks: 14400 } } },
  { name: 'line', description: 'A line.', inputSchema: { type: 'object', properties: { op: { type: 'string' } }, required: ['op'] }, _meta: { 'zeam-pass/price': { usd: '0', per: 'call', free: true } } },
  { name: 'call_rpc', description: 'JSON-RPC.', inputSchema: { type: 'object', properties: { method: { type: 'string' } } }, outputSchema: { type: 'object', properties: { result: {} } }, _meta: { 'zeam-pass/price': TIME_TAG } },
  { name: 'slow_rpc', description: 'JSON-RPC that takes 400 ms.', inputSchema: { type: 'object' }, _meta: { 'zeam-pass/price': TIME_TAG } },
  { name: 'add', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } }, outputSchema: { type: 'object', properties: { sum: { type: 'number' } } }, _meta: { 'zeam-pass/price': { usd: '0.00025', per: 'call' } } },
  { name: 'get_terms', description: 'Free.', inputSchema: { type: 'object' }, _meta: { 'zeam-pass/price': { usd: '0', per: 'call', free: true } } },
]

export async function fakeTimeSeller({ root = '/agents', wellKnown = false, meterOnAtProve = true, callMs = 40, floor = 0, refund = () => ({ status: 404, body: { error: 'not_found' } }) } = {}) {
  const seen = { calls: [], line: [], refunds: [], paid: [], mcp: [], http: [], deposits: [] }
  const channels = new Map()
  const lines = new Map()
  const nonces = new Map()
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req)
    const path = new URL(req.url, 'http://x').pathname
    const base = `http://127.0.0.1:${srv.address().port}${root}`
    const terms = (amount = '250', resource = `${base}/mcp`) => ({
      x402Version: 2, error: 'payment_required', resource: { url: resource }, accepts: [{ ...TIME_ROW, amount }],
      pricing: '$0.00025 per call.', refund: refundSentence(`${base}/refund`),
      ...(floor ? { deposit: `First call on a channel deposits at least $${(floor / 1e6).toFixed(5)}. Later calls spend it.` } : {}),
      prices: Object.fromEntries(TIME_TOOLS.map((t) => [t.name, t._meta['zeam-pass/price']])),
      time: `Line time: $0.00025 per 250 ms block. buy_time {blocks} (1 to 14400). Open a line: POST ${base}/line {"op":"open","channelId"}, sign the message it returns with the payer key, POST {"op":"prove","channelId","nonce","signature"}. Send the credential as x-line (MCP: _meta["zeam-pass/line"]).`,
    })
    if (path === '/.well-known/x402') {
      if (!wellKnown) return json(res, 404, { error: 'not_found' })
      const t = terms()
      return json(res, 200, { ...t, tickAccepts: t.accepts, rate: { microUSDPerMillisecond: 1, blockMs: 250, microUSDPerBlock: 250 }, refund: { route: `POST ${base}/refund`, how: 'POST /refund {channelId, issued, signature}' }, line: { open: `POST ${base}/line {"op":"open","channelId"} -> a message` } })
    }
    if (path === `${root}/refund` && req.method === 'POST') {
      const j = JSON.parse(body || '{}')
      seen.refunds.push(j)
      const a = await refund(j, seen.refunds.length, channels)
      return json(res, a.status, a.body)
    }
    if (path === `${root}/line` && req.method === 'POST') {
      const j = JSON.parse(body || '{}')
      seen.line.push(j)
      if (j.op === 'open') {
        const ch = channels.get(String(j.channelId).toLowerCase())
        if (!ch) return json(res, 404, { op: 'line_failed', code: 'unknown_channel', why: 'no channel with that id here' })
        const nonce = 'n' + seen.line.length
        nonces.set(nonce, ch.id)
        return json(res, 200, { op: 'challenge', channelId: ch.id, nonce, sign: `ZEAM Pass line\nchannel: ${ch.id}\nnonce: ${nonce}`, expiresInSeconds: 300 })
      }
      if (j.op === 'prove') {
        const id = nonces.get(j.nonce)
        nonces.delete(j.nonce)
        if (!id) return json(res, 400, { op: 'line_failed', code: 'no_challenge', why: 'no live challenge' })
        const who = await recoverMessageAddress({ message: `ZEAM Pass line\nchannel: ${id}\nnonce: ${j.nonce}`, signature: j.signature })
        const ch = channels.get(id)
        if (who.toLowerCase() !== ch.payer) return json(res, 403, { op: 'line_failed', code: 'not_the_payer', why: `${who} is not this channel's payer` })
        const credential = 'cred-' + seen.line.length
        lines.set(credential, id)
        ch.on = meterOnAtProve
        return json(res, 200, { op: 'opened', credential, channelId: id, msRemaining: ch.ms, metering: ch.on })
      }
      const id = lines.get(j.credential)
      if (!id) return json(res, 403, { op: 'line_failed', code: 'line_unknown', why: 'no open line with that credential' })
      const ch = channels.get(id)
      if (j.op === 'close') { lines.delete(j.credential); return json(res, 200, { op: 'closed', channelId: id }) }
      if (j.op === 'on' || j.op === 'off') ch.on = j.op === 'on'
      return json(res, 200, { op: j.op, channelId: id, msRemaining: ch.ms, metering: ch.on })
    }
    if ((path === `${root}/v1/buy_time` || path === `${root}/rpc/base`) && req.method === 'POST') {
      const name = path.endsWith('/buy_time') ? 'buy_time' : 'rpc'
      const args = body ? JSON.parse(body) : {}
      const credential = req.headers['x-line']
      const sig = req.headers['payment-signature']
      seen.http.push({ name, line: credential ?? null, paid: Boolean(sig) })
      const out = (status, b, headers = {}) => json(res, status, b, headers)
      const rpcResult = { jsonrpc: '2.0', id: args.id ?? 1, result: '0x10' }
      if (name === 'rpc' && credential) {
        const id = lines.get(credential)
        if (!id) return out(403, { error: 'line_unknown', message: 'no open line with that credential.' })
        const ch = channels.get(id)
        if (!ch.on) return out(402, { error: 'meter_off', message: 'the meter is off.', msRemaining: ch.ms })
        if (ch.ms < callMs) { ch.ms = 0; return out(402, { error: 'out_of_time', message: 'no time left', msRemaining: 0 }) }
        ch.ms -= callMs
        return out(200, rpcResult, { 'x-pass-ms-remaining': String(ch.ms), 'x-pass-ms-elapsed': String(callMs) })
      }
      const blocks = name === 'buy_time' ? (Number.isSafeInteger(args.blocks) && args.blocks >= 1 ? args.blocks : 1) : 1
      const amount = String(250 * blocks)
      const t = terms(amount, `${base}${path.slice(root.length)}`)
      if (!sig) return out(402, t, { 'payment-required': Buffer.from(JSON.stringify(t)).toString('base64') })
      const payment = JSON.parse(Buffer.from(sig, 'base64').toString('utf8'))
      if (String(payment.accepted?.amount) !== amount) return out(402, { ...t, error: 'price_changed', code: 'price_changed' })
      const p = payment.payload
      if (p.type === 'deposit' && BigInt(p.deposit.amount) < BigInt(floor)) return out(402, { ...t, error: 'funding_requires_open_fee', code: 'funding_requires_open_fee', neededMicroUSD: floor, depositMicroUSD: Number(p.deposit.amount) })
      const id = String(p.voucher?.channelId ?? '').toLowerCase()
      const ch = channels.get(id) ?? { id, payer: String(p.channelConfig?.payer ?? '').toLowerCase(), balance: 0n, charged: 0n, ms: 0, on: false }
      if (p.type === 'deposit') seen.deposits.push(p.deposit.amount)
      if (p.type === 'deposit') { ch.balance += BigInt(p.deposit.amount); if (p.channelConfig?.payer) ch.payer = p.channelConfig.payer.toLowerCase() }
      ch.charged += BigInt(amount)
      channels.set(id, ch)
      seen.paid.push({ name, amount, type: p.type ?? 'voucher' })
      const settled = { success: true, transaction: '0x' + '0'.repeat(8), network: 'eip155:8453', payer: ch.payer, extra: { channelState: { channelId: id, balance: String(ch.balance), chargedCumulativeAmount: String(ch.charged), totalClaimed: '0' } } }
      const pr = { 'payment-response': Buffer.from(JSON.stringify(settled)).toString('base64') }
      if (name === 'buy_time') { ch.ms += blocks * 250; return out(200, { boughtMs: blocks * 250, msRemaining: ch.ms }, pr) }
      return out(200, rpcResult, pr)
    }
    if (path === `${root}/mcp`) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      const m = JSON.parse(body)
      seen.mcp.push({ method: m.method, headers: req.headers, params: m.params })
      if (m.id === undefined) { res.writeHead(202); return res.end() }
      const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: m.id, result })
      const fail = (b) => reply({ isError: true, structuredContent: b, content: [{ type: 'text', text: JSON.stringify(b) }] })
      if (m.method === 'initialize') return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-time', version: '1' } })
      if (m.method === 'tools/list') return reply({ tools: TIME_TOOLS })
      if (m.method !== 'tools/call') return json(res, 200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })
      const { name, arguments: args = {}, _meta = {} } = m.params
      const credential = _meta['zeam-pass/line']
      seen.calls.push({ name, args, line: credential ?? null, paid: Boolean(_meta['x402/payment']) })
      const work = name === 'slow_rpc' ? 400 : callMs
      const result = name === 'add' ? { sum: (args.a ?? 0) + (args.b ?? 0) } : name === 'get_terms' ? { free: true } : { result: '0x10' }
      if (name === 'get_terms' && args.fail) return fail({ error: 'tool_failed', tool: 'get_terms' })
      if (name === 'get_terms') return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, _meta: { 'fake/free': true } })
      if (credential && (name === 'call_rpc' || name === 'slow_rpc')) {
        const id = lines.get(credential)
        if (!id) return fail({ error: 'line_unknown', message: 'no open line with that credential.' })
        const ch = channels.get(id)
        if (!ch.on) return fail({ error: 'meter_off', message: 'the meter is off.', msRemaining: ch.ms })
        if (ch.ms <= 0) return fail({ error: 'out_of_time', message: 'no time left', msRemaining: 0 })
        if (work > ch.ms) { ch.ms = 0; return fail({ error: 'out_of_time', message: 'the line ran out of time during the call.', msRemaining: 0 }) }
        ch.ms -= work
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, _meta: { 'zeam-pass/meter': { channelId: id, msRemaining: ch.ms, elapsedMs: work } } })
      }
      const blocks = name === 'buy_time' ? (Number.isSafeInteger(args.blocks) && args.blocks >= 1 ? args.blocks : 1) : 1
      const amount = String(250 * blocks)
      const payment = _meta['x402/payment']
      if (!payment) return fail(terms(amount))
      if (String(payment.accepted?.amount) !== amount) return fail({ ...terms(amount), error: 'price_changed', code: 'price_changed' })
      const p = payment.payload
      if (p.type === 'deposit' && BigInt(p.deposit.amount) < BigInt(floor)) return fail({ ...terms(amount), error: 'funding_requires_open_fee', code: 'funding_requires_open_fee', neededMicroUSD: floor, depositMicroUSD: Number(p.deposit.amount) })
      const id = String(p.voucher?.channelId ?? p.channelId ?? '').toLowerCase()
      const ch = channels.get(id) ?? { id, payer: String(p.channelConfig?.payer ?? '').toLowerCase(), balance: 0n, charged: 0n, ms: 0, on: false }
      if (p.type === 'deposit') seen.deposits.push(p.deposit.amount)
      if (p.type === 'deposit') { ch.balance += BigInt(p.deposit.amount); if (p.channelConfig?.payer) ch.payer = p.channelConfig.payer.toLowerCase() }
      channels.set(id, ch)
      if (name === 'slow_rpc') return fail({ error: 'out_of_time', message: 'the call ran past the 250 ms its price buys. Nothing was charged.' })
      ch.charged += BigInt(amount)
      seen.paid.push({ name, amount, type: p.type ?? 'voucher' })
      const settled = { success: true, transaction: '0x' + '0'.repeat(8), network: 'eip155:8453', payer: ch.payer, extra: { channelState: { channelId: id, balance: String(ch.balance), chargedCumulativeAmount: String(ch.charged), totalClaimed: '0' } } }
      if (name === 'buy_time') { ch.ms += blocks * 250; const b = { boughtMs: blocks * 250, msRemaining: ch.ms }; return reply({ content: [{ type: 'text', text: JSON.stringify(b) }], structuredContent: b, _meta: { 'x402/payment-response': settled } }) }
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, _meta: { 'x402/payment-response': settled } })
    }
    res.writeHead(404); res.end()
  })
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${srv.address().port}${root}`
  return { base, seen, channels, lines, close: () => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok) }) }
}
