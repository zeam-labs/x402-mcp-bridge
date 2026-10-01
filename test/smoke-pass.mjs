import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { refundUrlOf, refundUrlBeside, termsInMcp, askPassRefund } from '../refund.mjs'
import { bridge } from './fakes.mjs'

const bases = String(process.env.BRIDGE_SMOKE_URLS ?? '').split(/\s+/).filter(Boolean)
if (!bases.length) throw new Error('set BRIDGE_SMOKE_URLS to one or more Pass seller bases, e.g. https://seller.example/agents')

const sample = (schema) => {
  const out = {}
  for (const k of schema?.required ?? []) {
    const t = schema.properties?.[k]?.type
    out[k] = t === 'number' || t === 'integer' ? 1 : t === 'boolean' ? true : t === 'array' ? [] : t === 'object' ? {} : 'a'
  }
  return out
}

for (const base of bases) {
  test(`${base}: read-only — tools over MCP through the Bridge, a 402 over HTTP and MCP naming the refund URL, the refund route answering a signed Pass proof`, async () => {
    const listed = await bridge(['--tools'], { X402_MCP_URL: `${base}/mcp`, X402_RPC_URL: '' })
    assert.equal(listed.code, 0, listed.stderr)
    const names = JSON.parse(listed.stdout)
    assert.ok(names.length > 0, 'the Bridge lists the seller\'s tools')

    const list = await (await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text()
    const tools = JSON.parse(list.trimStart().startsWith('{') ? list : list.split(/\r?\n/).find((l) => l.startsWith('data:')).slice(5)).result.tools

    let terms = null, tool = null
    for (const t of tools) {
      const r = await fetch(`${base}/v1/${encodeURIComponent(t.name)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sample(t.inputSchema)) })
      if (r.status !== 402) continue
      const header = r.headers.get('payment-required')
      assert.ok(header, 'a 402 carries PAYMENT-REQUIRED')
      terms = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
      tool = t
      break
    }
    assert.ok(terms, 'some tool answers 402 unpaid')
    assert.ok(Array.isArray(terms.accepts) && terms.accepts.length > 0)
    const fromHttp = refundUrlOf(terms)
    assert.equal(fromHttp, refundUrlBeside(`${base}/mcp`), 'the 402 names <base>/refund')

    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool.name, arguments: sample(tool.inputSchema) } }) })
    assert.equal(refundUrlOf(termsInMcp(await mcp.text(), mcp.headers.get('content-type'))), fromHttp, 'the MCP 402 names the same refund URL')

    const signer = privateKeyToAccount(generatePrivateKey())
    const answer = await askPassRefund({ url: fromHttp, channelId: '0x' + randomBytes(32).toString('hex'), signer })
    assert.equal(answer.status, 404)
    assert.equal(answer.op, 'refund_failed')
    assert.equal(answer.code, 'unknown_channel')
    console.log(`# ${base}: ${names.length} tools; ${tool.name} is $${Number(terms.accepts[0].amount) / 1e6}; refund at ${fromHttp}; the route answered ${answer.code}`)
  })
}
