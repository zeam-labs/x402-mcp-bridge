#!/usr/bin/env node
// Put a wallet in front of a paid MCP server.
//
// A metered MCP endpoint takes payment in the tool call's params._meta -- a
// signed x402 payload the CLIENT has to construct per call. No stock MCP client
// does that, so "add this URL to your config" gets you tools/list, a free
// sample if the server has one, and a 402 you cannot satisfy. The only way to
// buy was to write your own client.
//
// This is that client, wearing a stdio MCP server on the front. Your existing
// client speaks to this; this speaks money upstream. The key never leaves the
// machine you run it on.
//
//   { "prism": { "command": "npx", "args": ["-y", "@zeam/x402-mcp-bridge"],
//                "env": { "X402_PRIVATE_KEY": "0x..." } } }
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { wrapMCPClientWithPayment, x402Client } from '@x402/mcp'
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client'
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage'
import { toClientEvmSigner } from '@x402/evm'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http } from 'viem'
import * as chains from 'viem/chains'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const UPSTREAM = process.env.X402_MCP_URL ?? 'https://mcp.zeamprism.com/mcp'
const KEY = process.env.X402_PRIVATE_KEY ?? process.env.PRISM_PRIVATE_KEY
const NETWORK = process.env.X402_NETWORK ?? 'eip155:8453'
const WANT = (process.env.X402_ASSET ?? '').toLowerCase()
const NAME = process.env.X402_NAME ?? 'x402-bridge'
// stderr, never stdout: stdout IS the MCP transport, and one stray line there
// corrupts the framing and the client reports a protocol error instead of a
// message you can act on.
const log = (...a) => console.error('[x402-bridge]', ...a)

if (!KEY || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  log('set X402_PRIVATE_KEY to a 0x-prefixed 32-byte key. It stays on this machine;')
  log('it signs payment vouchers locally and is never sent anywhere.')
  process.exit(1)
}
const account = privateKeyToAccount(KEY)
const chainId = Number(String(NETWORK).split(':')[1])
const chain = Object.values(chains).find((c) => c?.id === chainId)
if (!chain) { log(`unknown network ${NETWORK}`); process.exit(1) }

// Channel state MUST persist. A client that reconnects with empty storage pays a
// fresh deposit it did not need, and can only recover if its signer can read the
// chain -- so we give it both: a directory, and a reader.
const stateDir = process.env.X402_STATE_DIR ??
  join(homedir(), '.x402-mcp-bridge', new URL(UPSTREAM).host, account.address.toLowerCase())
mkdirSync(stateDir, { recursive: true })

// Default the chain reader to the upstream's own free bootstrap surface, if it
// has one: recovery reads are exactly what such an endpoint exists to serve, and
// it means the operator needs no RPC of their own. Override with X402_RPC_URL.
const rpcUrl = process.env.X402_RPC_URL ?? new URL('/bootstrap', UPSTREAM).toString()
const pub = createPublicClient({ chain, transport: http(rpcUrl) })

const selector = (_version, accepts) => {
  if (WANT) {
    const hit = accepts.find((a) => String(a.asset).toLowerCase() === WANT ||
      String(a.extra?.name ?? '').toLowerCase() === WANT)
    if (hit) return hit
    log(`X402_ASSET=${WANT} is not among the ${accepts.length} quoted; falling back to the first`)
  }
  return accepts[0]
}

const payments = new x402Client(selector).register(NETWORK,
  new BatchSettlementEvmScheme(toClientEvmSigner(account, pub), {
    storage: new FileClientChannelStorage({ directory: stateDir }),
    ...(process.env.X402_SALT ? { salt: process.env.X402_SALT } : {}),
  }))

const upstream = wrapMCPClientWithPayment(
  new Client({ name: NAME, version: '1.0.0' }), payments, { autoPayment: true })
await upstream.connect(new StreamableHTTPClientTransport(new URL(UPSTREAM)))
log(`paying as ${account.address} -> ${UPSTREAM}`)
log(`channel state in ${stateDir}`)

const server = new Server({ name: NAME, version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await upstream.listTools()
  return { tools }
})
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // POSITIONAL. The payment wrapper has its own signature, and the object form
  // throws "expected string, received object at params.name" -- which reads as
  // the server's schema being broken when it is the wrapper's calling
  // convention.
  const out = await upstream.callTool(req.params.name, req.params.arguments ?? {})
  return out
})
await server.connect(new StdioServerTransport())
log('bridge up on stdio')
