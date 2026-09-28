import { getAddress } from 'viem'
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PASS_REALM = 'ZEAM Pass'
export const GRANT_HEADER = 'x-grant'

const CHANNELS_ABI = [{ type: 'function', name: 'channels', stateMutability: 'view', inputs: [{ name: 'channelId', type: 'bytes32' }], outputs: [{ name: 'balance', type: 'uint128' }, { name: 'totalClaimed', type: 'uint128' }] }]

export const refundMessage = (channelId, issued, realm = PASS_REALM) =>
  `${realm} refund\nchannel: ${String(channelId).toLowerCase()}\nissued: ${issued}`

export const refundUrlIn = (sentence) => {
  const m = /\bPOST\s+(https?:\/\/[^\s"'\\]+)/.exec(String(sentence ?? ''))
  return m ? m[1] : null
}

export const refundUrlOf = (terms) => (terms && typeof terms === 'object' ? refundUrlIn(terms.refund) : null)

export const refundUrlBeside = (upstream) => String(upstream).replace(/\/+$/, '').replace(/\/mcp$/, '') + '/refund'

export const withGrant = (fetchFn, grant) => {
  if (!grant) return fetchFn
  return (input, init = {}) => {
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set(GRANT_HEADER, grant)
    return fetchFn(input, { ...init, headers })
  }
}

const parsed = (text) => { try { return JSON.parse(text) } catch { return null } }

const messagesIn = (text, type) => {
  if (/text\/event-stream/.test(type ?? '')) {
    return String(text).split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => parsed(l.slice(5).trim())).filter(Boolean)
  }
  const j = parsed(text)
  return j === null ? [] : Array.isArray(j) ? j : [j]
}

export const termsInMcp = (text, type) => {
  for (const m of messagesIn(text, type)) {
    const r = m?.result
    if (!r?.isError) continue
    if (r.structuredContent && typeof r.structuredContent === 'object') return r.structuredContent
    const t = r.content?.[0]?.text
    const j = typeof t === 'string' ? parsed(t) : null
    if (j && typeof j === 'object') return j
  }
  return null
}

export const termsInHttp = async (r) => {
  const body = await r.clone().json().catch(() => null)
  if (body && typeof body === 'object' && !Array.isArray(body)) return body
  const header = r.headers.get('payment-required')
  if (!header) return null
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) } catch { return null }
}

export const hearingMcp = (fetchFn, onRefundUrl) => async (input, init = {}) => {
  const r = await fetchFn(input, init)
  if (String(init.method ?? 'GET').toUpperCase() === 'POST' && r.ok && r.body) {
    r.clone().text().then((text) => {
      const u = refundUrlOf(termsInMcp(text, r.headers.get('content-type')))
      if (u) onRefundUrl(u)
    }).catch(() => {})
  }
  return r
}

export const hearingHttp = (fetchFn, onRefundUrl) => async (input, init) => {
  const r = await fetchFn(input, init)
  if (r.status === 402) {
    const u = refundUrlOf(await termsInHttp(r))
    if (u) onRefundUrl(u)
  }
  return r
}

const SELLER_FILE = 'seller.json'

export const readSeller = (dir) => {
  try { const j = JSON.parse(readFileSync(join(dir, SELLER_FILE), 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
}

export const rememberRefundUrl = (dir, url) => {
  const prior = readSeller(dir)
  if (prior.refund === url) return
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, SELLER_FILE), JSON.stringify({ ...prior, refund: url }, null, 2)) } catch { }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function askPassRefund({ url, channelId, signer, extra = {}, fetchFn = fetch, now = Date.now }) {
  const issued = new Date(now()).toISOString()
  const signature = await signer.signMessage({ message: refundMessage(channelId, issued) })
  const body = JSON.stringify({ channelId: String(channelId).toLowerCase(), issued, signature, ...extra })
  let r
  try {
    r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(120_000) })
  } catch (e) {
    return { op: 'refund_failed', code: 'unreachable', why: `could not reach ${url}: ${e?.message ?? e}` }
  }
  const j = await r.json().catch(() => null)
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { op: 'refund_failed', code: 'unreadable', status: r.status, why: `${url} answered ${r.status} with no JSON` }
  return { status: r.status, ...j }
}

export async function passRefund({ url, channelId, signer, payer = signer, selfSend = false, fetchFn = fetch, now = Date.now, wait = sleep, tries = 6, log = () => {} }) {
  const ask = (extra) => askPassRefund({ url, channelId, signer, extra, fetchFn, now })
  const first = selfSend ? { selfSend: true } : {}
  let a
  for (let i = 0; i < tries; i++) {
    a = await ask(first)
    if (a.code !== 'request_open' || i + 1 === tries) break
    const secs = Number(a.retry_after_seconds)
    await wait(Math.min(Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1000, 5000))
  }
  if (a.op !== 'refund_quote' || a.code !== 'gas_payment_needed' || !a.sign || !a.authorization) return a
  const from = String(a.authorization.from ?? '').toLowerCase()
  if (!payer?.signTypedData || String(payer.address ?? '').toLowerCase() !== from) {
    return { ...a, op: 'refund_failed', code: 'gas_payment_needed', why: `${a.why ?? ''} The gas payment must be signed by the channel's payer, ${a.authorization.from}; this key cannot. Run --refund with the payer's key, or --self-send.`.trim() }
  }
  log(`the channel's fees do not cover the refund's gas: paying exactly ${a.gasMicroUSD} micro-USD of it in USDC from ${a.authorization.from}, to get ${a.returnedMicroUSD} back`)
  const signature = await payer.signTypedData(a.sign)
  return ask({ gasPayment: { authorization: a.authorization, signature } })
}

export async function rebaseChannel(storage, channelId, cs) {
  if (cs?.chargedCumulativeAmount === undefined) return false
  const prior = (await storage.get(channelId)) ?? {}
  await storage.set(channelId, {
    ...prior,
    chargedCumulativeAmount: String(cs.chargedCumulativeAmount),
    ...(cs.balance !== undefined ? { balance: String(cs.balance) } : {}),
    ...(cs.totalClaimed !== undefined ? { totalClaimed: String(cs.totalClaimed) } : {}),
    signedMaxClaimable: String(cs.chargedCumulativeAmount),
    signature: undefined,
  })
  return true
}

export async function channelOnChain(pub, channelId) {
  const [balance, totalClaimed] = await pub.readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi: CHANNELS_ABI, functionName: 'channels', args: [channelId] })
  return { channelId: String(channelId).toLowerCase(), balance: String(balance), totalClaimed: String(totalClaimed), chargedCumulativeAmount: String(totalClaimed) }
}

export async function sendSignedRefund({ answer, account, pub, wallet, storage, channelId, log = () => {} }) {
  const tx = answer?.transaction
  if (answer?.op !== 'refund_signed' || !tx?.to || !tx?.data) return answer
  let gas, price, have
  try {
    gas = await pub.estimateGas({ account: account.address, to: tx.to, data: tx.data })
    price = await pub.getGasPrice()
    have = await pub.getBalance({ address: account.address })
  } catch (e) {
    return { ...answer, sent: false, why: `${answer.why ?? ''} Could not price sending it from here (${e?.shortMessage ?? e?.message}); any wallet can send the transaction.`.trim() }
  }
  if (have < (gas * price * 3n) / 2n) {
    return { ...answer, sent: false, why: `${answer.why ?? ''} ${account.address} holds too little ETH on Base to send it; any wallet can send the transaction.`.trim() }
  }
  const hash = await wallet.sendTransaction({ to: getAddress(tx.to), data: tx.data, value: 0n })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  log(`sent the signed refund at your own gas: ${receipt.status} ${hash}`)
  if (receipt.status !== 'success') return { op: 'refund_failed', code: 'reverted', microUSD: answer.microUSD, transaction: hash, gasPaidBy: 'you', why: 'the refund transaction reverted' }
  let channelState = null
  try {
    channelState = await channelOnChain(pub, channelId)
    await rebaseChannel(storage, channelId, channelState)
  } catch (e) { log(`could not rebase the channel after the refund: ${e?.shortMessage ?? e?.message}`) }
  return { op: 'refunded', microUSD: answer.microUSD, returnedMicroUSD: answer.microUSD, transaction: hash, gasPaidBy: 'you', ...(channelState ? { channelState } : {}) }
}
