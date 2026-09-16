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
