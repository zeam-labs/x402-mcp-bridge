import { http } from 'viem'
import { client, LINE_HEADER } from './pay.mjs'

export function prism(opts = {}) {
  const { key, url, chain, network, stateDir, depositMultiplier, asset, salt, rpcUrl,
          aheadMs, idleMs, dropAfterMs, blockMs, log, ...httpConfig } = opts
  const c = client({ key, url, chain, network, stateDir, depositMultiplier, asset, salt, rpcUrl,
                     aheadMs, idleMs, dropAfterMs, blockMs, log })
  const transport = http(c.door, { ...httpConfig, fetchFn: c.fetch })
  transport.close = c.close
  transport.refund = c.refund
  transport.state = c.state
  return transport
}

export { LINE_HEADER }
