import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fakeTimeSeller, fakeRpc, bridge, BRIDGE, KEY } from './fakes.mjs'
import { lineUrlOf, lineUrlIn, lineUrlBeside, blockTerms, blocksFor, codeOf, meterOf, timeOf, lineMessage } from '../line.mjs'
import { refundUrlInTerms } from '../refund.mjs'

const rpcAnswers = { eth_chainId: '0x2105', eth_call: '0x' + '0'.repeat(128) }
const fresh = () => mkdtempSync(join(tmpdir(), 'bridge-line-'))
const linesOf = (s) => s.seen.line.map((x) => x.op)

test('line text, line URL, block terms and block sizing', () => {
  assert.equal(lineMessage('0xAB', 'n1'), 'ZEAM Pass line\nchannel: 0xab\nnonce: n1')
  assert.equal(lineUrlIn('Open a line: POST https://s.example/agents/line {"op":"open"}'), 'https://s.example/agents/line')
  assert.equal(lineUrlIn('POST https://s.example/agents/lines'), null)
  assert.equal(lineUrlOf({ line: { open: 'POST https://mcp.prism.example/line {"op":"open","channelId"} -> a message' } }), 'https://mcp.prism.example/line')
  assert.equal(lineUrlOf({ time: 'Line time: … Open a line: POST https://s.example/wp-json/zeam-pass/line {"op":"open"}' }), 'https://s.example/wp-json/zeam-pass/line')
  assert.equal(lineUrlBeside('https://s.example/agents/mcp'), 'https://s.example/agents/line')
  const t = blockTerms({ x402Version: 2, accepts: [{ amount: '250' }, { amount: '300' }] }, 8)
  assert.deepEqual(t.accepts.map((a) => a.amount), ['2000', '2400'])
  assert.equal(blockTerms(t, 1), t)
  const time = timeOf({ usd: '0.00025', per: 'block', blockMs: 250, maxBlocks: 14400 })
  assert.deepEqual(time, { blockMicro: 250, blockMs: 250, maxBlocks: 14400 })
  assert.equal(timeOf({ per: 'time' }), null)
  assert.equal(blocksFor({ wantMs: 2000, time }), 8)
  assert.equal(blocksFor({ wantMs: 2000, time, availableMicro: 1000 }), 4, 'no more than the collateral covers')
  assert.equal(blocksFor({ wantMs: 2000, time, availableMicro: 100 }), 1, 'one block when it carries a top-up')
  assert.equal(blocksFor({ wantMs: 1e9, time: { ...time, maxBlocks: 10 } }), 10)
  const fail = (b) => ({ isError: true, structuredContent: b, content: [{ type: 'text', text: JSON.stringify(b) }] })
  assert.equal(codeOf(fail({ error: 'meter_off' })), 'meter_off')
  assert.equal(codeOf(fail({ error: 'x', code: 'payment_invalid' })), 'payment_invalid')
  assert.equal(codeOf({ isError: true, content: [{ type: 'text', text: '{"error":"out_of_time"}' }] }), 'out_of_time')
  assert.equal(codeOf({ content: [{ type: 'text', text: '{"error":"no"}' }] }), null, 'a result that is not an error has no code')
  assert.deepEqual(meterOf({ _meta: { 'zeam-pass/meter': { msRemaining: 5 } } }), { msRemaining: 5 })
  assert.equal(refundUrlInTerms({ refund: { route: 'POST http://p.example/refund', how: 'POST /refund' } }), 'http://p.example/refund')
  assert.equal(refundUrlInTerms({ refund: 'Refund: POST https://s.example/agents/refund with {…}' }), 'https://s.example/agents/refund')
})

test('auto: the first call pays per call, calls that keep coming open a line, buy time and ride it; the line is let go at exit', async () => {
  const s = await fakeTimeSeller()
  const rpc = await fakeRpc(rpcAnswers)
  try {
    const r = await bridge(['--call', 'call_rpc', '{"method":"eth_blockNumber"}', '--times', '3'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: fresh(), X402_RPC_URL: rpc.url })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(r.stdout.trim().split('\n'), ['{"result":"0x10"}', '{"result":"0x10"}', '{"result":"0x10"}'])
    const rpcCalls = s.seen.calls.filter((c) => c.name === 'call_rpc')
    assert.deepEqual(rpcCalls.map((c) => [c.paid, Boolean(c.line)]), [[false, false], [true, false], [false, true], [false, true]], 'probe, paid, then two rides')
    assert.deepEqual(s.seen.paid.map((p) => [p.name, p.amount, p.type]), [['call_rpc', '250', 'deposit'], ['buy_time', '2000', 'voucher']], 'one deposit, then 8 blocks out of it')
    assert.deepEqual(linesOf(s), ['open', 'prove', 'off', 'close'])
    const ch = [...s.channels.values()][0]
    assert.equal(ch.ms, 2000 - 80, 'two 40 ms calls burned')
    assert.equal(rpcCalls[2].line, rpcCalls[3].line)
  } finally { await s.close(); await rpc.close() }
})

test('X402_LINE=off: every call pays, no line', async () => {
  const s = await fakeTimeSeller()
  const rpc = await fakeRpc(rpcAnswers)
  try {
    const r = await bridge(['--call', 'call_rpc', '{}', '--times', '3'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: fresh(), X402_RPC_URL: rpc.url, X402_LINE: 'off' })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(s.seen.line.length, 0)
    assert.deepEqual(s.seen.paid.map((p) => p.name), ['call_rpc', 'call_rpc', 'call_rpc'])
  } finally { await s.close(); await rpc.close() }
})

test('a per-call tool never rides a line', async () => {
  const s = await fakeTimeSeller()
  const rpc = await fakeRpc(rpcAnswers)
  try {
    const r = await bridge(['--call', 'add', '{"a":1,"b":2}', '--times', '3'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: fresh(), X402_RPC_URL: rpc.url, X402_LINE: 'on' })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(s.seen.line.length, 0)
    assert.ok(s.seen.calls.every((c) => !c.line))
    assert.deepEqual(s.seen.paid.map((p) => p.name), ['add', 'add', 'add'])
  } finally { await s.close(); await rpc.close() }
})

test('a call that needs more than one block is called again on a line, with enough time bought', async () => {
  const s = await fakeTimeSeller()
  const rpc = await fakeRpc(rpcAnswers)
  try {
    const r = await bridge(['--call', 'slow_rpc', '{}'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: fresh(), X402_RPC_URL: rpc.url })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.equal(r.stdout.trim(), '{"result":"0x10"}')
    const slow = s.seen.calls.filter((c) => c.name === 'slow_rpc')
    assert.deepEqual(slow.slice(0, 2).map((c) => [c.paid, Boolean(c.line)]), [[false, false], [true, false]], 'probe, then paid per call')
    assert.ok(slow.slice(2).every((c) => c.line && !c.paid), 'then only on the line')
    assert.ok(s.seen.paid.slice(1).every((p) => p.name === 'buy_time'), JSON.stringify(s.seen.paid))
    assert.ok(s.seen.paid.length <= 3, 'a short line buys more, doubling, not forever')
    assert.match(r.stderr, /needs more than one block/)
  } finally { await s.close(); await rpc.close() }
})

test('a meter that is off is switched on, and a line that runs out buys more time', async () => {
  const s = await fakeTimeSeller({ meterOnAtProve: false, callMs: 1500 })
  const rpc = await fakeRpc(rpcAnswers)
  try {
    const r = await bridge(['--call', 'call_rpc', '{}', '--times', '3'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: fresh(), X402_RPC_URL: rpc.url })
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(linesOf(s).slice(0, 3), ['open', 'prove', 'on'])
    const buys = s.seen.paid.filter((p) => p.name === 'buy_time')
    assert.ok(buys.length >= 2, `bought again when the time ran out: ${JSON.stringify(s.seen.paid)}`)
    assert.ok(s.seen.calls.filter((c) => c.name === 'call_rpc' && c.line).length >= 2)
  } finally { await s.close(); await rpc.close() }
})

test('the line URL and the refund route come from the seller\'s well-known terms', async () => {
  const s = await fakeTimeSeller({ root: '/x', wellKnown: true, refund: (b, n, channels) => ({ status: 200, body: { op: 'refunded', returnedMicroUSD: 7000, gasMicroUSD: 0, timeReturnedMs: channels.get(b.channelId)?.ms ?? 0, transaction: '0x' + '2'.repeat(8) } }) })
  const rpc = await fakeRpc(rpcAnswers)
  try {
    const dir = fresh()
    const env = { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: dir, X402_RPC_URL: rpc.url, X402_LINE: 'on' }
    const r = await bridge(['--call', 'call_rpc', '{}', '--times', '2'], env)
    assert.equal(r.code, 0, r.stderr)
    assert.ok(s.seen.line.length >= 2)
    const back = await bridge(['--refund'], env)
    assert.equal(back.code, 0, back.stderr)
    assert.equal(s.seen.refunds.length, 1)
    assert.equal(back.out.timeReturnedMs, 2000 - 40)
    assert.match(back.stderr, /1960 ms of unburned line time/)
  } finally { await s.close(); await rpc.close() }
})

test('structuredContent, isError and _meta reach the MCP client unchanged', async () => {
  const s = await fakeTimeSeller()
  const rpc = await fakeRpc(rpcAnswers)
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE], env: { PATH: process.env.PATH, HOME: process.env.HOME, X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: fresh(), X402_RPC_URL: rpc.url }, stderr: 'ignore' })
  const c = new Client({ name: 'test', version: '1' })
  try {
    await c.connect(transport)
    const { tools } = await c.listTools()
    assert.ok(tools.some((t) => t.name === 'x402_fetch'), 'x402_fetch is offered beside the seller\'s tools')
    const free = await c.callTool({ name: 'get_terms', arguments: {} })
    assert.deepEqual(free.structuredContent, { free: true })
    assert.equal(free._meta['fake/free'], true)
    const paid = await c.callTool({ name: 'add', arguments: { a: 2, b: 3 } })
    assert.deepEqual(paid.structuredContent, { sum: 5 })
    assert.equal(paid._meta['x402/payment-response'].success, true)
    const first = await c.callTool({ name: 'call_rpc', arguments: {} })
    assert.deepEqual(first.structuredContent, { result: '0x10' })
    const ride = await c.callTool({ name: 'call_rpc', arguments: {} })
    assert.deepEqual(ride.structuredContent, { result: '0x10' })
    assert.equal(typeof ride._meta['zeam-pass/meter'].msRemaining, 'number')
    const err = await c.callTool({ name: 'get_terms', arguments: { fail: true } })
    assert.equal(err.isError, true)
    assert.deepEqual(err.structuredContent, { error: 'tool_failed', tool: 'get_terms' })
  } finally { await c.close().catch(() => {}); await s.close(); await rpc.close() }
})

test('the chain transport: the first request pays, then it opens a line over HTTP, buys blocks at /v1/buy_time, rides with x-line, and turns the meter off when idle', async () => {
  const s = await fakeTimeSeller({ root: '', wellKnown: true })
  const rpc = await fakeRpc(rpcAnswers)
  const { client } = await import('../pay.mjs')
  const c = client({ key: KEY, url: s.base, stateDir: fresh(), rpcUrl: rpc.url, idleMs: 100, log: () => {} })
  try {
    const call = async () => (await c.fetch(c.door, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' })).json()
    for (let i = 0; i < 3; i++) assert.equal((await call()).result, '0x10')
    assert.deepEqual(s.seen.http.filter((h) => h.name === 'rpc').map((h) => [h.paid, Boolean(h.line)]), [[false, false], [true, false], [false, true], [false, true]])
    assert.deepEqual(s.seen.paid.map((p) => [p.name, p.amount, p.type]), [['rpc', '250', 'deposit'], ['buy_time', '2000', 'voucher']], 'a deposit of 40 blocks; 8 of them buy time')
    assert.deepEqual(linesOf(s).slice(0, 2), ['open', 'prove'])
    const st = c.state()
    assert.ok(st.line && st.metering && st.msRemaining === 2000 - 80, JSON.stringify(st))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(c.state().metering, false, 'idle: meter off')
    assert.equal(linesOf(s).at(-1), 'off')
    assert.equal((await call()).result, '0x10')
    assert.equal(linesOf(s).at(-1), 'on', 'the next call switches it on')
  } finally { await c.close(); await s.close(); await rpc.close() }
})

test('the deposit reaches the seller\'s floor, read from its terms', async () => {
  const { depositFloorOf } = await import('../client.mjs')
  assert.equal(depositFloorOf({ deposit: 'First call on a channel deposits at least $0.02933. Later calls spend it.' }), 29330)
  assert.equal(depositFloorOf({ deposit: 'First call on a channel deposits at least $0.00293.' }), 2930)
  assert.equal(depositFloorOf({ neededMicroUSD: 2922 }), 2922)
  assert.equal(depositFloorOf({}), null)
  const s = await fakeTimeSeller({ floor: 29330 })
  const rpc = await fakeRpc(rpcAnswers)
  try {
    const r = await bridge(['--call', 'call_rpc', '{}'], { X402_PRIVATE_KEY: KEY, X402_MCP_URL: `${s.base}/mcp`, X402_STATE_DIR: fresh(), X402_RPC_URL: rpc.url })
    assert.equal(r.code, 0, r.stderr + r.stdout)
    assert.deepEqual(s.seen.deposits, ['29330'], 'one deposit, at the floor, not 40 × 250 = 10000')
  } finally { await s.close(); await rpc.close() }
  const s2 = await fakeTimeSeller({ root: '', floor: 29330 })
  const rpc2 = await fakeRpc(rpcAnswers)
  const { client } = await import('../pay.mjs')
  const c = client({ key: KEY, url: s2.base, stateDir: fresh(), rpcUrl: rpc2.url, log: () => {} })
  try {
    const r = await c.fetch(c.door, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
    assert.equal(r.status, 200)
    assert.deepEqual(s2.seen.deposits, ['29330'])
  } finally { await c.close(); await s2.close(); await rpc2.close() }
})
