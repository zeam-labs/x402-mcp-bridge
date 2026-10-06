#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { wrapMCPClientWithPayment } from '@x402/mcp'
import { paymentsFor, selectorFor, paymentRefused, floorStrategy, learnFloor } from './client.mjs'
import { toClientEvmSigner } from '@x402/evm'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, fallback, keccak256, toHex, getAddress } from 'viem'
import { passRefund, rebaseChannel, sendSignedRefund, refundUrlBeside, refundUrlInTerms, readSeller, rememberRefundUrl, hearingMcp, withGrant } from './refund.mjs'
import { LINE_META, PRICE_META, LINE_GONE, lineUrlOf, lineUrlBeside, timeOf, timeFromTerms, isTimeTag, bodyOf, codeOf, meterOf, timeTerms, buyFor, askedMicro, MIN_BUY_MS, openLine, lineOp } from './line.mjs'
import { FETCH_TOOL, makeFetchTool } from './fetch.mjs'
import * as chains from 'viem/chains'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const UPSTREAM =
  process.env.X402_MCP_URL ?? process.env.X402_UPSTREAM ?? 'https://mcp.zeamprism.com/mcp'
const KEY = process.env.X402_PRIVATE_KEY ?? process.env.PRISM_PRIVATE_KEY
const NETWORK = process.env.X402_NETWORK ?? 'eip155:8453'
const WANT = (process.env.X402_ASSET ?? '').toLowerCase()
const NAME = process.env.X402_NAME ?? 'x402-bridge'
const GRANT = process.env.X402_GRANT || null
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const log = (...a) => console.error('[x402-bridge]', ...a)

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : (argv[i + 1] ?? '') }
const has = (name) => argv.includes(name)

if (has('--help') || has('-h')) {
  process.stdout.write([
    `x402-mcp-bridge ${VERSION} — pay for MCP tools with a wallet.`,
    '',
    '  With your key exported as X402_PRIVATE_KEY:',
    '',
    '    npx -y @zeam-labs/x402-mcp-bridge --call call_rpc \'{"chain":"base","method":"eth_blockNumber","params":[]}\'',
    '    npx -y @zeam-labs/x402-mcp-bridge --tools',
    '    npx -y @zeam-labs/x402-mcp-bridge --call x402_fetch \'{"url":"https://…","pay":false}\'',
    '    npx -y @zeam-labs/x402-mcp-bridge --refund',
    '',
    'With no arguments it runs as an MCP stdio server.',
    '',
    'Env: X402_PRIVATE_KEY, X402_MCP_URL, X402_LINE=auto|on|off, X402_MAX_SPEND (micro-USD, 0 = no cap),',
    '     X402_DEPOSIT_MULTIPLIER (default 40, minimum 3), X402_LINE_AHEAD_MS (default 2000),',
    '     X402_GRANT, X402_SALT, X402_ASSET, X402_RPC_URL, X402_STATE_DIR.',
    '',
    '  --refund            the seller sends back the unspent balance and the unburned line time.',
    '  --refund --self-send  a signed refund, sent from this key at its own gas.',
    '',
  ].join('\n'))
  process.exit(0)
}

const KEYLESS = !KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)
if (KEYLESS && (has('--call') || has('--refund'))) {
  log('set X402_PRIVATE_KEY to a 0x-prefixed 32-byte key. It stays on this machine;')
  log('it signs payment vouchers locally and is never sent anywhere.')
  process.exit(1)
}
if (KEYLESS) log('no key: serving the catalog and the free tools; a paid call returns the quote, which says what a key needs')
const account = KEYLESS ? null : privateKeyToAccount(KEY)
const chainId = Number(String(NETWORK).split(':')[1])
const chain = Object.values(chains).find((c) => c?.id === chainId)
if (!chain) { log(`unknown network ${NETWORK}`); process.exit(1) }

const stateDir = KEYLESS ? mkdtempSync(join(tmpdir(), 'x402-keyless-')) : process.env.X402_STATE_DIR ??
  join(homedir(), '.x402-mcp-bridge', new URL(UPSTREAM).host, account.address.toLowerCase())
mkdirSync(stateDir, { recursive: true })

const readers = [
  ...(process.env.X402_RPC_URL ? [process.env.X402_RPC_URL] : []),
  ...(chain.rpcUrls?.default?.http ?? []),
  new URL('/verify', UPSTREAM).toString(),
]
const pub = createPublicClient({ chain, transport: fallback(readers.map(u => http(u))) })
log(`chain reads: ${readers.map(u => new URL(u).host).join(' -> ')}` +
  (process.env.X402_RPC_URL ? '' : '  (set X402_RPC_URL to put your own node first)'))

let chosenAccept = null
const selector = selectorFor(WANT, (a) => { chosenAccept = a }, log)

const storage = new FileClientChannelStorage({ directory: stateDir })
let channelId = null
const watchedStorage = {
  get: (k) => storage.get(k),
  delete: (k) => storage.delete(k),
  set: (k, ctx) => { channelId = k; noteBilled(ctx); return storage.set(k, ctx) },
}
try {
  const f = readdirSync(join(stateDir, 'client')).find((n) => n.endsWith('.json'))
  if (f) channelId = f.replace(/\.json$/, '')
} catch {}

const depositPolicy = { depositMultiplier: Number(process.env.X402_DEPOSIT_MULTIPLIER ?? 40) }
const floor = { micro: 0 }

const MAX_SPEND = Number(process.env.X402_MAX_SPEND ?? 10_000_000)
let capReached = false
let startedAt = null
let spentMicroUSD = 0
let quoteMicroUSD = null
let spendUnit = 'micro-USD'

const quoteFromTerms = (j) => {
  for (const c of [j?.rate?.deposit?.tickQuoteMicroUSD, j?.rate?.tickQuoteMicroUSD,
                   j?.rate?.microUSDPerCall, j?.rate?.microUSDPerBlock, j?.quoteMicroUSD]) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

const microUSDOf = (units) => {
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
  } catch {}
  if (!MAX_SPEND || capReached || spentMicroUSD < MAX_SPEND) return
  capReached = true
  log(`SPEND CAP REACHED — this run has spent ${spentMicroUSD} ${spendUnit} against a cap of ` +
    `${MAX_SPEND}. Paying for nothing further. Raise or remove it with X402_MAX_SPEND.`)
  letGo('spend cap reached')
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
      `this key spends ${CARD_PAYER}'s channel but cannot add funds to it — it is a ` +
      'spending key, not that wallet\'s key. Top up from the wallet that owns the channel.')
  },
} : null

if (CARD_PAYER && account) {
  log(`spending ${CARD_PAYER}'s channel, authorized as ${account.address}`)
  log('this key can spend that channel and return it; it cannot move the money elsewhere')
}

const payments = KEYLESS ? null : paymentsFor({ signer: cardSigner ?? account, pub, network: NETWORK, selector, batch: {
    depositPolicy,
    depositStrategy: floorStrategy(floor),
    storage: watchedStorage,
    ...(CARD_PAYER ? { payerAuthorizer: account.address, voucherSigner: toClientEvmSigner(account, pub) } : {}),
    ...(process.env.X402_SALT ? { salt: saltOf(process.env.X402_SALT) } : {}),
  } })

const net = withGrant(fetch, GRANT)
const termsURL = new URL('/.well-known/x402', UPSTREAM).toString()

const seller = { time: null, lineUrl: null, refund: readSeller(stateDir).refund ?? null, tags: null }
const learnTerms = (t) => {
  if (!t || typeof t !== 'object') return
  learnFloor(floor, t)
  seller.time ??= timeFromTerms(t)
  seller.lineUrl ??= lineUrlOf(t)
  const r = refundUrlInTerms(t)
  if (r && !seller.refund) { seller.refund = r; rememberRefundUrl(stateDir, r) }
}

if (has('--refund')) {
  if (!channelId) { process.stderr.write('no channel to refund — nothing has been bought with this key and salt\n'); process.exit(2) }
  const selfSend = has('--self-send')
  if (!seller.refund) {
    try { learnTerms(await (await net(termsURL, { signal: AbortSignal.timeout(10_000) })).json()) } catch {}
  }
  const url = seller.refund ?? refundUrlBeside(UPSTREAM)
  log(`asking for the refund at ${url}`)
  let answer = await passRefund({ url, channelId, signer: account, payer: CARD_PAYER ? null : account, selfSend, fetchFn: net, log })
  if (answer.op === 'refund_signed') {
    const wallet = createWalletClient({ account, chain, transport: http(process.env.X402_RPC_URL ?? chain.rpcUrls.default.http[0]) })
    answer = await sendSignedRefund({ answer, account, pub, wallet, storage, channelId, log }).catch((e) => ({ ...answer, sent: false, why: `${answer.why ?? ''} Could not send it from here: ${e?.shortMessage ?? e?.message}`.trim() }))
  }
  if (answer.op === 'refunded' && answer.channelState && answer.gasPaidBy !== 'you') {
    try {
      if (await rebaseChannel(storage, channelId, answer.channelState)) log(`channel rebased to ${answer.channelState.chargedCumulativeAmount} charged after the refund`)
    } catch (e) { log(`could not rebase the channel after the refund: ${e.message}`) }
  }
  process.stdout.write(JSON.stringify(answer, null, 2) + '\n')
  if (answer.op === 'refunded') {
    if (answer.returnedMicroUSD !== undefined) log(`returned ${answer.returnedMicroUSD} micro-USD, gas ${answer.gasMicroUSD ?? 0} micro-USD${answer.gasPaidBy === 'you' ? ' paid in ETH by this key' : ''}${answer.timeReturnedMs ? `, ${answer.timeReturnedMs} ms of unburned line time included` : ''}`)
    process.exit(0)
  }
  if (answer.code === 'nothing_to_return') {
    const left = Number(answer.leftMicroUSD ?? 0)
    log(left > 0
      ? `nothing comes back: ${left} micro-USD is left and sending it costs ${answer.gasMicroUSD ?? '?'} micro-USD of gas. --refund --self-send gets a signed refund of all of it to send at your own gas.`
      : 'nothing comes back: this channel is fully spent')
    process.exit(left > 0 ? 1 : 0)
  }
  if (answer.op === 'refund_signed') {
    log('the refund is signed and yours to send: any wallet on Base can send the transaction above')
    process.exit(1)
  }
  process.stderr.write([
    '',
    'The exit that always works needs nothing from the seller:',
    '  initiateWithdraw(config, amount)   then, after the delay, finalizeWithdraw(config)',
    'The escrow gates withdrawal to you alone, so your unspent collateral is safe either way.',
    '',
  ].join('\n'))
  process.exit(1)
}

const plain = new Client({ name: NAME, version: VERSION })
const heard = new AsyncLocalStorage()
const rawCallTool = plain.callTool.bind(plain)
plain.callTool = async (...a) => {
  const r = await rawCallTool(...a)
  const s = heard.getStore()
  if (s) s.raw = r
  return r
}
const whole = async (fn) => {
  const s = { raw: null }
  const out = await heard.run(s, fn)
  if (!s.raw || !out) return out
  return { ...s.raw, isError: out.isError ?? s.raw.isError }
}

const upstream = KEYLESS
  ? { connect: (t) => plain.connect(t), listTools: () => plain.listTools(),
      callTool: (name, args) => plain.callTool({ name, arguments: args ?? {} }) }
  : wrapMCPClientWithPayment(plain, payments, { autoPayment: true })
const callFree = (name, args) => whole(() => upstream.callTool(name, args))
const callPaid = (name, args, payload) => whole(() => upstream.callToolWithPayment(name, args, payload))
const callOnLineRaw = (name, args, credential) => plain.callTool({ name, arguments: args, _meta: { [LINE_META]: credential } })

const hearing = hearingMcp(net, (u) => { seller.refund = u; rememberRefundUrl(stateDir, u) }, learnTerms)
await upstream.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM), { fetch: hearing }))
log(KEYLESS ? `catalog from ${UPSTREAM}, paying nothing` : `paying as ${account.address} -> ${UPSTREAM}`)

let accepts = null
let tickAccepts = null
const loadTerms = async () => {
  const r = await net(termsURL, { signal: AbortSignal.timeout(10_000) })
  const j = await r.json()
  if (!Array.isArray(j.accepts) || !j.accepts.length) throw new Error('no accepts in well-known')
  learnTerms(j)
  accepts = { x402Version: j.x402Version ?? 1, accepts: j.accepts }
  tickAccepts = Array.isArray(j.tickAccepts) && j.tickAccepts.length
    ? { x402Version: j.x402Version ?? 1, accepts: j.tickAccepts }
    : accepts
  const q = quoteFromTerms(j)
  if (q !== null) {
    if (q !== quoteMicroUSD) log(`quote: ${q} micro-USD per call, from the seller's own terms`)
    quoteMicroUSD = q; spendUnit = 'micro-USD'
  } else if (quoteMicroUSD === null) {
    spendUnit = 'base units of the paid asset'
    log('quote: this server publishes no micro-USD price, so X402_MAX_SPEND is read as base units of the asset, not dollars.')
  }
  return accepts
}
try { await loadTerms(); log(`terms cached from ${termsURL} — paying without probing`) }
catch (e) { log(`could not cache terms (${e.message}); paying on the seller's 402`) }

const learnTools = (tools) => {
  seller.tags = new Map(tools.map((t) => [t.name, t._meta?.[PRICE_META] ?? null]))
  seller.time ??= timeOf(seller.tags.get('buy_time'))
}
const tagOf = async (name) => {
  if (!seller.tags) { try { learnTools((await upstream.listTools()).tools) } catch { seller.tags = new Map() } }
  return seller.tags.get(name) ?? null
}

let paymentQueue = Promise.resolve()
const oneAtATime = (fn) => {
  const run = paymentQueue.then(fn, fn)
  paymentQueue = run.then(() => {}, () => {})
  return run
}
const payFirst = (name, args) => oneAtATime(() => payNow(name, args))

let coldStart = !channelId
if (coldStart && !KEYLESS) log('no local channel state — probing once to learn where this channel stands')

const available = async () => {
  if (!channelId) return null
  try {
    const c = await storage.get(channelId)
    if (!c?.balance || c.chargedCumulativeAmount === undefined) return null
    return Number(BigInt(c.balance) - BigInt(c.chargedCumulativeAmount))
  } catch { return null }
}

const needsTopUp = async (terms) => {
  if (!terms?.accepts?.length) return false
  const left = await available()
  if (left === null) return false
  const asset = String(chosenAccept?.asset ?? '').toLowerCase()
  const row = terms.accepts.find(r => String(r.asset ?? '').toLowerCase() === asset) ?? terms.accepts[0]
  return BigInt(left) < BigInt(row.amount ?? 0)
}

const payNow = async (name, args) => {
  if (KEYLESS) return callFree(name, args)
  if (coldStart) {
    coldStart = false
    const out = await callFree(name, args)
    if (codeOf(out) !== 'funding_requires_open_fee' || !learnFloor(floor, bodyOf(out))) return out
    log(`the seller's deposit floor is ${floor.micro} micro-USD: depositing that`)
    return callFree(name, args)
  }
  const buying = name === 'buy_time'
  if (buying && !seller.time) await tagOf('buy_time')
  const buyMicro = buying ? askedMicro(seller.time, args, Number(tickAccepts?.accepts?.[0]?.amount)) : null
  let terms = buying ? timeTerms(tickAccepts, buyMicro) : accepts
  let funding = !buying
  if (buying && await needsTopUp(terms)) {
    log('the collateral is below this purchase: it carries a deposit on the funding row')
    terms = timeTerms(accepts, buyMicro)
    funding = true
  }
  if (!terms) return callFree(name, args)
  for (const attempt of [1, 2]) {
    try {
      const payload = await payments.createPaymentPayload(terms)
      const out = await callPaid(name, args, payload)
      const code = codeOf(out)
      if (code === 'funding_requires_open_fee') {
        const raised = learnFloor(floor, bodyOf(out))
        if (raised || !funding) {
          log(raised ? `the seller's deposit floor is ${floor.micro} micro-USD: depositing that` : 'the seller wants this deposit on the funding row')
          if (buying) terms = timeTerms(accepts, buyMicro)
          funding = true
          continue
        }
      }
      if (explainPermit2(out)) return out
      if (paymentRefused(out)) {
        log('payment refused as stale — dropping the local channel record and resyncing')
        if (channelId) { try { await watchedStorage.delete(channelId) } catch {} }
        return callFree(name, args)
      }
      return out
    } catch (e) {
      if (attempt === 2) { log(`pay-first failed twice (${e.message}); paying on the seller's 402`); return callFree(name, args) }
      try { await loadTerms() } catch {}
    }
  }
}

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
let approvalToldFor = null
const explainPermit2 = (out) => {
  if (!/permit2_allowance_required/.test(String(codeOf(out) ?? ''))) return false
  const token = chosenAccept?.asset
  if (!token || approvalToldFor === token) return true
  approvalToldFor = token
  const per = Number(chosenAccept?.amount ?? 0)
  const suggested = per > 0 ? BigInt(Math.ceil(per * depositPolicy.depositMultiplier * 4)) : 0n
  log(`${token} moves through Permit2 and your wallet has not approved it.`)
  log(`  send once, from your wallet:  approve(${PERMIT2}, ${suggested || '<amount>'})  on ${token}`)
  return true
}

if (!KEYLESS) log(`channel state in ${stateDir}`)

const LINE_MODE = (process.env.X402_LINE ?? 'auto').toLowerCase()
const AUTO_FAST_RUN = Number(process.env.X402_AUTO_FAST_RUN ?? 2)
const AUTO_GAP_MS = Number(process.env.X402_AUTO_GAP_MS ?? 10_000)
const AHEAD_MS = Number(process.env.X402_LINE_AHEAD_MS ?? 2000)
const IDLE_MS = Number(process.env.X402_LINE_IDLE_MS ?? 1000)

const line = { credential: null, msRemaining: 0, metering: false, opening: null, offTimer: null, buys: 0 }
const rate = { lastCallAt: 0, run: 0 }
const lineUrl = () => seller.lineUrl ?? lineUrlBeside(UPSTREAM)

const callsKeepComing = () => {
  const now = Date.now()
  const gap = rate.lastCallAt ? now - rate.lastCallAt : Infinity
  rate.lastCallAt = now
  rate.run = gap <= AUTO_GAP_MS ? rate.run + 1 : 1
  return rate.run >= AUTO_FAST_RUN
}

const dropLine = (why) => {
  if (line.offTimer) { clearTimeout(line.offTimer); line.offTimer = null }
  const credential = line.credential
  if (credential) log(`line let go (${why})`)
  line.credential = null
  line.metering = false
  return credential
}

const letGo = async (why) => {
  const credential = dropLine(why)
  if (!credential) return
  await lineOp({ url: lineUrl(), op: 'off', credential, fetchFn: net }).catch(() => {})
  await lineOp({ url: lineUrl(), op: 'close', credential, fetchFn: net }).catch(() => {})
}

const touch = () => {
  if (line.offTimer) clearTimeout(line.offTimer)
  line.offTimer = setTimeout(() => {
    line.offTimer = null
    if (!line.credential || !line.metering) return
    line.metering = false
    lineOp({ url: lineUrl(), op: 'off', credential: line.credential, fetchFn: net })
      .then((a) => { if (a.op === 'off') log(`meter off after ${IDLE_MS} ms idle; ${a.msRemaining ?? line.msRemaining} ms held`) })
      .catch(() => {})
  }, IDLE_MS)
  line.offTimer.unref?.()
}

const holdLine = () => {
  if (line.credential) return Promise.resolve(true)
  if (line.opening) return line.opening
  if (!channelId || KEYLESS) return Promise.resolve(false)
  line.opening = (async () => {
    const o = await openLine({ url: lineUrl(), channelId, signer: account, fetchFn: net })
    if (o.op !== 'opened') { log(`line not opened: ${o.code}${o.why ? ` (${o.why})` : ''}`); return false }
    line.credential = o.credential
    line.metering = o.metering !== false
    line.msRemaining = Number(o.msRemaining ?? 0)
    log(`line open at ${lineUrl()}: ${line.msRemaining} ms on the meter`)
    return true
  })().finally(() => { line.opening = null })
  return line.opening
}

const meterOn = async () => {
  if (line.metering) return true
  const a = await lineOp({ url: lineUrl(), op: 'on', credential: line.credential, fetchFn: net })
  if (a.op === 'on') { line.metering = true; line.msRemaining = Number(a.msRemaining ?? line.msRemaining); return true }
  if (LINE_GONE.has(a.code)) dropLine(a.code)
  return false
}

const buyTime = async (wantMs) => {
  if (!seller.time) await tagOf('buy_time')
  if (!seller.time) return false
  const buy = buyFor({ wantMs, time: seller.time, availableMicro: await available() })
  const out = await payFirst('buy_time', buy.args)
  const b = bodyOf(out)
  if (out?.isError || !b) { log(`buy_time: ${codeOf(out) ?? reasonFrom(out) ?? 'no answer'}`); return false }
  line.buys += 1
  if (Number.isFinite(Number(b.msRemaining))) line.msRemaining = Number(b.msRemaining)
  log(`bought ${b.boughtMs ?? buy.ms} ms of line time for ${buy.micro} micro-USD; ${line.msRemaining} ms on the meter`)
  return true
}

const ride = async (name, args, needMs = 0) => {
  let out = null
  let want = Math.max(AHEAD_MS, Math.ceil(needMs * 1.25))
  let need = needMs > 0 ? want : MIN_BUY_MS
  for (let attempt = 0; attempt < 4; attempt++) {
    if (capReached) break
    if (!(await holdLine())) return null
    if (!(await meterOn())) { if (!line.credential) continue; return null }
    if (line.msRemaining < need && !(await buyTime(Math.max(MIN_BUY_MS, want - line.msRemaining)))) return null
    out = await callOnLineRaw(name, args, line.credential)
    const m = meterOf(out)
    if (m && Number.isFinite(Number(m.msRemaining))) line.msRemaining = Number(m.msRemaining)
    const code = codeOf(out)
    const cut = code ? null : bodyOf(out)
    if (cut?.error === 'out_of_time' && Number(cut.needsMs) > 0 && attempt === 0) {
      const ran = Number(m?.elapsedMs)
      want = Math.ceil(((Number.isFinite(ran) && ran > 0 ? ran : want) + Number(cut.needsMs)) * 1.25)
      need = want
      log(`${name} was cut with about ${cut.needsMs} ms still to run; buying up to ${want} ms and calling it again`)
      continue
    }
    if (code === 'meter_off') { line.metering = false; continue }
    if (code === 'out_of_time') {
      line.msRemaining = Number(bodyOf(out)?.msRemaining ?? 0)
      want *= 2
      log(`the line ran out of time on ${name}; buying ${want} ms and calling again`)
      continue
    }
    if (code && LINE_GONE.has(code)) { dropLine(code); continue }
    touch()
    return out
  }
  return out
}

const reasonFrom = (out) => {
  const body = bodyOf(out)
  const why = body?.why ?? body?.message ?? body?.error ?? body?.code
  return typeof why === 'string' && why ? why.slice(0, 160) : null
}

const capAnswer = () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({
  error: 'x402_bridge_spend_cap_reached',
  spentMicroUSD, capMicroUSD: MAX_SPEND,
  message: 'This bridge has spent its X402_MAX_SPEND ceiling and will not pay for more. ' +
    'Raise it, set X402_MAX_SPEND=0 to remove it, or restart the bridge.' }) }] })

let fetchSpent = 0
const fetchTool = KEYLESS || cardSigner ? null : makeFetchTool({ signer: account, pub, network: NETWORK, grant: GRANT, log, budget: {
  allows: (units) => !MAX_SPEND || spentMicroUSD + fetchSpent + units <= MAX_SPEND,
  spend: (units) => { fetchSpent += units },
} })

const callTool = async (name, args) => {
  if (name === FETCH_TOOL.name && fetchTool) return fetchTool(args)
  if (capReached) return capAnswer()
  if (KEYLESS) return callFree(name, args)
  if (name === 'buy_time') {
    const out = await payFirst(name, args)
    const b = bodyOf(out)
    if (!out?.isError && Number.isFinite(Number(b?.msRemaining))) line.msRemaining = Number(b.msRemaining)
    return out
  }
  const tag = await tagOf(name)
  if (!isTimeTag(tag) || LINE_MODE === 'off') return payFirst(name, args)
  const fast = callsKeepComing()
  const worth = line.credential && line.msRemaining > 0 ? true : LINE_MODE === 'on' || fast
  if (worth && channelId) {
    const out = await ride(name, args)
    if (out) return out
  }
  const out = await payFirst(name, args)
  const code = codeOf(out)
  if ((code === 'out_of_time' || code === 'line_required') && channelId) {
    log(code === 'out_of_time' ? `${name} needs more than one block: calling it on a line` : 'the seller serves this channel on a line')
    const again = await ride(name, args, Number(bodyOf(out)?.needsMs) || 0)
    if (again) return again
  }
  return out
}

const told = typeof plain.getInstructions === 'function' ? plain.getInstructions() : null
const BRIDGE_NOTE = KEYLESS
  ? 'You are connected through the x402 Bridge with no wallet key: the free tools work, and a paid call returns the seller\'s terms.'
  : 'You are connected through the x402 Bridge. It pays for paid tools from the wallet it was started with, and buys line time when a tool needs longer: do not call buy_time or line yourself. To take back what is unspent, the person runs the bridge once with --refund. No payment steps are needed from you; the seller\'s payment instructions below are for clients without the Bridge.'
const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} }, instructions: told ? `${BRIDGE_NOTE}\n\n${told}` : BRIDGE_NOTE })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await upstream.listTools()
  learnTools(tools)
  return { tools: fetchTool && !tools.some((t) => t.name === FETCH_TOOL.name) ? [...tools, FETCH_TOOL] : tools }
})
server.setRequestHandler(CallToolRequestSchema, (req) => callTool(req.params.name, req.params.arguments ?? {}))

let leaving = false
const stopPaying = async (why) => {
  if (leaving) return
  leaving = true
  await Promise.race([letGo(why), new Promise((r) => setTimeout(r, 3000))])
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopPaying('shutting down'))
for (const ev of ['end', 'close']) {
  process.stdin.on(ev, () => stopPaying('stdin closed — whatever started us is gone'))
}
process.on('disconnect', () => stopPaying('parent disconnected'))

const finish = async (code) => {
  leaving = true
  await Promise.race([letGo('one-shot call finished'), new Promise((r) => setTimeout(r, 3000))])
  process.exit(code)
}

if (has('--tools')) {
  const out = await upstream.listTools()
  process.stdout.write(JSON.stringify(out.tools.map(t => t.name), null, 2) + '\n')
  await finish(0)
}

if (has('--call')) {
  const tool = flag('--call')
  if (!tool) { process.stderr.write('--call needs a tool name\n'); process.exit(2) }
  const rawArgs = argv[argv.indexOf('--call') + 2]
  let args = {}
  if (rawArgs && !rawArgs.startsWith('--')) {
    try { args = JSON.parse(rawArgs) }
    catch (e) { process.stderr.write(`--call arguments must be JSON: ${e.message}\n`); process.exit(2) }
  }
  const times = Math.max(1, Math.trunc(Number(flag('--times') ?? 1)) || 1)
  let failed = false
  for (let i = 0; i < times; i++) {
    try {
      const out = await callTool(tool, args)
      const text = out?.content?.[0]?.text
      process.stdout.write((typeof text === 'string' ? text : JSON.stringify(out)) + '\n')
      if (out?.isError) failed = true
    } catch (e) {
      process.stderr.write(`call failed: ${e.message}\n`)
      failed = true
    }
  }
  await finish(failed ? 1 : 0)
}

await server.connect(new StdioServerTransport())
if (LINE_MODE === 'on' && channelId) await holdLine()
log(`bridge up on stdio — line mode ${LINE_MODE}${channelId ? '' : ' (channel opens on your first call)'}` +
  ` | spend cap ${MAX_SPEND ? MAX_SPEND + ' ' + spendUnit : 'NONE (X402_MAX_SPEND=0)'}` +
  ' | stops when stdin closes')
