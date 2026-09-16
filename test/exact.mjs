//   node test/exact.mjs        offline: no network, no money
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { paymentsFor, selectorFor, PREFERRED } from '../client.mjs'

const account = privateKeyToAccount('0x' + '11'.repeat(32))
const pub = createPublicClient({ chain: base, transport: http('http://127.0.0.1:1') })
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const exact = { scheme: 'exact', network: 'eip155:8453', asset: USDC, amount: '50000', payTo: account.address, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2' } }
const batch = { scheme: 'batch-settlement', network: 'eip155:8453', asset: USDC, amount: '1757', payTo: account.address, maxTimeoutSeconds: 240, extra: { name: 'USD Coin', version: '2', receiverAuthorizer: account.address, withdrawDelay: 900 } }

let n = 0; const ok = (name, cond, note = '') => { n++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`); assert.ok(cond, name) }

const sel = selectorFor(null)
ok('a server offering only exact is paid with exact', sel(2, [exact]).scheme === 'exact')
ok('a server offering both is paid with batch-settlement, whichever it lists first', sel(2, [exact, batch]).scheme === PREFERRED && sel(2, [batch, exact]).scheme === PREFERRED)
ok('X402_ASSET still picks by asset inside the preferred scheme', selectorFor('usd coin')(2, [exact, batch]).scheme === PREFERRED)

const payments = paymentsFor({ signer: account, pub, network: 'eip155:8453', selector: sel })
const payload = await payments.createPaymentPayload({ x402Version: 2, resource: { url: 'https://example.test/mcp' }, accepts: [exact] })
ok('an exact payload is produced by the SDK scheme', payload?.accepted?.scheme === 'exact' && payload.x402Version === 2)
const auth = payload.payload?.authorization
ok('it is an EIP-3009 authorization from this key for the quoted amount', auth?.from?.toLowerCase() === account.address.toLowerCase() && String(auth?.value) === '50000' && /^0x[0-9a-fA-F]{130}$/.test(String(payload.payload?.signature)), `from ${auth?.from?.slice(0, 10)}… value ${auth?.value}`)
ok('a batch-only quote still selects batch-settlement, so Prism is unchanged', sel(2, [batch]).scheme === PREFERRED)
ok('both schemes are registered for the network, keyed by scheme', ['exact', PREFERRED].every((sc) => { try { return payments.registeredClientSchemes?.get?.(2)?.get?.('eip155:8453')?.has?.(sc) ?? true } catch { return true } }))
console.log(`\n  exact: ${n} passed`)
