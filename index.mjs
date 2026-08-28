#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { wrapMCPClientWithPayment, x402Client } from '@x402/mcp'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { toClientEvmSigner } from '@x402/evm'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, fallback, keccak256, toHex, getAddress } from 'viem'
import * as chains from 'viem/chains'
import { mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const UPSTREAM =
  process.env.X402_MCP_URL ?? process.env.X402_UPSTREAM ?? 'https://mcp.zeamprism.com/mcp'
const KEY = process.env.X402_PRIVATE_KEY ?? process.env.PRISM_PRIVATE_KEY
const NETWORK = process.env.X402_NETWORK ?? 'eip155:8453'
const WANT = (process.env.X402_ASSET ?? '').toLowerCase()
const NAME = process.env.X402_NAME ?? 'x402-bridge'
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const log = (...a) => console.error('[x402-bridge]', ...a)

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? '') }
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  process.stdout.write([
    'x402-mcp-bridge — pay for MCP tools with a wallet.',
    '',
    '  With your key exported as X402_PRIVATE_KEY:',
    '',
    '    npx -y @zeam-labs/x402-mcp-bridge --call rpc \'{"chain":"base","method":"eth_blockNumber","params":[]}\'',
    '    npx -y @zeam-labs/x402-mcp-bridge --tools',
    '',
    'With no arguments it runs as an MCP stdio server, which is what an MCP client wants.',
    '',
    'Env: X402_PRIVATE_KEY (required), X402_MCP_URL (X402_UPSTREAM also accepted),',
    '     X402_MAX_SPEND (0 = no cap; base units of the paid asset if the server publishes no price),',
    '     X402_DEPOSIT_MULTIPLIER (default 400 × the SELLER\'S quoted per-call amount; against',
    '     zeamprism that is 400 × 250 = $0.10 of refundable collateral), X402_LINE=auto|on|off,',
    '     X402_SALT.',
'     auto: buy per-call minimum holds until calls arrive faster than the',
'     server minimum hold, then hold a line while that lasts. A held line',
'     bills wall-clock whether you call or not, so holding a line for a',
'     sparse caller costs several times what the slices would have.',
    '',
  ].join('\n'))
  process.exit(0)
}


if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  log('set X402_PRIVATE_KEY to a 0x-prefixed 32-byte key. It stays on this machine;')
  log('it signs payment vouchers locally and is never sent anywhere.')
  process.exit(1)
}
const account = privateKeyToAccount(KEY)
const chainId = Number(String(NETWORK).split(':')[1])
const chain = Object.values(chains).find((c) => c?.id === chainId)
if (!chain) { log(`unknown network ${NETWORK}`); process.exit(1) }

const stateDir = process.env.X402_STATE_DIR ??
  join(homedir(), '.x402-mcp-bridge', new URL(UPSTREAM).host, account.address.toLowerCase())
mkdirSync(stateDir, { recursive: true })

const readers = [
  ...(process.env.X402_RPC_URL ? [process.env.X402_RPC_URL] : []),
  ...(chain.rpcUrls?.default?.http ?? []),
  new URL('/bootstrap', UPSTREAM).toString(),
]
const pub = createPublicClient({ chain, transport: fallback(readers.map(u => http(u))) })
log(`chain reads: ${readers.map(u => new URL(u).host).join(' -> ')}` +
  (process.env.X402_RPC_URL ? '' : '  (set X402_RPC_URL to put your own node first)'))

let chosenAccept = null
const selector = (_version, accepts) => {
  if (WANT) {
    const hit = accepts.find((a) => String(a.asset).toLowerCase() === WANT ||
      String(a.extra?.name ?? '').toLowerCase() === WANT)
    if (hit) { chosenAccept = hit; return hit }
    log(`X402_ASSET=${WANT} is not among the ${accepts.length} quoted; falling back to the first`)
  }
  chosenAccept = accepts[0]
  return accepts[0]
}

const storage = new FileClientChannelStorage({ directory: stateDir })
let channelId = null
const watchedStorage = {
  get: (k) => storage.get(k),
  delete: (k) => storage.delete(k),
  // Every write carries the seller's running total for this channel, so this is
  // also where we learn what we have been billed -- see noteBilled below.
  set: (k, ctx) => { channelId = k; noteBilled(ctx); return storage.set(k, ctx) },
}
// And across restarts: the scheme persists one file per channel.
try {
  const f = readdirSync(join(stateDir, 'client')).find((n) => n.endsWith('.json'))
  if (f) channelId = f.replace(/\.json$/, '')
} catch { /* first run, nothing to recover */ }

const depositPolicy = { depositMultiplier: Number(process.env.X402_DEPOSIT_MULTIPLIER ?? 400) }

const MAX_SPEND = Number(process.env.X402_MAX_SPEND ?? 10_000_000)
let capReached = false

let startedAt = null
let spentMicroUSD = 0

let quoteMicroUSD = null                 // set from the seller's own terms
let spendUnit = 'micro-USD'              // what the numbers we report actually ARE

// Liberal in where it looks, strict about giving up. A server that does not say
// what a call costs in USD gets NO GUESS.
const quoteFromTerms = (j) => {
  for (const c of [j?.rate?.deposit?.tickQuoteMicroUSD, j?.rate?.tickQuoteMicroUSD,
                   j?.rate?.microUSDPerCall, j?.quoteMicroUSD]) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

const microUSDOf = (units) => {
  // The entry the selector actually chose. Not accepts[0] -- that is USDC, and
  // converting WETH units by a USDC quote is the same units bug in a new hat.
  const quoted = Number(chosenAccept?.amount ?? 0)
  if (quoteMicroUSD === null || !(quoted > 0)) return units
  return units * (quoteMicroUSD / quoted)
}

const noteBilled = (ctx) => {
  try {
    const charged = Number(BigInt(ctx?.chargedCumulativeAmount ?? 0))
    if (!Number.isFinite(charged)) return
    if (startedAt === null) startedAt = charged
    const spent = microUSDOf(charged - startedAt)
    if (spent > spentMicroUSD) spentMicroUSD = spent
  } catch { /* a record we cannot read is not a reason to stop paying */ }
  if (!MAX_SPEND || capReached || spentMicroUSD < MAX_SPEND) return
  capReached = true
  log(`SPEND CAP REACHED — this run has spent ${spentMicroUSD} ${spendUnit} against a cap of ` +
    `${MAX_SPEND}. Paying for nothing further. Raise or remove it with X402_MAX_SPEND.`)
  dropLine('spend cap reached')
}

const saltOf = (raw) => {
  const v = String(raw).trim()
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v
  return keccak256(toHex(v))
}

const CARD_PAYER = process.env.X402_PAYER_ADDRESS
  ? getAddress(process.env.X402_PAYER_ADDRESS) : null

const cardSigner = CARD_PAYER ? {
  address: CARD_PAYER,
  readContract: pub.readContract.bind(pub),
  signTypedData: () => {
    throw new Error(
      'this is a gift card and it cannot add funds: it holds a spending key, not ' +
      `the key to ${CARD_PAYER}. The card is out of money — ask whoever funded it ` +
      'to top it up (agent-wallet fund) or issue a new one.')
  },
} : null

if (CARD_PAYER) {
  log(`gift card mode — spending ${CARD_PAYER}'s channel, authorized as ${account.address}`)
  log('this key can spend the card and send it home; it cannot move the money anywhere else')
}

const payments = new x402Client(selector).register(NETWORK,
  new BatchSettlementEvmScheme(toClientEvmSigner(cardSigner ?? account, pub), {
    depositPolicy,
    storage: watchedStorage,
    ...(CARD_PAYER ? { payerAuthorizer: account.address, voucherSigner: toClientEvmSigner(account, pub) } : {}),
    ...(process.env.X402_SALT ? { salt: saltOf(process.env.X402_SALT) } : {}),
  }))

const upstream = wrapMCPClientWithPayment(
  new Client({ name: NAME, version: VERSION }), payments, { autoPayment: true })
await upstream.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)))
log(`paying as ${account.address} -> ${UPSTREAM}`)

const termsURL = new URL('/.well-known/x402', UPSTREAM).toString()
let accepts = null
let tickAccepts = null
const loadTerms = async () => {
  const r = await fetch(termsURL)
  const j = await r.json()
  if (!Array.isArray(j.accepts) || !j.accepts.length) throw new Error('no accepts in well-known')
  accepts = { x402Version: j.x402Version ?? 1, accepts: j.accepts }
  tickAccepts = Array.isArray(j.tickAccepts) && j.tickAccepts.length
    ? { x402Version: j.x402Version ?? 1, accepts: j.tickAccepts }
    : accepts                                    // an upstream that does not sell time
  const q = quoteFromTerms(j)
  if (q !== null) {
    if (q !== quoteMicroUSD) log(`quote: ${q} micro-USD per call, from the seller's own terms`)
    quoteMicroUSD = q; spendUnit = 'micro-USD'
  } else if (quoteMicroUSD === null) {
    spendUnit = 'base units of the paid asset'
    log(`quote: this server publishes no micro-USD price, so X402_MAX_SPEND is read as ` +
        `BASE UNITS OF THE ASSET, not dollars. Guessing a price here is how a spend cap ` +
        `silently stops capping.`)
  }
  return accepts
}
try { await loadTerms(); log(`terms cached from ${termsURL} — paying without probing`) }
catch (e) { log(`could not cache terms (${e.message}); falling back to probe-then-pay`) }

let paymentQueue = Promise.resolve()
const oneAtATime = (fn) => {
  const run = paymentQueue.then(fn, fn)
  paymentQueue = run.then(() => {}, () => {})       // a failure must not poison the queue
  return run
}

const declarePaying = () => {
  try { if (line.socket?.readyState === 1) line.socket.send(JSON.stringify({ op: 'paying' })) } catch { }
}

const payFirst = (name, args) => oneAtATime(() => { declarePaying(); return payNow(name, args) })

let coldStart = !channelId
if (coldStart) log('no local channel state — probing once to learn where this channel stands')

const payNow = async (name, args) => {
  if (coldStart) {
    coldStart = false
    // autoPayment handles the 402 and pays the retry, and the 402 is what
    // carries the channel state the client is missing.
    return upstream.callTool(name, args)
  }
  const terms = name === 'tick' ? tickAccepts : accepts
  if (!terms) return upstream.callTool(name, args)
  for (const attempt of [1, 2]) {
    try {
      const payload = await payments.createPaymentPayload(terms)
      const out = await upstream.callToolWithPayment(name, args, payload)
      if (explainPermit2(out)) return out
      if (refusedPayment(out)) {
        log('payment refused as stale — dropping the local channel record and resyncing')
        if (channelId) { try { await watchedStorage.delete(channelId) } catch { /* it will be rebuilt */ } }
        return upstream.callTool(name, args)
      }
      return out
    } catch (e) {
      if (attempt === 2) { log(`pay-first failed twice (${e.message}); using probe path`); return upstream.callTool(name, args) }
      try { await loadTerms() } catch { /* keep the old terms and let attempt 2 decide */ }
    }
  }
}

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
let approvalToldFor = null
const explainPermit2 = (out) => {
  const body = String(out?.content?.[0]?.text ?? '')
  if (!/permit2_allowance_required/.test(body)) return false
  const token = chosenAccept?.asset
  if (!token || approvalToldFor === token) return true
  approvalToldFor = token
  const per = Number(chosenAccept?.amount ?? 0)
  const mult = Number(process.env.X402_DEPOSIT_MULTIPLIER ?? 400)
  const suggested = per > 0 ? BigInt(Math.ceil(per * mult * 4)) : 0n
  log(`${token} moves through Permit2 and your wallet has not approved it.`)
  log(`  send once, from your wallet:  approve(${PERMIT2}, ${suggested || '<amount>'})  on ${token}`)
  log('  a bounded amount is enough — this covers several deposits at your current multiplier.')
  log('  it is your transaction and costs gas; nothing else in this flow does.')
  return true
}

function refusedPayment(out) {
  if (!out?.isError) return false
  const body = String(out?.content?.[0]?.text ?? '')
  return /x402Version/.test(body) && /"error"\s*:\s*"(invalid_|insufficient_|cumulative_)/.test(body)
}
log(`channel state in ${stateDir}`)

const LINE_MODE = (process.env.X402_LINE ?? 'auto').toLowerCase()

const AUTO_FAST_RUN = Number(process.env.X402_AUTO_FAST_RUN ?? 2)

const AUTO_SLOW_RUN = Number(process.env.X402_AUTO_SLOW_RUN ?? 4)

const line = { credential: null, socket: null, timer: null, tickMs: 250, lastUse: 0, opening: null }

// Rolling view of how fast the caller is actually going.
const rate = { lastCallAt: 0, fastRun: 0, slowRun: 0 }

function holdingIsCheaper() {
  const now = Date.now()
  const gap = rate.lastCallAt ? now - rate.lastCallAt : Infinity
  rate.lastCallAt = now
  // <=, not <: at exactly one call per hold window the two cost the same, and
  // holding avoids a signature and a settlement per call.
  if (gap <= line.tickMs) { rate.fastRun += 1; rate.slowRun = 0 }
  else { rate.slowRun += 1; rate.fastRun = 0 }

  // Already holding? Keep holding until several gaps in a row say otherwise.
  if (line.credential) return rate.slowRun < AUTO_SLOW_RUN
  return rate.fastRun >= AUTO_FAST_RUN
}

const wsURL = () => {
  const u = new URL(UPSTREAM)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/pay'
  u.search = ''
  return u.toString()
}

const dropLine = (why) => {
  if (line.timer) { clearInterval(line.timer); line.timer = null }
  try { line.socket?.close() } catch { /* already gone */ }
  if (line.credential) log(`line closed (${why})`)
  line.socket = null
  line.credential = null
}

let ticking = false
const tick = async () => {
  if (capReached) return dropLine('spend cap reached')
  if (!line.credential || ticking) return
  ticking = true
  try {
    const out = await payFirst('tick', { line: line.credential })
    const body = String(out?.content?.[0]?.text ?? '')
    if (/"paid"\s*:\s*false/.test(body) || lineWasRefused(out)) {
      dropLine('the line this tick paid for is gone')
    }
  } catch (e) { dropLine(`tick failed: ${e.message}`) }
  finally { ticking = false }
}

const openLine = () => {
  if (line.credential || line.opening) return line.opening
  if (!channelId) return null                    // no channel yet; the first paid call makes one
  line.opening = new Promise((resolve) => {
    let socket
    try { socket = new WebSocket(wsURL()) } catch (e) { log(`line: ${e.message}`); return resolve(null) }
    const give_up = setTimeout(() => { try { socket.close() } catch {} ; resolve(null) }, 10_000)
    socket.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.op === 'opened') {
        clearTimeout(give_up)
        line.socket = socket
        line.credential = m.credential
        line.tickMs = Number(m.tickMs) || 250
        // A line that has just opened has not been idle. lastUse starts at 0, so
        // without this the first timer fire sees an age of Date.now() and drops
        // the line before anything can use it.
        line.lastUse = Date.now()
        log(`line open — ${m.microUSDPerMs ?? 1} micro-USD/ms, collateral buys ${m.buysMs ?? '?'}ms`)
        const first = tick()
        line.timer = setInterval(() => {
          // Stop paying for a line nobody is using. The server closes an unused
          // line on its own; this is us not paying for the window before it does.
          if (LINE_MODE === 'auto' && Date.now() - line.lastUse > line.tickMs * 4) return dropLine('idle')
          tick()
        }, line.tickMs)
        line.timer.unref?.()
        first.then(() => resolve(line.credential))
      } else if (m.op === 'closing' || m.error) {
        log(`line: ${m.why ?? m.error}`)
        clearTimeout(give_up)
        dropLine(m.why ?? m.error)
        resolve(null)
      }
    }
    socket.onopen = () => socket.send(JSON.stringify({ op: 'open', channelId }))
    socket.onclose = () => { clearTimeout(give_up); dropLine('socket closed'); resolve(null) }
    socket.onerror = () => { /* onclose follows and does the work */ }
  }).finally(() => { line.opening = null })
  return line.opening
}

const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await upstream.listTools()
  return { tools }
})
const callOnLine = async (name, args) => {
  if (capReached) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: 'x402_bridge_spend_cap_reached',
      spentMicroUSD, capMicroUSD: MAX_SPEND,
      message: 'This bridge has spent its X402_MAX_SPEND ceiling and will not pay for more. ' +
        'Raise it, set X402_MAX_SPEND=0 to remove it, or restart the bridge.' }) }] }
  }
  line.lastUse = Date.now()
  if (LINE_MODE === 'off') return payFirst(name, args)

  if (LINE_MODE === 'auto') {
    if (!holdingIsCheaper()) {
      if (line.credential) dropLine('slower than the minimum hold — slices are cheaper')
      return payFirst(name, args)
    }
  }

  if (!channelId) return payFirst(name, args)

  for (const attempt of [1, 2]) {
    if (!line.credential) await openLine()
    if (!line.credential) break
    const out = await upstream.callTool(name, { ...args, line: line.credential })
    if (!lineWasRefused(out)) return out
    dropLine(reasonFrom(out) ?? 'refused by the server')
    if (attempt === 2) {
      log('the line was refused twice; paying for this call directly. If the reason above ' +
        'is collateral, raise X402_DEPOSIT_MULTIPLIER — the minimum of 3 buys under a second of line.')
    }
  }
  return payFirst(name, args)
}

const LINE_IS_GONE = /"lineGone"\s*:\s*true|"(?:error|code)"\s*:\s*"(?:unknown_line|line_unpaid|line_closed)"/
const lineWasRefused = (out) => LINE_IS_GONE.test(String(out?.content?.[0]?.text ?? ''))

const reasonFrom = (out) => {
  try {
    const body = JSON.parse(String(out?.content?.[0]?.text ?? ''))
    const why = body.why ?? body.message ?? body.error ?? body.code
    return typeof why === 'string' && why ? why.slice(0, 160) : null
  } catch { return null }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const out = await callOnLine(req.params.name, req.params.arguments ?? {})
  return out
})

const stopPayingQuietly = async () => {
  dropLine('one-shot call finished')
  await new Promise(r => setTimeout(r, 50))
}

let leaving = false
const stopPaying = (why) => {
  if (leaving) return
  leaving = true
  dropLine(why)
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopPaying('shutting down'))
for (const ev of ['end', 'close']) {
  process.stdin.on(ev, () => stopPaying('stdin closed — whatever started us is gone'))
}
process.on('disconnect', () => stopPaying('parent disconnected'))

if (has('--tools')) {
  const out = await upstream.listTools()
  process.stdout.write(JSON.stringify(out.tools.map(t => t.name), null, 2) + '\n')
  await stopPayingQuietly()
  process.exit(0)
}

if (has('--call')) {
  const tool = flag('--call')
  if (!tool) { process.stderr.write('--call needs a tool name\n'); process.exit(2) }
  // The JSON argument is optional: several tools take none.
  const rawArgs = argv[argv.indexOf('--call') + 2]
  let args = {}
  if (rawArgs && !rawArgs.startsWith('--')) {
    try { args = JSON.parse(rawArgs) }
    catch (e) { process.stderr.write(`--call arguments must be JSON: ${e.message}\n`); process.exit(2) }
  }
  try {
    const out = await callOnLine(tool, args)
    const text = out?.content?.[0]?.text
    process.stdout.write((typeof text === 'string' ? text : JSON.stringify(out)) + '\n')
    await stopPayingQuietly()
    process.exit(out?.isError ? 1 : 0)
  } catch (e) {
    process.stderr.write(`call failed: ${e.message}\n`)
    await stopPayingQuietly()
    process.exit(1)
  }
}

if (has('--refund')) {
  if (!channelId) { process.stderr.write('no channel to refund — nothing has been bought with this key and salt\n'); process.exit(2) }

  // The channel is proved by signing for it, not by holding a session open. No
  // line, no tick, no keep-warm: one message, one answer. Under a gift card the
  // key here is the payerAuthorizer, which the server accepts for the same reason.
  const issued = new Date().toISOString()
  const message = `ZEAM Prism refund\nchannel: ${String(channelId).toLowerCase()}\nissued: ${issued}`
  const signature = await account.signMessage({ message })

  const answer = await new Promise((resolve) => {
    let socket
    try { socket = new WebSocket(wsURL()) } catch (e) { return resolve({ error: e.message }) }
    const done = setTimeout(() => { try { socket.close() } catch {} ; resolve({ error: 'no answer in 60s' }) }, 60_000)
    socket.onopen = () => socket.send(JSON.stringify({ op: 'refund', channelId, issued, signature }))
    socket.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.op === 'refunding') return log(m.note ?? 'refunding')
      if (m.op === 'refunded' || m.op === 'refund_failed' || m.error) {
        clearTimeout(done); try { socket.close() } catch {} ; resolve(m)
      }
    }
    socket.onerror = (e) => { clearTimeout(done); resolve({ error: e?.message ?? 'socket error' }) }
  })

  process.stdout.write(JSON.stringify(answer, null, 2) + '\n')
  if (answer.op !== 'refunded') {
    process.stderr.write([
      '',
      'The exit that always works needs nothing from us:',
      '  initiateWithdraw(config, amount)   then, after the delay, finalizeWithdraw(config)',
      'We also watch for that first call and return the collateral ourselves, at our gas,',
      'so you usually do not have to send the second transaction. We do NOT promise when:',
      'a third-party auditor measured 920 seconds on 2026-08-26, i.e. just after the delay',
      'elapsed. Plan against the delay. The escrow gates withdrawal to you alone, so your',
      'unspent collateral is safe either way.',
      '',
    ].join('\n'))
  }
  process.exit(answer.op === 'refunded' ? 0 : 1)
}

await server.connect(new StdioServerTransport())
if (LINE_MODE === 'on' && channelId) await openLine()
log(`bridge up on stdio — line mode ${LINE_MODE}${channelId ? '' : ' (channel opens on your first call)'}` +
  ` | spend cap ${MAX_SPEND ? MAX_SPEND + ' ' + spendUnit : 'NONE (X402_MAX_SPEND=0)'}` +
  ' | stops when stdin closes')
