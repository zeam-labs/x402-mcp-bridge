#!/usr/bin/env node
// Put a wallet in front of a paid MCP server.
//
// A metered MCP endpoint takes payment in the tool call's params._meta -- a
// signed x402 payload the CLIENT has to construct per call. No stock MCP client
// does that, so "add this URL to your config" gets you tools/list, a free
// sample if the server has one, and a 402 you cannot satisfy. The only way to
// buy was to write your own client.
//
// This is that client, wearing a stdio MCP server on the front. Your existing
// client speaks to this; this speaks money upstream. The key never leaves the
// machine you run it on.
//
//   { "prism": { "command": "npx",
//                "args": ["-y", "https://www.zeamprism.com/x402-mcp-bridge.tgz"],
//                "env": { "X402_PRIVATE_KEY": "0x..." } } }
//
// The URL, not a package name: this is not on npm, and an install line that
// 404s is worse inside the file than outside it. Source and checksum:
//   https://github.com/zeam-labs/x402-mcp-bridge
//   https://www.zeamprism.com/x402-mcp-bridge.tgz.sha256
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
import { createPublicClient, http, fallback, keccak256, toHex} from 'viem'
import * as chains from 'viem/chains'
import { mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UPSTREAM = process.env.X402_MCP_URL ?? 'https://mcp.zeamprism.com/mcp'
const KEY = process.env.X402_PRIVATE_KEY ?? process.env.PRISM_PRIVATE_KEY
const NETWORK = process.env.X402_NETWORK ?? 'eip155:8453'
const WANT = (process.env.X402_ASSET ?? '').toLowerCase()
const NAME = process.env.X402_NAME ?? 'x402-bridge'
// stderr, never stdout: stdout IS the MCP transport, and one stray line there
// corrupts the framing and the client reports a protocol error instead of a
// message you can act on.
const log = (...a) => console.error('[x402-bridge]', ...a)

if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  log('set X402_PRIVATE_KEY to a 0x-prefixed 32-byte key. It stays on this machine;')
  log('it signs payment vouchers locally and is never sent anywhere.')
  process.exit(1)
}
const account = privateKeyToAccount(KEY)
const chainId = Number(String(NETWORK).split(':')[1])
const chain = Object.values(chains).find((c) => c?.id === chainId)
if (!chain) { log(`unknown network ${NETWORK}`); process.exit(1) }

// Channel state MUST persist. A client that reconnects with empty storage pays a
// fresh deposit it did not need, and can only recover if its signer can read the
// chain -- so we give it both: a directory, and a reader.
const stateDir = process.env.X402_STATE_DIR ??
  join(homedir(), '.x402-mcp-bridge', new URL(UPSTREAM).host, account.address.toLowerCase())
mkdirSync(stateDir, { recursive: true })

// READ THE CHAIN SOMEWHERE THAT IS NOT THE SELLER.
//
// This used to default to the upstream's own /bootstrap. The reasoning was that
// recovery reads are what a free bootstrap endpoint exists for -- but those
// reads are how you check the seller's claims about your own channel: your
// balance, what has been claimed against it, whether a withdrawal is pending.
// Verifying the seller through the seller verifies nothing, and it makes their
// outage yours as well.
//
// In order: your node, the chain's own public endpoint, then the upstream's free
// /bootstrap. Ranked by whose interest each serves, and it falls through on
// failure rather than picking one and hoping.
//
// Preferring the public endpoint alone did not survive contact: it rate-limits,
// the channel-state read failed under it, and the client then built a voucher
// from stale state and got cumulative_amount_mismatch -- 1 call in 10. Making
// the buyer's operational path depend on a shared free endpoint is its own kind
// of bad. The seller's endpoint stays LAST: fine as a fallback, never the thing
// you check the seller with.
const readers = [
  ...(process.env.X402_RPC_URL ? [process.env.X402_RPC_URL] : []),
  ...(chain.rpcUrls?.default?.http ?? []),
  new URL('/bootstrap', UPSTREAM).toString(),
]
const pub = createPublicClient({ chain, transport: fallback(readers.map(u => http(u))) })
log(`chain reads: ${readers.map(u => new URL(u).host).join(' -> ')}` +
  (process.env.X402_RPC_URL ? '' : '  (set X402_RPC_URL to put your own node first)'))

// WHICH ENTRY WE ARE PAYING WITH. The client's stored record holds three numbers
// and nothing else -- no config, no token -- so the asset cannot be recovered
// from it. The selector is the only place that knows, so it says so here.
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

// Which channel we are paying through. The scheme opens it on the first payment
// and never tells anyone; we need the id to open a line against it, so watch the
// storage it writes through rather than guessing at the derivation.
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

// HOW MUCH OF YOUR MONEY SITS IN ESCROW IS YOUR CHOICE, not the seller's.
//
// The scheme funds a channel at a multiple of the quoted price. Upstream quotes
// one honest per-call price and leaves the runway to us, so this is the knob
// that decides how long a line runs before it tops up. 400 x 250 micro-USD is
// 100,000 -- about a hundred seconds of line at the published rate -- and it
// tops up automatically from there. Lower it if you would rather hold less at
// risk; the floor the scheme enforces is 3.
const depositPolicy = { depositMultiplier: Number(process.env.X402_DEPOSIT_MULTIPLIER ?? 400) }

// A CEILING ON WHAT THIS PROCESS CAN SPEND OF YOUR MONEY.
//
// This holds your key and pays without asking, so what it can spend while nobody
// is watching must be bounded by something other than your balance. An outside
// auditor put it plainly: uncapped autonomous wallet spend is not acceptable in a
// shipped default.
//
// The cap is cumulative metered spend for the life of the process, taken from
// what the seller has actually billed -- the channel record it writes through us
// -- and not from anything we guess. $10 is about three hours of continuously
// held line at the published rate: generous enough that ordinary work never
// meets it, small enough that a runaway costs a rounding error rather than a
// wallet. X402_MAX_SPEND=0 removes it.
const MAX_SPEND = Number(process.env.X402_MAX_SPEND ?? 10_000_000)
let capReached = false

// IT HAS TO BE THIS RUN'S SPEND, NOT THE CHANNEL'S WHOLE HISTORY.
//
// The figure the channel record carries is cumulative for the life of the
// channel, and a channel outlives the processes that use it. Measured against a
// channel with history: the very first write reported 381,759 already billed, so
// a $0.002 cap tripped before a single call was served and would have tripped for
// any buyer reusing a wallet. The first figure we see is the starting line, not
// the bill.
let startedAt = null
let spentMicroUSD = 0

// THE CHANNEL COUNTS IN ITS OWN TOKEN, NOT IN MICRO-USD.
//
// `chargedCumulativeAmount` is base units of the channel's asset. USDC has 6
// decimals so those units happen to equal micro-USD, and the cap worked by
// coincidence. The first WETH payment exposed it: 18 decimals, so a 131,218 wei
// charge read as 131,274,717,136 "micro-USD" and tripped a $10 cap on the third
// call of a $0.0003 session.
//
// The quote gives the conversion. `accepts.amount` is what one call costs in the
// channel's units, and that same call is `QUOTE_MICRO_USD` micro-USD, so
// micro-USD = units * QUOTE_MICRO_USD / amount. Taken from the terms we already
// fetched, so no price feed and no second opinion about what money is.
const QUOTE_MICRO_USD = 250
const microUSDOf = (units) => {
  // The entry the selector actually chose. Not accepts[0] -- that is USDC, and
  // converting WETH units by a USDC quote is the same units bug in a new hat.
  const quoted = Number(chosenAccept?.amount ?? 0)
  if (!(quoted > 0)) return units          // nothing paid yet: the cap still bounds something
  return units * (QUOTE_MICRO_USD / quoted)
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
  log(`SPEND CAP REACHED — this run has spent ${spentMicroUSD} micro-USD against a cap of ` +
    `${MAX_SPEND}. Paying for nothing further. Raise or remove it with X402_MAX_SPEND.`)
  dropLine('spend cap reached')
}

// A SALT IS BYTES32, AND NOBODY TOLD YOU.
//
// X402_SALT goes straight into the channel config, which wants a 32-byte value.
// Anything else came back as `Expected bytes32, got bytes13.` from inside viem
// -- a dependency's type error, surfacing on the buyer's first attempt to spend
// money, naming neither the variable nor what it wanted. The obvious thing to
// put in that variable is a human-readable name, and the obvious thing is what
// fails.
//
// A salt only has to be unique and stable, so any string can be one: hash it.
// A value that already IS bytes32 passes through untouched, so nothing that
// works today changes -- including channels already open under a hex salt.
const saltOf = (raw) => {
  const v = String(raw).trim()
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v
  return keccak256(toHex(v))
}

const payments = new x402Client(selector).register(NETWORK,
  new BatchSettlementEvmScheme(toClientEvmSigner(account, pub), {
    depositPolicy,
    storage: watchedStorage,
    ...(process.env.X402_SALT ? { salt: saltOf(process.env.X402_SALT) } : {}),
  }))

const upstream = wrapMCPClientWithPayment(
  new Client({ name: NAME, version: '1.0.0' }), payments, { autoPayment: true })
await upstream.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)))
log(`paying as ${account.address} -> ${UPSTREAM}`)

// PAY ON FIRST CONTACT. DO NOT PROBE.
//
// The stock flow sends every call unpaid, reads the 402 it gets back, then sends
// the same call again with payment. Two network round trips for one call: at a
// 130ms RTT that is 260ms, and the meter bills time on the line, so the buyer
// pays for a handshake they did not need. Those probes are also unpaid calls,
// and 60 an hour is the ceiling -- which is how a funded wallet gets locked out
// of a channel it has money in.
//
// The terms are static and published, so we read them once and attach payment to
// the first request. Quotes for non-stable assets move with the oracle, so a
// refusal re-reads them and retries; anything still failing falls back to the
// stock probing path rather than dropping the call.
const termsURL = new URL('/.well-known/x402', UPSTREAM).toString()
let accepts = null
// A TICK IS QUOTED SEPARATELY. `accepts` prices one call; `tickAccepts` prices
// time, and its amount is the ceiling on a single tick rather than the price of
// one. It matters beyond correctness: a wallet funds a multiple of whatever it
// was quoted, so paying ticks against the per-call quote deposits enough line
// for about a second and the line then dies mid-work.
let tickAccepts = null
const loadTerms = async () => {
  const r = await fetch(termsURL)
  const j = await r.json()
  if (!Array.isArray(j.accepts) || !j.accepts.length) throw new Error('no accepts in well-known')
  accepts = { x402Version: j.x402Version ?? 1, accepts: j.accepts }
  tickAccepts = Array.isArray(j.tickAccepts) && j.tickAccepts.length
    ? { x402Version: j.x402Version ?? 1, accepts: j.tickAccepts }
    : accepts                                    // an upstream that does not sell time
  return accepts
}
try { await loadTerms(); log(`terms cached from ${termsURL} — paying without probing`) }
catch (e) { log(`could not cache terms (${e.message}); falling back to probe-then-pay`) }

// ONE PAYMENT AT A TIME, ON EVERYTHING -- not just on ticks.
//
// A voucher signs a cumulative TOTAL, so a channel carries exactly one payment
// in flight; a second one built against the same state comes back
// `cumulative_amount_mismatch`. Ticks were already serialized against each
// other, but not against a pay-per-call fallback, and the two paths share the
// channel. Measured: 1 call in 30 failed that way, at the moment a line was
// opening and a fallback payment was still settling.
let paymentQueue = Promise.resolve()
const oneAtATime = (fn) => {
  const run = paymentQueue.then(fn, fn)
  paymentQueue = run.then(() => {}, () => {})       // a failure must not poison the queue
  return run
}

// TELL THE SERVER BEFORE YOU START PAYING.
//
// Our top-up deposit happens here, inside the wallet, before the tick request is
// sent -- so from the server's side it is indistinguishable from a client that
// stopped paying. Measured at 2,914ms against a 5,000ms window: close enough to
// the edge that a burst of work can lose the line it is in the middle of
// funding, which then trips every other fallback.
const declarePaying = () => {
  try { if (line.socket?.readyState === 1) line.socket.send(JSON.stringify({ op: 'paying' })) } catch { }
}

const payFirst = (name, args) => oneAtATime(() => { declarePaying(); return payNow(name, args) })

// A REFUSED PAYMENT COMES BACK AS A RESULT, NOT AS A THROW.
//
// The retry below was written for exactly this and never once fired, because it
// only caught exceptions. Reproducible: a bridge with a fresh state directory,
// against a channel its wallet already has history on -- a lost state dir, or
// the same key on a second machine -- builds its first voucher from a cumulative
// of zero and is refused. Call #1 failed on every single run; call #2 onward
// worked, because the refusal itself carries the channel state the client needs.
//
// So the recovery the state dir comment promises does happen. It just used to
// cost the buyer their first call.
// PROBE EXACTLY ONCE, WHEN WE HAVE NO STATE.
//
// Paying on first contact is right when we know where the channel stands. On a
// cold start we do not, and cannot: a voucher signs a CUMULATIVE total, and
// `chargedCumulativeAmount` is not on the chain -- the escrow knows the balance
// and what has been claimed, not what has been metered. The only place that
// number exists is the seller's 402.
//
// So a bridge with a fresh state directory against a channel its wallet already
// has history on -- a lost state dir, the same key on a second machine -- signed
// its first voucher from zero and was refused, every single run. Retrying did
// not help and could not: the second attempt was built from the same nothing.
//
// One probe, once, when the state dir is empty. It costs a round trip on the
// first call of a cold start and buys correct state for every call after it.
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
      // PAY-FIRST HAS TO BE ABLE TO REPAIR ITSELF.
      //
      // A voucher signs a cumulative total, so paying without seeing a 402 is
      // only safe while our idea of that total is right. Let it drift -- state
      // dir from an older session, another client on the same key -- and every
      // pay-first call is refused forever, because nothing in the failed
      // exchange teaches us the true figure. Measured with X402_LINE=off against
      // a channel with history: 0 of 10 calls served, and it would never have
      // recovered on its own.
      //
      // The 402 is the only thing that carries the channel state, so a refusal
      // sends this call down the probing path -- which reads it, pays, and
      // leaves the client correct for everything after.
      if (explainPermit2(out)) return out
      if (refusedPayment(out)) {
        // Reprobing alone does not fix it. The client trusts its own record over
        // anything the 402 says, so a WRONG cumulative is stickier than a
        // missing one -- measured, the probe path failed identically, ten out of
        // ten. A record we know to be wrong is worth less than no record: drop
        // it, and the client rebuilds from the 402 and the chain the same way a
        // cold start does, which is a path that works.
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

// PERMIT2 NEEDS AN APPROVAL, AND THE REFUSAL DOES NOT SAY SO.
//
// USDT, DAI and WETH move through Permit2, which cannot touch your tokens until
// you have approved it as a spender. Without that, every call comes back
// permit2_allowance_required -- a condition with no cure attached. Tested from a
// cold wallet: three calls, three refusals, nothing to act on.
//
// We do NOT send it for you. @x402/evm ships createPermit2ApprovalTx, and it
// encodes max uint256; an unlimited standing approval is the opposite of what
// this bridge is careful about elsewhere, and the transaction is yours to sign
// and pay gas for -- the only gas anywhere in this flow. So: say exactly what to
// send, sized to what you are actually about to spend.
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

// A refused payment comes back as a RESULT, not as a throw. An earlier retry
// here only caught exceptions and so never once fired for the failure it was
// written for.
function refusedPayment(out) {
  if (!out?.isError) return false
  const body = String(out?.content?.[0]?.text ?? '')
  return /x402Version/.test(body) && /"error"\s*:\s*"(invalid_|insufficient_|cumulative_)/.test(body)
}
log(`channel state in ${stateDir}`)

// ---- THE LINE -------------------------------------------------------------
//
// The upstream sells TIME, not calls: hold a socket open, pay for the
// milliseconds, and every tool call rides it free. Until now this bridge could
// not do that -- it paid per call, which is the fallback, not the product. The
// only client we shipped could not buy the thing we advertise.
//
// AUTO by default, and auto is not a hedge. A line is cheaper than per-call
// pricing exactly while calls are flowing and more expensive while they are not,
// so we open one on the first call, hold it while work continues, and let it
// lapse when the work stops. Set X402_LINE=off for per-call only, or =on to hold
// a line from startup and keep paying whether or not anyone calls.
const LINE_MODE = (process.env.X402_LINE ?? 'auto').toLowerCase()
const line = { credential: null, socket: null, timer: null, tickMs: 250, lastUse: 0, opening: null }

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

// One tick: an ordinary paid call that buys the milliseconds since the last one.
// It is the only thing on a line that costs anything.
//
// NEVER TWO AT ONCE. A voucher signs a cumulative total, so a channel carries
// exactly one payment at a time and a second tick sent while the first is still
// in flight comes back `channel_busy` -- which then reads as a tick failure and
// tears down a perfectly good line. Ticks are 250ms apart and a signed round
// trip can take longer than that, so this is the normal case, not an edge one.
let ticking = false
const tick = async () => {
  if (capReached) return dropLine('spend cap reached')
  if (!line.credential || ticking) return
  ticking = true
  try {
    const out = await payFirst('tick', { line: line.credential })
    // A TICK THAT BOUGHT NOTHING IS NOT A TICK. It used to come back looking
    // like a success, so the bridge went on believing it was paying for a line
    // that had already closed -- 41 tick "successes" while every service call
    // was refused. Read the answer, not the absence of an exception.
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
        log(`line open — ${m.microUSDPerMs ?? 1} micro-USD/ms, collateral buys ${m.buysMs ?? '?'}ms`)
        // PAY BEFORE ANY CALL GOES OUT. A line serves nothing until a tick has
        // settled on it, so resolving the credential first means the call that
        // triggered the open races its own first payment and is refused. We
        // resolve after the tick lands, not before.
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

const server = new Server({ name: NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await upstream.listTools()
  return { tools }
})
// A call on the line carries the credential and no payment at all -- that is the
// whole saving. If the line is not up, the call still goes through and pays for
// itself, so nothing here can turn a billing problem into a failed call.
const callOnLine = async (name, args) => {
  // The cap is refused here rather than deeper down, so it holds for every path:
  // line, per-call and cold start alike. It is the buyer's own limit, so say so
  // in the answer instead of failing in a way that reads like the seller's fault.
  if (capReached) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: 'x402_bridge_spend_cap_reached',
      spentMicroUSD, capMicroUSD: MAX_SPEND,
      message: 'This bridge has spent its X402_MAX_SPEND ceiling and will not pay for more. ' +
        'Raise it, set X402_MAX_SPEND=0 to remove it, or restart the bridge.' }) }] }
  }
  line.lastUse = Date.now()
  if (LINE_MODE === 'off') return payFirst(name, args)

  // THE FIRST CALL ESTABLISHES THE CHANNEL AND PAYS ITS OWN PRICE.
  //
  // It used to be a `tick` sent on the customer's behalf, on the reasoning that
  // a tick matching no line is charged nothing. Two things were wrong with that.
  // A settlement of zero never submits the deposit riding with it, so the
  // channel was created holding nothing; and once that was fixed, the opening
  // payment is billed at the tool's own quote, and a tick is quoted at its
  // 60,000 ceiling -- $0.06 to open an account.
  //
  // An ordinary call is quoted at 250, so it opens the channel for a quarter of
  // a cent and deposits against that. The first tick on the line then tops the
  // channel up to a useful runway, and top-ups are metered on time like every
  // other tick rather than charged at the quote.
  if (!channelId) return payFirst(name, args)

  // A DEAD LINE MEANS REOPEN IT, NOT PAY PER CALL.
  //
  // Falling straight through to a per-call payment was the expensive half of the
  // outage: a line closing under a burst turned every in-flight call into its
  // own signed payment, serialised behind one channel, and when those ran out of
  // road they became unpaid requests that burned the hourly ceiling. The line is
  // the cheap path; losing it is a reason to get another one.
  //
  // Per-call payment is the last resort it was always meant to be.
  for (const attempt of [1, 2]) {
    if (!line.credential) await openLine()
    if (!line.credential) break
    const out = await upstream.callTool(name, { ...args, line: line.credential })
    if (!lineWasRefused(out)) return out
    // SAY WHAT THE SERVER SAID. It names the reason -- "line is out of collateral:
    // owed 803, 750 micro-USD behind it -- deposit more" -- and this used to throw
    // that away and log "refused by the server" instead.
    //
    // An outside auditor set the deposit multiplier to 3, the protocol minimum,
    // which buys 750 micro-USD of collateral: 750ms of line. Their line died
    // immediately, twice, and they were told nothing. They filed it as
    // "occasional line-open flakiness" and paid per call for a burst of 25 calls,
    // which costs more than the line would have. Reproduced exactly, and the
    // server's own log named the cause both times.
    dropLine(reasonFrom(out) ?? 'refused by the server')
    if (attempt === 2) {
      log('the line was refused twice; paying for this call directly. If the reason above ' +
        'is collateral, raise X402_DEPOSIT_MULTIPLIER — the minimum of 3 buys under a second of line.')
    }
  }
  return payFirst(name, args)
}

// DOES THIS REFUSAL MEAN THE LINE IS GONE?
//
// The server refuses off-line calls in-band rather than by throwing, so this is
// the only thing standing between a dead line and a total outage. It got both
// halves wrong and an outside buyer paid for it: 3 of 12 concurrent calls and 23
// of 40 sequential ones served, then every call falling back to an unpaid
// request, burning the 60/hr unpaid ceiling and 429-ing a funded wallet with a
// live channel off the endpoint entirely.
//
//   1. It matched `unknown_line|line_unpaid` and NOT `line_closed` -- which is
//      exactly what the server returns after a rotate or an idle close, i.e.
//      the two ordinary ways a line ends.
//   2. It required out.isError, and a dead line's tick was coming back with
//      isError unset. Both had to be fixed; either alone leaves the outage.
//
// So: match on the CODE, and do not depend on isError being set. A code we do
// not recognise is not treated as a dead line -- a tool's own error must not
// silently start costing per-call payments.
// The server sets `lineGone: true` on every refusal that means "reopen the
// line", which is the field to branch on. The code list is kept as a fallback
// for an upstream that predates it -- and it now includes line_closed, the
// ordinary result of a rotate or an idle close.
const LINE_IS_GONE = /"lineGone"\s*:\s*true|"(?:error|code)"\s*:\s*"(?:unknown_line|line_unpaid|line_closed)"/
const lineWasRefused = (out) => LINE_IS_GONE.test(String(out?.content?.[0]?.text ?? ''))

// The refusal body carries the server's own words. Pull them out rather than
// discarding them: "why" when it has one, else the error/code, so a buyer sees
// what to do about it.
const reasonFrom = (out) => {
  try {
    const body = JSON.parse(String(out?.content?.[0]?.text ?? ''))
    const why = body.why ?? body.message ?? body.error ?? body.code
    return typeof why === 'string' && why ? why.slice(0, 160) : null
  } catch { return null }
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // POSITIONAL. The payment wrapper has its own signature, and the object form
  // throws "expected string, received object at params.name" -- which reads as
  // the server's schema being broken when it is the wrapper's calling
  // convention.
  const out = await callOnLine(req.params.name, req.params.arguments ?? {})
  return out
})

// STOP THE METER ON THE WAY OUT -- INCLUDING WHEN NOBODY TELLS US TO GO.
//
// A signal only helps if it reaches us, and the advertised install line is
// `npx -y <url>`, where npx is a wrapper process. A client that kills its child
// kills npx; this process keeps running, keeps holding a paid line, and keeps
// topping up. Measured by an outside auditor: two orphaned bridges still paying
// 13 and 7 minutes after the client that started them had gone, depositing every
// ~100 seconds, $0.30 of their money spent while nothing of theirs was running.
//
// X402_LINE=auto lapses an unused line after four tick intervals, so it mostly
// self-limits. X402_LINE=on does not, by design -- it exists to hold a line
// whether or not anyone calls -- so in that mode an orphan bills until the wallet
// is empty.
//
// A stdio server's parent going away closes our stdin. That signal arrives
// whether we were killed politely, killed rudely, or simply forgotten, so it is
// the one to trust.
// The one-shot paths need to stop the meter and RETURN, so they can print an
// answer and set an exit code. stopPaying() exits the process itself, which is
// right for a signal and wrong here.
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

// ONE-SHOT MODE, FOR THE BUYER THAT IS A SHELL AND NOT A DESKTOP APP.
//
// Until now the only way to spend money through this bridge was to speak MCP to
// it over stdio, and the only thing we documented was a JSON config block for a
// GUI client. A cold agent with a funded wallet -- the customer this whole
// endpoint is built for -- had to WRITE AN MCP CLIENT before it could buy
// anything, and our own docs forbid hand-rolling the payment, so it had no other
// path. It wrote 45 lines of driver and said so.
//
// The refund was worse: {op:"refund"} needs a line that has paid a tick, this
// bridge holds the line internally and never exposes the credential, so of the
// four exits the terms advertise, the two cheap ones were unreachable from our
// own client. A buyer could only leave by paying its own gas.
//
// So: argv. `--call <tool> <json>` pays for one call and prints the answer.
// `--refund` uses the line it is already holding to ask for the collateral back.
// Same payment path as the MCP mode -- callOnLine -- so there is one code path
// that spends money, not two.
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? '') }
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  process.stdout.write([
    'x402-mcp-bridge — pay for MCP tools with a wallet.',
    '',
    '  With your key exported as X402_PRIVATE_KEY:',
    '',
    '    npx -y <this tarball> --call rpc \'{"chain":"base","method":"eth_blockNumber","params":[]}\'',
    '    npx -y <this tarball> --tools',
    '',
    'With no arguments it runs as an MCP stdio server, which is what an MCP client wants.',
    '',
    'Env: X402_PRIVATE_KEY (required), X402_UPSTREAM, X402_MAX_SPEND (micro-USD, 0 = no cap),',
    '     X402_DEPOSIT_MULTIPLIER (default 400 → 400 × 250 = 100000 micro-USD = $0.10 of',
    '     refundable collateral), X402_LINE=auto|on|off, X402_SALT.',
    '',
  ].join('\n'))
  process.exit(0)
}

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
  // ASK ON THE LINE WE ARE ALREADY HOLDING. The socket refuses a refund until
  // the line has paid a tick -- "that is what proves this channel is yours" --
  // and openLine() pays one before it resolves, so by here we have standing.
  if (!channelId) { process.stderr.write('no channel to refund — nothing has been bought with this key and salt\n'); process.exit(2) }
  // PAY ONE TICK FIRST, WHICH IS WHAT PROVES THE CHANNEL IS OURS.
  //
  // The socket refuses to open a line on a channel the server has no record of
  // -- "unknown channel — deposit first" -- and a channel opened by a per-call
  // payment is exactly that case: the first paid call creates the channel on
  // chain and never touches the line socket, so the server has nothing to open
  // against. The refund then cannot prove standing and fails, which is how the
  // cheap exit stayed unreachable.
  //
  // A tick is an ordinary paid call and it is the server's own stated remedy:
  // "pay a tick first — that is what proves this channel is yours."
  await openLine()
  if (!line.socket) {
    log('no line yet — paying one tick to prove this channel is ours, then asking for the refund')
    try { await payFirst('tick', {}) } catch (e) { log(`tick failed: ${e.message}`) }
    await openLine()
  }
  if (!line.socket) {
    // SAY WHAT ACTUALLY WORKS INSTEAD OF FAILING BLANK.
    //
    // The socket will not open a line on a channel it has no record of, and a
    // channel created by a per-call payment is exactly that -- the first paid
    // call makes the channel on chain without ever touching the line socket. So
    // {op:"refund"} cannot prove standing here. This is unfinished, and pointing
    // at the exit that DOES work is worth more than a bare failure.
    process.stderr.write([
      'This channel has no line the server recognises, so {op:"refund"} cannot prove it is yours.',
      'That is our gap, not yours, and it is why --refund is not advertised in --help yet.',
      '',
      'The exit that always works needs nothing from us:',
      '  initiateWithdraw(config, amount)   then, after the delay, finalizeWithdraw(config)',
      'Since 2026-08-25 we also watch for that first call and return the collateral within',
      'about thirty seconds, so in practice you should not have to wait the delay out.',
      'Your unspent collateral is safe either way: the escrow gates withdrawal to you alone.',
      '',
    ].join('\n'))
    process.exit(1)
  }
  // KEEP THE LINE ALIVE WHILE WE WAIT FOR THE ANSWER.
  //
  // The idle rule drops a line after four tick intervals of no USE, and waiting
  // on a socket reply is not a use -- so the first version of this opened a
  // line, asked for a refund, and idle-closed the socket a second later, before
  // the server had answered. It reported "no answer in 30s", which reads as the
  // server ignoring a refund request when in fact we hung up on it.
  const keepWarm = setInterval(() => { line.lastUse = Date.now() }, 200)
  const answer = await new Promise((resolve) => {
    const done = setTimeout(() => resolve({ error: 'no answer in 30s' }), 30_000)
    line.socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(String(ev.data)) } catch { return }
      if (m.op === 'refunded' || m.op === 'refund_failed' || m.error) { clearTimeout(done); resolve(m) }
    })
    try { line.socket.send(JSON.stringify({ op: 'refund' })) }
    catch (e) { clearTimeout(done); resolve({ error: e.message }) }
  })
  clearInterval(keepWarm)
  process.stdout.write(JSON.stringify(answer, null, 2) + '\n')
  await stopPayingQuietly()
  process.exit(answer.op === 'refunded' ? 0 : 1)
}

await server.connect(new StdioServerTransport())
if (LINE_MODE === 'on' && channelId) await openLine()
log(`bridge up on stdio — line mode ${LINE_MODE}${channelId ? '' : ' (channel opens on your first call)'}` +
  ` | spend cap ${MAX_SPEND ? MAX_SPEND + ' micro-USD' : 'NONE (X402_MAX_SPEND=0)'}` +
  ' | stops when stdin closes')
