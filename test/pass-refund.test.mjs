import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress, recoverTypedDataAddress } from 'viem'
import { fakeSeller, fakeRpc, gasQuote, passTerms, refundSentence, stateWithChannel, channelFile, bridge, KEY, CHANNEL } from './fakes.mjs'
import { refundMessage, refundUrlOf, refundUrlBeside, termsInMcp, sendSignedRefund, passRefund } from '../refund.mjs'
import { paymentRefused } from '../client.mjs'
import { client } from '../pay.mjs'

const payer = privateKeyToAccount(KEY)
const quiet = () => {}

const proofSigner = async (body) => recoverMessageAddress({
  message: `ZEAM Pass refund\nchannel: ${String(body.channelId).toLowerCase()}\nissued: ${body.issued}`,
  signature: body.signature,
})

const refunded = (extra = {}) => ({ status: 200, body: { op: 'refunded', microUSD: 90000, returnedMicroUSD: 90000, gasMicroUSD: 0, transaction: '0x' + '1'.repeat(8), drained: true, channelState: { channelId: CHANNEL, balance: '10000', totalClaimed: '10000', chargedCumulativeAmount: '10000' }, ...extra } })

test('the refund proof is the Pass text, signed by the payer, posted as JSON to <base>/refund beside /mcp', async () => {
  const s = await fakeSeller({ refund: () => refunded() })
  try {
    const dir = stateWithChannel()
    const r = await bridge(['--refund'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/agents/mcp`, X402_STATE_DIR: dir })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(s.seen.refunds.length, 1)
    const { path, body } = s.seen.refunds[0]
    assert.equal(path, '/agents/refund')
    assert.deepEqual(Object.keys(body).sort(), ['channelId', 'issued', 'signature'])
    assert.equal(body.channelId, CHANNEL.toLowerCase())
    assert.ok(Math.abs(Date.parse(body.issued) - Date.now()) < 60_000, 'issued is now')
    assert.equal((await proofSigner(body)).toLowerCase(), payer.address.toLowerCase())
    assert.equal(s.seen.pay, 0, 'no Prism /pay socket for a Pass seller')
    assert.equal(r.out.op, 'refunded')
    assert.equal(r.out.returnedMicroUSD, 90000)
    assert.equal(r.out.gasMicroUSD, 0)
  } finally { await s.close() }
})

test('refundMessage is the exact Pass text', () => {
  assert.equal(refundMessage('0xAB', '2026-09-28T00:00:00.000Z'), 'ZEAM Pass refund\nchannel: 0xab\nissued: 2026-09-28T00:00:00.000Z')
})

test('a refunded answer rebases the local channel from channelState', async () => {
  const s = await fakeSeller({ refund: () => refunded() })
  try {
    const dir = stateWithChannel({ balance: '100000', chargedCumulativeAmount: '10000', signedMaxClaimable: '12000', signature: '0x01' })
    const r = await bridge(['--refund'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/agents/mcp`, X402_STATE_DIR: dir })
    assert.equal(r.code, 0, r.stderr)
    const c = channelFile(dir)
    assert.deepEqual([c.balance, c.totalClaimed, c.chargedCumulativeAmount, c.signedMaxClaimable, c.signature], ['10000', '10000', '10000', '10000', undefined])
  } finally { await s.close() }
})

test('refund_quote: the payer signs the EIP-3009 gas payment and posts again with a fresh proof', async () => {
  const s = await fakeSeller({
    refund: (body, n) => {
      if (n === 1) return { status: 409, body: gasQuote(payer.address) }
      return body.gasPayment ? refunded({ gasMicroUSD: 4029 }) : { status: 400, body: { op: 'refund_failed', code: 'bad_request' } }
    },
  })
  try {
    const dir = stateWithChannel()
    const r = await bridge(['--refund'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/agents/mcp`, X402_STATE_DIR: dir })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.equal(s.seen.refunds.length, 2)
    const [first, second] = s.seen.refunds.map((x) => x.body)
    assert.equal(first.gasPayment, undefined)
    const q = gasQuote(payer.address)
    assert.deepEqual(Object.keys(second.gasPayment).sort(), ['authorization', 'signature'])
    assert.deepEqual({ ...second.gasPayment.authorization, validBefore: 0, nonce: 0 }, { ...q.authorization, validBefore: 0, nonce: 0 })
    const auth = second.gasPayment.authorization
    const signer = await recoverTypedDataAddress({ ...q.sign, message: auth, signature: second.gasPayment.signature })
    assert.equal(signer.toLowerCase(), payer.address.toLowerCase(), 'the gas payment is the payer\'s EIP-712 signature')
    assert.notEqual(second.signature, first.signature, 'a fresh proof')
    assert.equal((await proofSigner(second)).toLowerCase(), payer.address.toLowerCase())
    assert.equal(r.out.op, 'refunded')
    assert.equal(r.out.gasMicroUSD, 4029)
    assert.equal(r.out.returnedMicroUSD, 90000)
  } finally { await s.close() }
})

test('refund_quote when this key is not the payer: nothing is signed, the quote is explained', async () => {
  const other = privateKeyToAccount('0x' + '6b'.repeat(32))
  let n = 0
  const fetchFn = async () => { n++; return new Response(JSON.stringify(gasQuote(other.address)), { status: 409 }) }
  const a = await passRefund({ url: 'http://seller.test/refund', channelId: CHANNEL, signer: payer, fetchFn })
  assert.equal(n, 1)
  assert.equal(a.op, 'refund_failed')
  assert.equal(a.code, 'gas_payment_needed')
  assert.match(a.why, /signed by the channel's payer/)
})

test('request_open is retried after retry_after_seconds', async () => {
  let n = 0
  const waits = []
  const fetchFn = async () => { n++; return new Response(JSON.stringify(n < 3 ? { op: 'refund_failed', code: 'request_open', retry_after_seconds: 2 } : refunded().body), { status: n < 3 ? 409 : 200 }) }
  const a = await passRefund({ url: 'http://seller.test/refund', channelId: CHANNEL, signer: payer, fetchFn, wait: async (ms) => { waits.push(ms) } })
  assert.equal(a.op, 'refunded')
  assert.deepEqual(waits, [2000, 2000])
})

test('nothing_to_return: no second request, the numbers are shown, and --self-send is offered', async () => {
  const s = await fakeSeller({ refund: () => ({ status: 409, body: { op: 'refund_failed', code: 'nothing_to_return', why: 'not worth sending', leftMicroUSD: 300, returnedMicroUSD: 300, gasMicroUSD: 4029 } }) })
  try {
    const dir = stateWithChannel()
    const r = await bridge(['--refund'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/agents/mcp`, X402_STATE_DIR: dir })
    assert.equal(r.code, 1)
    assert.equal(s.seen.refunds.length, 1)
    assert.equal(r.out.code, 'nothing_to_return')
    assert.match(r.stderr, /300 micro-USD is left and sending it costs 4029/)
    assert.match(r.stderr, /--self-send/)
    assert.equal(channelFile(dir).chargedCumulativeAmount, '10000', 'the channel is left as it was')
  } finally { await s.close() }
})

test('nothing_to_return on a fully spent channel exits 0', async () => {
  const s = await fakeSeller({ refund: () => ({ status: 409, body: { op: 'refund_failed', code: 'nothing_to_return', why: 'nothing left to return — this channel is fully spent' } }) })
  try {
    const r = await bridge(['--refund'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/agents/mcp`, X402_STATE_DIR: stateWithChannel() })
    assert.equal(r.code, 0)
    assert.match(r.stderr, /fully spent/)
  } finally { await s.close() }
})

const signedRefund = { op: 'refund_signed', microUSD: 90000, transaction: { chainId: 8453, to: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003', data: '0xabcdef', value: '0' }, why: 'you asked to send it yourself' }

test('--self-send asks with selfSend: true; with no ETH it hands back the signed transaction', async () => {
  const s = await fakeSeller({ refund: (body) => (body.selfSend === true ? { status: 200, body: signedRefund } : { status: 400, body: { op: 'refund_failed', code: 'bad_request' } }) })
  const rpc = await fakeRpc({ eth_chainId: '0x2105', eth_estimateGas: '0x186a0', eth_gasPrice: '0x3b9aca00', eth_getBalance: '0x0' })
  try {
    const r = await bridge(['--refund', '--self-send'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/agents/mcp`, X402_STATE_DIR: stateWithChannel(), X402_RPC_URL: rpc.url })
    assert.equal(s.seen.refunds.length, 1)
    assert.equal(s.seen.refunds[0].body.selfSend, true)
    assert.equal(r.code, 1)
    assert.equal(r.out.op, 'refund_signed')
    assert.equal(r.out.sent, false)
    assert.deepEqual(r.out.transaction, signedRefund.transaction)
    assert.match(r.out.why, /too little ETH/)
    assert.ok(!rpc.seen.includes('eth_sendRawTransaction'))
  } finally { await s.close(); await rpc.close() }
})

test('selfSend with ETH: the key sends the signed refund and rebases the channel from the chain', async () => {
  const sent = []
  const store = new Map([[CHANNEL, { balance: '100000', chargedCumulativeAmount: '10000' }]])
  const storage = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v) } }
  const pub = {
    estimateGas: async () => 100000n, getGasPrice: async () => 1000000000n, getBalance: async () => 10n ** 18n,
    waitForTransactionReceipt: async ({ hash }) => ({ status: 'success', transactionHash: hash }),
    readContract: async ({ functionName, args }) => { assert.equal(functionName, 'channels'); assert.equal(args[0], CHANNEL); return [10000n, 10000n] },
  }
  const wallet = { sendTransaction: async (tx) => { sent.push(tx); return '0x' + '2'.repeat(8) } }
  const a = await sendSignedRefund({ answer: signedRefund, account: payer, pub, wallet, storage, channelId: CHANNEL })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].to.toLowerCase(), signedRefund.transaction.to.toLowerCase())
  assert.equal(sent[0].data, signedRefund.transaction.data)
  assert.equal(a.op, 'refunded')
  assert.equal(a.gasPaidBy, 'you')
  assert.deepEqual([store.get(CHANNEL).balance, store.get(CHANNEL).chargedCumulativeAmount], ['10000', '10000'])
})

test('the refund URL is read from the 402 refund sentence, else <base>/refund beside /mcp', () => {
  assert.equal(refundUrlOf({ refund: refundSentence('https://seller.example/wp-json/zeam-pass/refund') }), 'https://seller.example/wp-json/zeam-pass/refund')
  assert.equal(refundUrlOf({ refund: 'what you do not spend is yours' }), null)
  assert.equal(refundUrlOf(null), null)
  assert.equal(refundUrlBeside('https://seller.example/agents/mcp'), 'https://seller.example/agents/refund')
  assert.equal(refundUrlBeside('https://seller.example/agents/mcp/'), 'https://seller.example/agents/refund')
  const terms = passTerms('https://seller.example')
  const rpc = { jsonrpc: '2.0', id: 3, result: { isError: true, structuredContent: terms, content: [{ type: 'text', text: JSON.stringify(terms) }] } }
  assert.equal(refundUrlOf(termsInMcp(JSON.stringify(rpc), 'application/json')), 'https://seller.example/agents/refund')
  assert.equal(refundUrlOf(termsInMcp(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, 'text/event-stream')), 'https://seller.example/agents/refund')
  const textOnly = { ...rpc, result: { isError: true, content: rpc.result.content } }
  assert.equal(refundUrlOf(termsInMcp(JSON.stringify(textOnly), 'application/json')), 'https://seller.example/agents/refund')
})

test('a 402 heard over MCP names the refund URL, and --refund uses it; X402_GRANT rides every /mcp request', async () => {
  const s = await fakeSeller({ refund: () => refunded() })
  try {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
    const env = { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/agents/mcp`, X402_STATE_DIR: dir, X402_GRANT: 'grant-token-abc' }
    const call = await bridge(['--call', 'add', '{"a":1,"b":2}'], env)
    assert.equal(call.code, 0, call.stderr)
    assert.equal(call.stdout.trim(), '{"sum":3}')
    const calls = s.seen.mcp.filter((m) => m.method === 'tools/call')
    assert.equal(calls.length, 2, 'probe, then paid')
    assert.ok(s.seen.mcp.length >= 4)
    for (const m of s.seen.mcp) assert.equal(m.headers['x-grant'], 'grant-token-abc', `x-grant on ${m.method}`)
    assert.ok(existsSync(join(dir, 'seller.json')))
    assert.equal(JSON.parse(readFileSync(join(dir, 'seller.json'), 'utf8')).refund, `${s.base}/elsewhere/refund`)
    const seeded = stateWithChannel()
    copyFileSync(join(dir, 'seller.json'), join(seeded, 'seller.json'))
    const r = await bridge(['--refund'], { ...env, X402_STATE_DIR: seeded })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(s.seen.refunds.length, 1)
    assert.equal(s.seen.refunds[0].path, '/elsewhere/refund')
  } finally { await s.close() }
})

test('no X402_GRANT: no x-grant header on /mcp', async () => {
  const s = await fakeSeller()
  try {
    const r = await bridge(['--tools'], { X402_MCP_URL: `${s.base}/agents/mcp` })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(s.seen.mcp.length > 0)
    for (const m of s.seen.mcp) assert.equal(m.headers['x-grant'], undefined)
  } finally { await s.close() }
})

test('the HTTP client sends x-grant, learns the refund URL from a 402, and refunds there', async () => {
  const s = await fakeSeller({ refund: () => refunded() })
  const rpc = await fakeRpc({ eth_chainId: '0x2105', eth_call: '0x' + '0'.repeat(128) })
  try {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'))
    const c = client({ key: KEY, url: `${s.base}/agents`, stateDir: dir, rpcUrl: rpc.url, grant: 'grant-token-http', log: quiet })
    const r = await c.fetch(`${s.base}/agents/v1/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1,"b":2}' })
    assert.equal(r.status, 200)
    assert.equal(s.seen.http.length, 2, '402, then paid')
    for (const h of s.seen.http) assert.equal(h.headers['x-grant'], 'grant-token-http')
    assert.equal(JSON.parse(readFileSync(join(dir, 'seller.json'), 'utf8')).refund, `${s.base}/agents/refund`)
    const seeded = stateWithChannel()
    copyFileSync(join(dir, 'seller.json'), join(seeded, 'seller.json'))
    const c2 = client({ key: KEY, url: `${s.base}/agents`, stateDir: seeded, rpcUrl: rpc.url, log: quiet })
    const a = await c2.refund()
    assert.equal(a.op, 'refunded')
    assert.equal(s.seen.refunds.length, 1)
    assert.equal((await proofSigner(s.seen.refunds[0].body)).toLowerCase(), payer.address.toLowerCase())
    assert.equal(channelFile(seeded).chargedCumulativeAmount, '10000')
    assert.equal(s.seen.pay, 0)
    await c2.close()
    await c.close()
  } finally { await s.close(); await rpc.close() }
})

test('a refused payment is read from code, not error', () => {
  const as = (body) => ({ isError: true, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] })
  assert.equal(paymentRefused(as({ error: 'channel_state_mismatch', code: 'payment_invalid', accepts: [] })), true)
  assert.equal(paymentRefused({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'x', code: 'payment_invalid' }) }] }), true)
  assert.equal(paymentRefused(as({ x402Version: 2, error: 'invalid_batch_settlement_evm_signature' })), true)
  assert.equal(paymentRefused(as({ error: 'payment_invalid' })), false, 'error alone is an x402 code slot, not the verdict')
  assert.equal(paymentRefused(as({ code: 'price_changed', x402Version: 2, error: 'price_changed' })), false)
  assert.equal(paymentRefused({ isError: false, content: [] }), false)
})
