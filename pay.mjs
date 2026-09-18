import { createPublicClient, http as plainHttp, fallback, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as chains from 'viem/chains'
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from '@x402/fetch'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { toClientEvmSigner } from '@x402/evm'
import { mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LINE_HEADER = 'x-line'
const LINE_GONE = new Set(['unknown_line', 'line_closed'])

const queue = () => {
  let tail = Promise.resolve()
  return (fn) => { const run = tail.then(fn, fn); tail = run.then(() => {}, () => {}); return run }
}

const saltOf = (raw) => /^0x[0-9a-fA-F]{64}$/.test(String(raw).trim()) ? String(raw).trim() : keccak256(toHex(String(raw)))

function wallet({ key, url, network, stateDir, depositMultiplier, asset, salt, rpcUrl, log }) {
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
      ...(depositMultiplier ? { depositPolicy: { depositMultiplier: Number(depositMultiplier) } } : {}),
      storage: watched,
      ...(salt ? { salt: saltOf(salt) } : {}),
    }))
  const httpClient = new x402HTTPClient(payments)
  const paidFetch = wrapFetchWithPayment(fetch, payments)
  const oneAtATime = queue()
  log(`prism: paying as ${account.address}, state in ${dir}`)
  return { account, state, payments, httpClient, paidFetch, oneAtATime, dir }
}

function line({ url, w, aheadMs, idleMs, dropAfterMs, log }) {
  const ws = new URL('/pay', url); ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
  const s = { socket: null, credential: null, remainingMs: 0, readAt: 0, metering: false,
              opening: null, waiting: new Map(), offTimer: null, dropTimer: null, tickTerms: null, topping: null }
  const send = (frame) => { try { s.socket?.send(JSON.stringify(frame)) } catch { } }
  const remaining = () => Math.max(0, s.remainingMs - (s.metering ? Date.now() - s.readAt : 0))
  const read = (ms, metering) => { s.remainingMs = Number(ms ?? 0); s.readAt = Date.now(); if (metering !== undefined) s.metering = Boolean(metering) }
  const settle = (op, frame) => { const w = s.waiting.get(op); if (w) { s.waiting.delete(op); w(frame) } }
  const ask = (op, frame) => new Promise((resolve) => {
    if (!s.socket || s.socket.readyState !== 1) return resolve(null)
    s.waiting.set(op, resolve); send(frame)
    setTimeout(() => { if (s.waiting.get(op) === resolve) { s.waiting.delete(op); resolve(null) } }, 10_000)
  })
  const drop = (why) => {
    if (s.offTimer) clearTimeout(s.offTimer); if (s.dropTimer) clearTimeout(s.dropTimer)
    s.offTimer = s.dropTimer = null
    for (const [, w] of s.waiting) w(null); s.waiting.clear()
    try { s.socket?.close() } catch { }
    if (s.credential) log(`prism: line closed (${why})`)
    s.socket = null; s.credential = null; s.metering = false
  }
  const terms = async () => {
    if (s.tickTerms) return s.tickTerms
    try {
      const j = await (await fetch(new URL('/.well-known/x402', url))).json()
      const accepts = Array.isArray(j.tickAccepts) && j.tickAccepts.length ? j.tickAccepts : j.accepts
      if (Array.isArray(accepts) && accepts.length) s.tickTerms = { x402Version: j.x402Version ?? 2, accepts }
    } catch { }
    return s.tickTerms
  }
  const open = () => {
    if (s.credential) return Promise.resolve(s.credential)
    if (s.opening) return s.opening
    if (!w.state.channelId) return Promise.resolve(null)
    s.opening = new Promise((resolve) => {
      let socket
      try { socket = new WebSocket(ws.toString()) } catch (e) { log(`prism: line: ${e.message}`); return resolve(null) }
      const giveUp = setTimeout(() => { try { socket.close() } catch { } ; resolve(null) }, 10_000)
      socket.onmessage = async (ev) => {
        let m; try { m = JSON.parse(String(ev.data)) } catch { return }
        if (m.op === 'challenge') {
          try { socket.send(JSON.stringify({ op: 'prove', signature: await w.account.signMessage({ message: m.message }) })) }
          catch (e) { clearTimeout(giveUp); log(`prism: cannot sign the open challenge: ${e.message}`); try { socket.close() } catch { } ; resolve(null) }
          return
        }
        if (m.op === 'open_failed') { clearTimeout(giveUp); log(`prism: line refused: ${m.error ?? m.why}`); try { socket.close() } catch { } ; return resolve(null) }
        if (m.op === 'opened') {
          clearTimeout(giveUp)
          s.socket = socket; s.credential = m.credential; read(m.msRemaining, m.metering)
          log(`prism: line open, ${m.msRemaining}ms on the meter, collateral buys ${m.buysMs ?? '?'}ms`)
          return resolve(s.credential)
        }
        if (m.op === 'meter') { read(m.msRemaining, m.metering); return }
        if (m.op === 'on' || m.op === 'off') { read(m.msRemaining, m.op === 'on'); return settle(m.op, m) }
        if (m.op === 'refunded' || m.op === 'refund_failed') return settle('refund', m)
        if (m.op === 'closing') { log(`prism: line closing: ${m.why}`); return drop(m.why) }
        if (m.op === 'error') log(`prism: /pay: ${m.error}`)
      }
      socket.onopen = () => socket.send(JSON.stringify({ op: 'open', channelId: w.state.channelId }))
      socket.onclose = () => { clearTimeout(giveUp); drop('socket closed'); resolve(null) }
      socket.onerror = () => { }
    }).finally(() => { s.opening = null })
    return s.opening
  }
  const on = async () => { if (s.metering || !s.credential) return; const r = await ask('on', { op: 'on' }); if (!r) s.metering = false }
  const off = async () => { if (!s.metering || !s.credential) return; await ask('off', { op: 'off' }) }
  const touch = () => {
    if (s.offTimer) clearTimeout(s.offTimer); if (s.dropTimer) clearTimeout(s.dropTimer)
    s.offTimer = setTimeout(() => { off().catch(() => {}) }, idleMs); s.offTimer.unref?.()
    s.dropTimer = setTimeout(() => drop('idle'), dropAfterMs); s.dropTimer.unref?.()
  }
  const tickOnce = () => w.oneAtATime(async () => {
    if (!s.credential) return false
    const t = await terms()
    let r
    if (t) {
      const payload = await w.payments.createPaymentPayload(t)
      const headers = { ...w.httpClient.encodePaymentSignatureHeader(payload), [LINE_HEADER]: s.credential, 'content-type': 'application/json' }
      r = await fetch(new URL('/v1/tick', url), { method: 'POST', headers, body: '{}' })
      await w.httpClient.processPaymentResult(payload, (n) => r.headers.get(n), r.status).catch(() => {})
      if (r.status === 402) { s.tickTerms = null; r = null }
    }
    if (!r) {
      r = await w.paidFetch(new URL('/v1/tick', url), { method: 'POST', headers: { [LINE_HEADER]: s.credential, 'content-type': 'application/json' }, body: '{}' })
    }
    const j = await r.json().catch(() => null)
    if (r.status !== 200 || j?.paid === false) { drop(`tick refused: ${j?.error ?? j?.why ?? r.status}`); return false }
    read(j.msRemaining, s.metering)
    return true
  })
  const ensure = async (minMs) => { while (s.credential && remaining() < minMs) { if (!(await tickOnce())) return false } ; return Boolean(s.credential) }
  const topUp = () => {
    if (s.topping) return s.topping
    s.topping = (async () => { while (s.credential && remaining() < aheadMs) { if (!(await tickOnce())) break } })().finally(() => { s.topping = null })
    return s.topping
  }
  const refund = async () => {
    const channelId = w.state.channelId
    if (!channelId) return { op: 'refund_failed', why: 'no channel' }
    const issued = new Date().toISOString()
    const signature = await w.account.signMessage({ message: `ZEAM Prism refund\nchannel: ${channelId.toLowerCase()}\nissued: ${issued}` })
    return new Promise((resolve) => {
      const socket = new WebSocket(ws.toString())
      const timer = setTimeout(() => { try { socket.close() } catch { } ; resolve({ op: 'refund_failed', why: 'timeout' }) }, 90_000)
      socket.onmessage = (ev) => {
        let m; try { m = JSON.parse(String(ev.data)) } catch { return }
        if (m.op === 'refunded' || m.op === 'refund_failed' || m.error) { clearTimeout(timer); try { socket.close() } catch { } ; resolve(m) }
      }
      socket.onopen = () => socket.send(JSON.stringify({ op: 'refund', channelId, issued, signature }))
      socket.onerror = () => { clearTimeout(timer); resolve({ op: 'refund_failed', why: 'socket error' }) }
    })
  }
  return { s, open, on, off, touch, ensure, topUp, drop, remaining, refund }
}

export function client(opts = {}) {
  const {
    key = process.env.X402_PRIVATE_KEY, url = process.env.X402_MCP_URL?.replace(/\/mcp\/?$/, '') ?? 'https://mcp.zeamprism.com',
    chain = 'base', network = process.env.X402_NETWORK ?? 'eip155:8453',
    stateDir = process.env.X402_STATE_DIR, depositMultiplier = process.env.X402_DEPOSIT_MULTIPLIER,
    asset = process.env.X402_ASSET, salt = process.env.X402_SALT, rpcUrl = process.env.X402_RPC_URL,
    aheadMs = 2000, idleMs = 1000, dropAfterMs = 10_000, blockMs = 250,
    log = (...a) => console.error(...a),
  } = opts
  const w = wallet({ key, url, network, stateDir, depositMultiplier, asset, salt, rpcUrl, log })
  const l = line({ url, w, aheadMs, idleMs, dropAfterMs, log })
  const door = new URL(`/rpc/${chain}`, url).toString()

  const withLine = (req) => { const r = new Request(req); r.headers.set(LINE_HEADER, l.s.credential); return r }
  const codeOf = async (r) => {
    const j = await r.clone().json().catch(() => null)
    const d = (Array.isArray(j) ? j[0] : j)?.error?.data ?? j
    return d?.code ?? d?.error ?? null
  }

  const fetchFn = async (input, init) => {
    const req = new Request(input, init)
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!l.s.credential && w.state.channelId) await l.open()
      if (l.s.credential) {
        await l.on()
        if (!(await l.ensure(blockMs + 50))) continue
        l.topUp()
        const r = await fetch(withLine(req.clone()))
        l.touch()
        if (r.status !== 402) return r
        const code = await codeOf(r)
        if (code === 'line_unpaid') { l.s.metering = false; l.s.remainingMs = 0; continue }
        if (LINE_GONE.has(code)) { l.drop(code); continue }
        return r
      }
      const r = await w.oneAtATime(() => w.paidFetch(req.clone()))
      if (r.status !== 402) return r
      const code = await codeOf(r)
      if (code === 'line_required' && w.state.channelId) { await l.open(); continue }
      return r
    }
    throw new Error('prism: could not hold a line after three attempts')
  }

  const refund = async () => {
    l.drop('refunding')
    await w.oneAtATime(() => {})
    let r
    for (let i = 0; i < 6; i++) {
      r = await l.refund()
      if (r.op === 'refunded' || (r.code ? r.code !== 'request_open' : !/still open/.test(String(r.why ?? '')))) return r
      await new Promise((res) => setTimeout(res, 1000))
    }
    return r
  }
  const close = async () => { await l.off().catch(() => {}); l.drop('closed') }
  const state = () => ({ address: w.account.address, channelId: w.state.channelId, line: Boolean(l.s.credential),
                         metering: l.s.metering, msRemaining: l.remaining() })
  return { door, fetch: fetchFn, close, refund, state }
}

export { LINE_HEADER }
