// An ethers provider that pays ZEAM Prism from a wallet.
//
//   import { PrismProvider } from '@zeam-labs/x402-mcp-bridge/ethers'
//   const provider = new PrismProvider({ key })
//
// ethers sends JSON-RPC in batches; the door answers a batch item by item.

import { JsonRpcProvider } from 'ethers'
import { client, LINE_HEADER } from './pay.mjs'

export class PrismProvider extends JsonRpcProvider {
  constructor(opts = {}) {
    const { key, url, chain, network, stateDir, depositMultiplier, asset, salt, rpcUrl,
            aheadMs, idleMs, dropAfterMs, blockMs, log, ethersNetwork, ...providerOptions } = opts
    const c = client({ key, url, chain, network, stateDir, depositMultiplier, asset, salt, rpcUrl,
                       aheadMs, idleMs, dropAfterMs, blockMs, log })
    super(c.door, ethersNetwork, providerOptions)
    this.prism = c
  }

  async _send(payload) {
    const r = await this.prism.fetch(this.prism.door, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const body = await r.json().catch(() => null)
    if (!r.ok) {
      const first = Array.isArray(body) ? body[0] : body
      const why = first?.error?.data?.message ?? first?.error?.message ?? `HTTP ${r.status}`
      throw new Error(`prism: ${why}`)
    }
    return Array.isArray(body) ? body : [body]
  }

  close() { return this.prism.close() }
  refund() { return this.prism.refund() }
  state() { return this.prism.state() }
}

export { LINE_HEADER }
