import { x402Client, x402HTTPClient } from '@x402/fetch'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner } from '@x402/evm'

const USDC = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
])

export const FETCH_TOOL = {
  name: 'x402_fetch',
  description: 'Calls any HTTP URL and, if it answers 402 Payment Required, pays it with this bridge\'s key under the x402 exact scheme and retries. ' +
    'Works for any x402 API, and for endpoints gated by ZEAM :: Pass, which admit a key by a payment of zero. ' +
    'Set pay to false to see the terms without paying. maxAmount (base units of the asset) refuses a quote above it.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'the http(s) URL to call' },
      method: { type: 'string', description: 'GET, POST, …; POST when a body is given, GET otherwise' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { description: 'a JSON value is sent as JSON; a string is sent as is' },
      pay: { type: 'boolean', description: 'false returns the 402 terms without paying; default true' },
      maxAmount: { type: 'string', description: 'refuse to pay more than this many base units of the quoted asset' },
    },
    required: ['url'],
  },
}

const text = (o, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(o) }] })

export function makeFetchTool({ signer, pub, network, grant = null, log = () => {}, budget = { allows: () => true, spend: () => {} }, fetchImpl = globalThis.fetch } = {}) {
  const http402 = signer ? new x402HTTPClient(new x402Client().register(network, new ExactEvmScheme(toClientEvmSigner(signer, pub)))) : null

  const readBody = async (res) => {
    const raw = await res.text()
    try { return JSON.parse(raw) } catch { return raw }
  }

  return async function call(args = {}) {
    let url
    try { url = new URL(String(args.url ?? '')) } catch { return text({ error: 'bad_url', message: 'url must be an absolute http(s) URL' }, true) }
    if (!/^https?:$/.test(url.protocol)) return text({ error: 'bad_url', message: 'only http and https' }, true)
    const hasBody = args.body !== undefined
    const method = String(args.method ?? (hasBody ? 'POST' : 'GET')).toUpperCase()
    const headers = { ...(grant ? { 'x-grant': grant } : {}), ...(args.headers ?? {}) }
    let body
    if (hasBody) {
      if (typeof args.body === 'string') body = args.body
      else { body = JSON.stringify(args.body); if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json' }
    }
    const send = (extra = {}) => fetchImpl(url, { method, headers: { ...headers, ...extra }, ...(body !== undefined ? { body } : {}) })

    let first
    try { first = await send() } catch (e) { return text({ error: 'unreachable', message: String(e?.message ?? e) }, true) }
    if (first.status !== 402) return text({ status: first.status, paid: false, body: await readBody(first) }, first.status >= 400)

    const firstBody = await readBody(first)
    let required
    try { required = (http402 ?? new x402HTTPClient(new x402Client())).getPaymentRequiredResponse((n) => first.headers.get(n), firstBody) }
    catch (e) { return text({ status: 402, paid: false, error: 'unreadable_terms', message: String(e?.message ?? e), body: firstBody }, true) }
    const exact = (required.accepts ?? []).filter((a) => a.scheme === 'exact' && a.network === network)
    const terms = { status: 402, paid: false, accepts: required.accepts, ...(typeof firstBody === 'object' && firstBody?.realm ? { realm: firstBody.realm } : {}) }
    if (args.pay === false) return text(terms)
    if (!http402) return text({ ...terms, error: 'no_key', message: 'set X402_PRIVATE_KEY to pay; this bridge has no key' }, true)
    if (!exact.length) return text({ ...terms, error: 'no_payable_terms', message: `nothing quoted under the exact scheme on ${network}` }, true)

    const pick = exact.slice().sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0]
    const amount = BigInt(pick.amount)
    if (args.maxAmount !== undefined && amount > BigInt(args.maxAmount)) return text({ ...terms, error: 'over_max', message: `quoted ${amount} is more than maxAmount ${args.maxAmount}` }, true)
    const isUsdc = USDC.has(String(pick.asset).toLowerCase())
    if (amount > 0n && !isUsdc && args.maxAmount === undefined) return text({ ...terms, error: 'max_required', message: `the quote is in ${pick.asset}, not USDC, so the spend cap cannot value it; pass maxAmount to pay it` }, true)
    if (amount > 0n && isUsdc && !budget.allows(Number(amount))) return text({ ...terms, error: 'x402_bridge_spend_cap_reached', message: 'this payment would pass X402_MAX_SPEND' }, true)

    let payHeaders
    try { payHeaders = http402.encodePaymentSignatureHeader(await http402.createPaymentPayload({ ...required, accepts: [pick] })) }
    catch (e) { return text({ ...terms, error: 'could_not_sign', message: String(e?.message ?? e) }, true) }
    let second
    try { second = await send(payHeaders) } catch (e) { return text({ error: 'unreachable', message: String(e?.message ?? e) }, true) }
    let settlement = null
    try { settlement = http402.getPaymentSettleResponse((n) => second.headers.get(n)) } catch { }
    const out = await readBody(second)
    const ok = second.status < 400
    const paid = ok && amount > 0n
    if (paid && isUsdc) budget.spend(Number(amount))
    if (ok) log(`x402_fetch: ${amount === 0n ? 'admitted by a payment of zero at' : `paid ${amount} of ${pick.asset} to`} ${url.host}`)
    return text({ status: second.status, ok, paid, amount: String(amount), asset: pick.asset, payTo: pick.payTo, ...(settlement ? { settlement } : {}), body: out }, !ok)
  }
}
