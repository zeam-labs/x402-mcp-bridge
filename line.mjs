export const LINE_HEADER = 'x-line'
export const LINE_META = 'zeam-pass/line'
export const METER_META = 'zeam-pass/meter'
export const PRICE_META = 'zeam-pass/price'
export const LINE_GONE = new Set(['line_unknown', 'unknown_line', 'line_closed'])

export const lineMessage = (channelId, nonce) => `ZEAM Pass line\nchannel: ${String(channelId).toLowerCase()}\nnonce: ${nonce}`

export const lineUrlIn = (sentence) => {
  const m = /\bPOST\s+(https?:\/\/[^\s"'\\]+\/line)(?![\w/])/.exec(String(sentence ?? ''))
  return m ? m[1] : null
}

export const lineUrlOf = (terms) => {
  if (!terms || typeof terms !== 'object') return null
  return lineUrlIn(terms.line?.open) ?? lineUrlIn(terms.time) ?? null
}

export const lineUrlBeside = (upstream) => String(upstream).replace(/\/+$/, '').replace(/\/mcp$/, '') + '/line'

export const MIN_BUY_MS = 250

export const timeOf = (tag) => {
  if (!tag || typeof tag !== 'object') return null
  const rateMicro = Math.round(Number(tag.usd) * 1e6)
  if (tag.per === 'ms') {
    const rateMs = Number(tag.ms ?? 1)
    if (!(rateMicro > 0) || !(rateMs > 0)) return null
    return { rateMicro, rateMs, maxMs: Number(tag.maxMs) > 0 ? Number(tag.maxMs) : null, buys: 'ms' }
  }
  if (tag.per === 'block') {
    const rateMs = Number(tag.blockMs)
    if (!(rateMicro > 0) || !(rateMs > 0)) return null
    return { rateMicro, rateMs, maxMs: (Number(tag.maxBlocks) > 0 ? Number(tag.maxBlocks) : 14400) * rateMs, buys: 'blocks' }
  }
  return null
}

export const timeFromTerms = (terms) => timeOf(terms?.prices?.buy_time)

export const isTimeTag = (tag) => tag?.per === 'time'

export const bodyOf = (out) => {
  if (out?.structuredContent && typeof out.structuredContent === 'object') return out.structuredContent
  try {
    const j = JSON.parse(String(out?.content?.[0]?.text ?? ''))
    return j && typeof j === 'object' ? j : null
  } catch { return null }
}

export const codeOf = (out) => {
  if (!out?.isError) return null
  const b = bodyOf(out)
  const c = b?.code ?? b?.error
  return typeof c === 'string' ? c : null
}

export const meterOf = (out) => {
  const m = out?._meta?.[METER_META]
  return m && typeof m === 'object' ? m : null
}

export const timeTerms = (terms, micro) => {
  if (!terms?.accepts?.length || !(micro > 0)) return terms
  const unit = BigInt(terms.accepts[0].amount ?? 0)
  if (unit <= 0n) return terms
  return { ...terms, accepts: terms.accepts.map((a) => ({ ...a, amount: String((BigInt(a.amount ?? 0) * BigInt(micro)) / unit) })) }
}

export const buyFor = ({ wantMs, time, availableMicro = null }) => {
  const least = Math.max(1, Math.ceil(MIN_BUY_MS / time.rateMs))
  const most = time.maxMs ? Math.max(1, Math.floor(time.maxMs / time.rateMs)) : Infinity
  let steps = Math.min(most, Math.max(least, Math.ceil(wantMs / time.rateMs)))
  if (availableMicro !== null && Number.isFinite(availableMicro)) {
    const fits = Math.floor(availableMicro / time.rateMicro)
    steps = fits >= least ? Math.min(steps, fits) : Math.min(most, least)
  }
  const ms = steps * time.rateMs
  return { ms, micro: steps * time.rateMicro, args: time.buys === 'blocks' ? { blocks: steps } : { ms } }
}

export const askedMicro = (time, args, unitMicro) => {
  if (time && Number.isSafeInteger(args?.ms) && args.ms > 0) return Math.ceil(args.ms / time.rateMs) * time.rateMicro
  if (!(unitMicro > 0)) return null
  return unitMicro * Math.max(1, Math.trunc(Number(args?.blocks) || 1))
}

const post = async (fetchFn, url, body) => {
  let r
  try {
    r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    return { op: 'line_failed', code: 'unreachable', why: `could not reach ${url}: ${e?.message ?? e}` }
  }
  const j = await r.json().catch(() => null)
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { op: 'line_failed', code: 'unreadable', status: r.status, why: `${url} answered ${r.status} with no JSON` }
  return { status: r.status, ...j }
}

export async function openLine({ url, channelId, signer, fetchFn = fetch }) {
  const id = String(channelId).toLowerCase()
  const c = await post(fetchFn, url, { op: 'open', channelId: id })
  if (c.op !== 'challenge' || !c.nonce) return { ...c, op: 'line_failed', code: c.code ?? c.error ?? 'no_challenge' }
  const message = typeof c.sign === 'string' ? c.sign : lineMessage(id, c.nonce)
  if (message !== lineMessage(id, c.nonce)) return { op: 'line_failed', code: 'unexpected_challenge', why: `the seller asked to sign something other than the line text: ${JSON.stringify(message).slice(0, 120)}` }
  const signature = await signer.signMessage({ message })
  const o = await post(fetchFn, url, { op: 'prove', channelId: id, nonce: c.nonce, signature })
  if (o.op !== 'opened' || !o.credential) return { ...o, op: 'line_failed', code: o.code ?? o.error ?? 'not_opened' }
  return o
}

export const lineOp = ({ url, op, credential, fetchFn = fetch }) => post(fetchFn, url, { op, credential })
