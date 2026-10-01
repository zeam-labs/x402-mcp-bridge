import { x402Client } from '@x402/mcp'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { toClientEvmSigner } from '@x402/evm'

export const PREFERRED = 'batch-settlement'

export const selectorFor = (want, onChoice = () => {}, log = () => {}) => (_version, accepts) => {
  const pool = accepts.some((a) => a.scheme === PREFERRED) ? accepts.filter((a) => a.scheme === PREFERRED) : accepts
  if (want) {
    const w = String(want).toLowerCase()
    const hit = pool.find((a) => String(a.asset).toLowerCase() === w || String(a.extra?.name ?? '').toLowerCase() === w)
    if (hit) { onChoice(hit); return hit }
    log(`X402_ASSET=${want} is not among the ${pool.length} quoted; falling back to the first`)
  }
  onChoice(pool[0])
  return pool[0]
}

export const paymentsFor = ({ signer, pub, network, batch = {}, selector }) => {
  const s = toClientEvmSigner(signer, pub)
  return new x402Client(selector)
    .register(network, new BatchSettlementEvmScheme(s, batch))
    .register(network, new ExactEvmScheme(s))
}

export const paymentRefused = (out) => {
  if (!out?.isError) return false
  let body = out.structuredContent
  if (!body || typeof body !== 'object') { try { body = JSON.parse(String(out?.content?.[0]?.text ?? '')) } catch { return false } }
  if (body?.code === 'payment_invalid') return true
  return body?.x402Version !== undefined && /^(invalid_|insufficient_|cumulative_)/.test(String(body?.error ?? ''))
}

const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x036cbd53842c5426634e7929541ec2318f3dcf7e'])

export const depositFloorOf = (terms) => {
  const m = /at least \$([0-9]+(?:\.[0-9]+)?)/.exec(String(terms?.deposit ?? ''))
  if (m) return Math.ceil(Number(m[1]) * 1e6 - 1e-6)
  const n = Number(terms?.neededMicroUSD)
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null
}

export const floorStrategy = (floor) => ({ paymentRequirements, depositAmount }) => {
  if (!(floor.micro > 0) || !USDC.has(String(paymentRequirements?.asset ?? '').toLowerCase())) return undefined
  return BigInt(depositAmount) < BigInt(floor.micro) ? String(floor.micro) : undefined
}

export const learnFloor = (floor, terms) => {
  const f = depositFloorOf(terms)
  if (f !== null && f > (floor.micro ?? 0)) { floor.micro = f; return true }
  return false
}
