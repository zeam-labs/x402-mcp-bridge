import { createPublicClient, createWalletClient, http as plainHttp, fallback, keccak256, toHex } from 'viem'
import { passRefund, rebaseChannel, sendSignedRefund, refundUrlBeside, refundUrlInTerms, readSeller, rememberRefundUrl, hearingHttp, withGrant } from './refund.mjs'
import { floorStrategy, learnFloor } from './client.mjs'
import { LINE_HEADER, LINE_GONE, lineUrlOf, lineUrlBeside, timeFromTerms, timeTerms, buyFor, MIN_BUY_MS, openLine, lineOp } from './line.mjs'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { toClientEvmSigner } from '@x402/evm'
import { mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const queue = () => {
  let tail = Promise.resolve()
  return (fn) => { const run = tail.then(fn, fn); tail = run.then(() => {}, () => {}); return run }
}

const saltOf = (raw) => /^0x[0-9a-fA-F]{64}$/.test(String(raw).trim()) ? String(raw).trim() : keccak256(toHex(String(raw)))

function wallet({ key, url, network, stateDir, depositMultiplier, asset, salt, rpcUrl, grant, log }) {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('prism(): key must be a 0x-prefixed 32-byte private key. It signs vouchers locally and is never sent anywhere.')
  }
  const account = privateKeyToAccount(key)
  const chainId = Number(String(network).split(':')[1])
  const payChain = Object.values(chains).find((c) => c?.id === chainId)
  if (!payChain) throw new Error(`prism(): unknown network ${network}`)
  const dir = stateDir ?? join(homedir(), '.x402-mcp-bridge', new URL(url).host, account.address.toLowerCase())
  mkdirSync(dir, { recursive: true })
  const readers = [...(rpcUrl ? [rpcUrl] : []), ...(payChain.rpcUrls?.default?.http ?? []), new URL('/verify', url).toString()]
  const pub = createPublicClient({ chain: payChain, transport: fallback(readers.map((u) => plainHttp(u))) })

  const want = String(asset ?? '').toLowerCase()
  const selector = (_v, accepts) => {
    if (want) {
      const hit = accepts.find((a) => String(a.asset).toLowerCase() === want || String(a.extra?.name ?? '').toLowerCase() === want)
      if (hit) return hit
    }
    return accepts[0]
  }
  const storage = new FileClientChannelStorage({ directory: dir })
  const floor = { micro: 0 }
  const state = { channelId: null }
  try {
    const f = readdirSync(join(dir, 'client')).find((n) => n.endsWith('.json'))
    if (f) state.channelId = f.replace(/\.json$/, '')
  } catch { }
  const watched = {
    get: (k) => storage.get(k),
    delete: (k) => { if (state.channelId === k) state.channelId = null; return storage.delete(k) },
    set: (k, ctx) => { state.channelId = k; return storage.set(k, ctx) },
  }
  const payments = new x402Client(selector).register(network,
    new BatchSettlementEvmScheme(toClientEvmSigner(account, pub), {
      depositPolicy: { depositMultiplier: Number(depositMultiplier ?? 40) },
      depositStrategy: floorStrategy(floor),
      storage: watched,
      ...(salt ? { salt: saltOf(salt) } : {}),
    }))
  const httpClient = new x402HTTPClient(payments)
  const seller = { refund: readSeller(dir).refund ?? null }
  const net = hearingHttp(withGrant(fetch, grant), (u) => { seller.refund = u; rememberRefundUrl(dir, u) }, (t) => learnFloor(floor, t))
  const paidFetch = wrapFetchWithPayment(net, payments)
  const oneAtATime = queue()
  log(`prism: paying as ${account.address}, state in ${dir}`)
  const wallets = createWalletClient({ account, chain: payChain, transport: plainHttp(rpcUrl ?? payChain.rpcUrls?.default?.http?.[0]) })
  return { account, state, seller, floor, net, storage: watched, pub, wallets, payments, httpClient, paidFetch, oneAtATime, dir }
}

function line({ url, w, aheadMs, idleMs, dropAfterMs, log }) {
  const s = { credential: null, remainingMs: 0, metering: false, opening: null, offTimer: null, dropTimer: null,
              terms: null, time: null, lineUrl: null, topping: null }
  const where = () => s.lineUrl ?? lineUrlBeside(url)
  const drop = (why) => {
    if (s.offTimer) clearTimeout(s.offTimer); if (s.dropTimer) clearTimeout(s.dropTimer)
    s.offTimer = s.dropTimer = null
    const credential = s.credential
    if (credential) {
      log(`prism: line let go (${why})`)
      lineOp({ url: where(), op: 'close', credential, fetchFn: w.net }).catch(() => {})
    }
    s.credential = null; s.metering = false
  }
  const terms = async () => {
    if (s.terms) return s.terms
    try {
      const j = await (await w.net(new URL('/.well-known/x402', url), { signal: AbortSignal.timeout(10_000) })).json()
      const accepts = Array.isArray(j.tickAccepts) && j.tickAccepts.length ? j.tickAccepts : j.accepts
      if (Array.isArray(accepts) && accepts.length) {
        s.terms = { x402Version: j.x402Version ?? 2, accepts, funding: Array.isArray(j.accepts) && j.accepts.length ? j.accepts : accepts, raw: j }
        s.time = timeFromTerms(j)
        s.lineUrl = lineUrlOf(j)
        learnFloor(w.floor, j)
        const r = refundUrlInTerms(j)
        if (r && !w.seller.refund) w.seller.refund = r
      }
    } catch { }
    return s.terms
  }
  const open = () => {
    if (s.credential) return Promise.resolve(s.credential)
    if (s.opening) return s.opening
    if (!w.state.channelId) return Promise.resolve(null)
    s.opening = (async () => {
      await terms()
      const o = await openLine({ url: where(), channelId: w.state.channelId, signer: w.account, fetchFn: w.net })
      if (o.op !== 'opened') { log(`prism: line not opened: ${o.code}${o.why ? ` (${o.why})` : ''}`); return null }
      s.credential = o.credential; s.metering = o.metering !== false; s.remainingMs = Number(o.msRemaining ?? 0)
      log(`prism: line open, ${s.remainingMs}ms on the meter`)
      return s.credential
    })().finally(() => { s.opening = null })
    return s.opening
  }
  const on = async () => {
    if (s.metering || !s.credential) return
    const a = await lineOp({ url: where(), op: 'on', credential: s.credential, fetchFn: w.net })
    if (a.op === 'on') { s.metering = true; s.remainingMs = Number(a.msRemaining ?? s.remainingMs) }
    else if (LINE_GONE.has(a.code)) drop(a.code)
  }
  const off = async () => {
    if (!s.metering || !s.credential) return
    s.metering = false
    const a = await lineOp({ url: where(), op: 'off', credential: s.credential, fetchFn: w.net })
    if (a.op === 'off') s.remainingMs = Number(a.msRemaining ?? s.remainingMs)
  }
  const touch = () => {
    if (s.offTimer) clearTimeout(s.offTimer); if (s.dropTimer) clearTimeout(s.dropTimer)
    s.offTimer = setTimeout(() => { off().catch(() => {}) }, idleMs); s.offTimer.unref?.()
    s.dropTimer = setTimeout(() => { off().catch(() => {}).finally(() => drop('idle')) }, dropAfterMs); s.dropTimer.unref?.()
  }
  const available = async () => {
    try {
      const c = await w.storage.get(w.state.channelId)
      return c?.balance && c.chargedCumulativeAmount !== undefined ? Number(BigInt(c.balance) - BigInt(c.chargedCumulativeAmount)) : null
    } catch { return null }
  }
  const buyOnce = (wantMs) => w.oneAtATime(async () => {
    if (!s.credential) return false
    const t = await terms()
    const time = s.time ?? { rateMicro: Number(t?.accepts?.[0]?.amount ?? 250), rateMs: 250, maxMs: 14400 * 250, buys: 'blocks' }
    const buy = buyFor({ wantMs, time, availableMicro: await available() })
    const body = JSON.stringify(buy.args)
    const post = async (rows) => {
      const quote = timeTerms({ x402Version: t.x402Version ?? 2, accepts: rows }, buy.micro)
      const payload = await w.payments.createPaymentPayload(quote)
      const headers = { ...w.httpClient.encodePaymentSignatureHeader(payload), 'content-type': 'application/json' }
      const res = await w.net(new URL('/v1/buy_time', url), { method: 'POST', headers, body })
      await w.httpClient.processPaymentResult(payload, (n) => res.headers.get(n), res.status).catch(() => {})
      return res
    }
    let r = null
    if (t) {
      const left = await available()
      const short = left !== null && left < buy.micro
      r = await post(short ? t.funding : t.accepts)
      if (r.status === 402) {
        const j = await r.clone().json().catch(() => null)
        if (j?.code === 'funding_requires_open_fee' && !short) {
          log('prism: this purchase carries a deposit on the funding row')
          r = await post(Array.isArray(j.accepts) && j.accepts.length ? j.accepts : t.funding)
        } else { s.terms = null; r = null }
      }
    }
    if (!r) r = await w.paidFetch(new URL('/v1/buy_time', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const j = await r.json().catch(() => null)
    if (r.status !== 200 || j?.paid === false) { log(`prism: buy_time refused: ${j?.code ?? j?.error ?? r.status}`); return false }
    s.remainingMs = Number(j.msRemaining ?? s.remainingMs + buy.ms)
    return true
  })
  const ensure = async (minMs) => {
    for (let i = 0; s.credential && s.remainingMs < minMs && i < 4; i++) { if (!(await buyOnce(aheadMs))) return false }
    return Boolean(s.credential) && s.remainingMs >= Math.min(minMs, MIN_BUY_MS)
  }
  const topUp = () => {
    if (s.topping || s.remainingMs >= aheadMs / 2) return s.topping
    s.topping = (async () => {
      const left = await available()
      if (left === null || left < MIN_BUY_MS * ((s.time?.rateMicro ?? 250) / (s.time?.rateMs ?? 250))) return false
      return buyOnce(aheadMs)
    })().catch(() => false).finally(() => { s.topping = null })
    return s.topping
  }
  const read = (res) => {
    const left = Number(res.headers.get('x-pass-ms-remaining'))
    if (res.headers.has('x-pass-ms-remaining') && Number.isFinite(left)) s.remainingMs = left
  }
  return { s, open, on, off, touch, ensure, topUp, drop, terms, read, remaining: () => s.remainingMs }
}

export function client(opts = {}) {
  const {
    key = process.env.X402_PRIVATE_KEY, url = process.env.X402_MCP_URL?.replace(/\/mcp\/?$/, '') ?? 'https://mcp.zeamprism.com',
    chain = 'base', network = process.env.X402_NETWORK ?? 'eip155:8453',
    stateDir = process.env.X402_STATE_DIR, depositMultiplier = process.env.X402_DEPOSIT_MULTIPLIER,
    asset = process.env.X402_ASSET, salt = process.env.X402_SALT, rpcUrl = process.env.X402_RPC_URL,
    grant = process.env.X402_GRANT,
    aheadMs = 2000, idleMs = 1000, dropAfterMs = 10_000,
    log = (...a) => console.error(...a),
  } = opts
  const w = wallet({ key, url, network, stateDir, depositMultiplier, asset, salt, rpcUrl, grant, log })
  const l = line({ url, w, aheadMs, idleMs, dropAfterMs, log })
  const door = new URL(`/rpc/${chain}`, url).toString()

  const withLine = (req) => { const r = new Request(req); r.headers.set(LINE_HEADER, l.s.credential); return r }
  const errorData = async (r) => {
    const j = await r.clone().json().catch(() => null)
    return (Array.isArray(j) ? j[0] : j)?.error?.data ?? j
  }
  const codeOf = async (r) => {
    const j = await r.clone().json().catch(() => null)
    const d = (Array.isArray(j) ? j[0] : j)?.error?.data ?? j
    return d?.code ?? d?.error ?? null
  }

  const fetchFn = async (input, init) => {
    const req = new Request(input, init)
    let r = null
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!l.s.credential && w.state.channelId) await l.open()
      if (l.s.credential) {
        await l.on()
        if (!(await l.ensure(MIN_BUY_MS))) { if (l.s.credential) l.drop('could not buy time'); continue }
        r = await w.net(withLine(req.clone()))
        l.read(r)
        l.touch()
        l.topUp()
        if (r.status !== 402 && r.status !== 403) return r
        const code = await codeOf(r)
        if (code === 'meter_off') { l.s.metering = false; continue }
        if (code === 'out_of_time') { l.s.remainingMs = 0; continue }
        if (LINE_GONE.has(code)) { l.drop(code); continue }
        return r
      }
      r = await w.oneAtATime(() => w.paidFetch(req.clone()))
      if (r.status !== 402) return r
      const code = await codeOf(r)
      if (code === 'funding_requires_open_fee' && learnFloor(w.floor, await errorData(r))) continue
      if ((code === 'out_of_time' || code === 'line_required') && w.state.channelId) { await l.open(); continue }
      return r
    }
    if (r) return r
    throw new Error('prism: could not hold a line after four attempts')
  }

  const refund = async ({ selfSend = false } = {}) => {
    await l.off().catch(() => {})
    l.drop('refunding')
    await w.oneAtATime(() => {})
    const channelId = w.state.channelId
    if (!channelId) return { op: 'refund_failed', why: 'no channel' }
    await l.terms()
    const passUrl = w.seller.refund ?? refundUrlBeside(url)
    let a = await passRefund({ url: passUrl, channelId, signer: w.account, selfSend, fetchFn: w.net, log })
    if (a.op === 'refund_signed') a = await sendSignedRefund({ answer: a, account: w.account, pub: w.pub, wallet: w.wallets, storage: w.storage, channelId, log })
    if (a.op === 'refunded' && a.channelState && a.gasPaidBy !== 'you') await rebaseChannel(w.storage, channelId, a.channelState).catch((e) => log(`prism: could not rebase the channel after the refund: ${e.message}`))
    return a
  }
  const close = async () => { await l.off().catch(() => {}); l.drop('closed') }
  const state = () => ({ address: w.account.address, channelId: w.state.channelId, line: Boolean(l.s.credential),
                         metering: l.s.metering, msRemaining: l.remaining() })
  return { door, fetch: fetchFn, close, refund, state }
}

export { LINE_HEADER }
