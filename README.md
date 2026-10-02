# x402-mcp-bridge

[![ZEAM Prism MCP MCP connector – tool definition quality and endpoint health on Glama](https://glama.ai/mcp/connectors/com.zeamprism/prism-mcp/badges/score.svg)](https://glama.ai/mcp/connectors/com.zeamprism/prism-mcp)

`@zeam-labs/x402-mcp-bridge` 3.0.3 on npm. Source: https://github.com/zeam-labs/x402-mcp-bridge

A wallet in front of a paid MCP server. It pays per call, or buys time and rides a ZEAM :: Pass line. It works with
ZEAM Prism and with any ZEAM :: Pass seller.

## Run it

Export your key as `X402_PRIVATE_KEY`. It signs locally and is never sent.

    npx -y @zeam-labs/x402-mcp-bridge --tools
    npx -y @zeam-labs/x402-mcp-bridge --call call_rpc \
      '{"chain":"base","method":"eth_blockNumber","params":[]}'
    X402_MCP_URL=https://seller.example/agents/mcp \
      npx -y @zeam-labs/x402-mcp-bridge --call add '{"a":1,"b":2}'

`--times N` repeats a `--call` in one process. With no arguments the bridge is an MCP stdio server:

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "@zeam-labs/x402-mcp-bridge@3.0.3"],
      "env": { "X402_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Without a key it serves `tools/list` and the free tools; a paid call returns the seller's terms.

Results pass through whole: `content`, `structuredContent`, `isError` and `_meta`.

## Paying per call

1. The bridge reads the terms once from `/.well-known/x402`, or from the seller's first 402.
2. The first paid call deposits into a batch-settlement channel: price × `X402_DEPOSIT_MULTIPLIER` (default 40,
   minimum 3), raised to the seller's floor (the 402's `deposit` line, or `neededMicroUSD`). On Prism: 250 µUSD × 40 =
   $0.01.
3. Later calls sign vouchers against that deposit. No gas, no round trip to ask the price.

The deposit sits in x402's batch-settlement escrow `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003`, hardcoded in
`@x402/evm`. No owner, no pause, no upgrade. Only your key can withdraw it.

## Line time

A Pass seller that sells time lists `buy_time` and `line`, and tags its time tools `{"per":"time"}`. Prism:
1 µUSD per ms, $0.00025 per 250 ms block. A paid call without a line costs one block and runs at most 250 ms. On a
line a call costs the milliseconds it runs; calls at once burn once.

1. **Buy.** `buy_time {"blocks": N}` pays N blocks from the channel. The bridge buys
   `X402_LINE_AHEAD_MS` (default 2000 ms = 8 blocks), no more than the channel's collateral covers.
2. **Open.** `POST <base>/line {"op":"open","channelId"}` returns a message. The bridge signs it (EIP-191) with the
   payer key and posts `{"op":"prove","channelId","nonce","signature"}`; the answer carries the credential.
3. **Ride.** Each time-tool call carries the credential in `_meta["zeam-pass/line"]`; no payment per call. The answer's
   `_meta["zeam-pass/meter"]` states `msRemaining`.
4. **Meter.** After `X402_LINE_IDLE_MS` (default 1000) with no call the bridge sends `{"op":"off"}`; the next call
   sends `{"op":"on"}`. `meter_off` is switched on and called again; `out_of_time` buys twice the time and calls
   again; `line_unknown` opens a new line.
5. **Exit.** On exit the bridge sends `off`, then `close`. Unburned time comes back with a refund.

`X402_LINE`:

- `auto` (default): per call until 2 time-tool calls arrive within 10 s
  (`X402_AUTO_FAST_RUN`, `X402_AUTO_GAP_MS`), then a line while it holds time.
  A call cut at one block (`out_of_time`) is called again on a line.
- `on`: every time-tool call rides a line.
- `off`: per call only.

Tools priced per call never ride a line.

## Refunds

    npx -y @zeam-labs/x402-mcp-bridge --refund

1. The bridge posts `{channelId, issued, signature}` to the refund route the seller names (its 402 or
   `/.well-known/x402`), else `<base>/refund`. The key signs:

        ZEAM Pass refund
        channel: <channel id, lowercase>
        issued: <ISO time>

2. When the channel's fees cover the gas, the seller sends the balance and the unburned time: `returnedMicroUSD`,
   `timeReturnedMs`, `gasMicroUSD: 0`.
3. When they do not, the seller answers 409 `refund_quote` with the exact gas. The bridge signs a gasless USDC payment
   of it and posts again; one transaction returns the rest.
4. When the gas is more than what is left: `nothing_to_return` with the numbers.

`--refund --self-send` asks for a signed refund of all of it and sends it from your key, at your gas, if the key holds
ETH on Base. Otherwise it prints the transaction for any wallet to send.

No answer from the seller: `initiateWithdraw`, then `finalizeWithdraw` after the channel's `withdrawDelay`.

## Gates and grants

A Pass gate admits listed keys by a zero-value payment: nothing moves. `X402_GRANT` is sent as the `x-grant` header on
every request, over MCP and HTTP, so a key admitted by grant passes the gate.

## Any x402 URL

`x402_fetch` is offered beside the seller's tools. It calls a URL and pays a 402 under the x402 `exact` scheme.

    npx -y @zeam-labs/x402-mcp-bridge --call x402_fetch \
      '{"url":"https://api.example.com/v1/quote","body":{"symbol":"ETH"}}'

- `pay: false` returns the terms without paying.
- `maxAmount` (base units) refuses a larger quote before signing.
- USDC counts toward `X402_MAX_SPEND`. Another asset is paid only with `maxAmount`.
- A zero-value gate: signed, admitted, `paid: false`.

## Chain clients

```js
import { createPublicClient } from 'viem'
import { base } from 'viem/chains'
import { prism } from '@zeam-labs/x402-mcp-bridge/viem'

const client = createPublicClient({
  chain: base,
  transport: prism({ key: process.env.X402_PRIVATE_KEY }),
})
await client.getBlockNumber()
```

The ethers provider needs `ethers` 6 or later installed beside the bridge (`npm install ethers`).

```js
import { PrismProvider } from '@zeam-labs/x402-mcp-bridge/ethers'
const provider = new PrismProvider({ key: process.env.X402_PRIVATE_KEY })
```

1. The first request pays per call at `/rpc/base` (or `/rpc/eth`, `chain: 'eth'`) and funds the channel: 40 × the price,
   at least the seller's floor.
2. Then it opens a line, buys up to `aheadMs` (2000) of time from the collateral, and sends `x-line`.
3. The meter goes off after `idleMs` (1000) idle; the line is let go after `dropAfterMs` (10000).
4. `state()`, `close()`, `refund()`. Call `close()` or `refund()` before exit.

Options: `url`, `chain`, `network`, `stateDir`, `depositMultiplier`, `asset`, `salt`, `rpcUrl`, `grant`, `aheadMs`,
`idleMs`, `dropAfterMs`, `log`. The `X402_*` variables are the defaults; the state directory is shared with the bridge.

## Configuration

- `X402_PRIVATE_KEY` (no default): funds the channel and signs.
- `X402_MCP_URL` (default `https://mcp.zeamprism.com/mcp`): any x402 MCP
  endpoint.
- `X402_LINE` (default `auto`): `auto`, `on`, `off`.
- `X402_LINE_AHEAD_MS` (default `2000`): time bought per `buy_time`.
- `X402_LINE_IDLE_MS` (default `1000`): meter off after this idle.
- `X402_MAX_SPEND` (default `10000000`, $10): ceiling for this run, µUSD; `0`
  removes it.
- `X402_DEPOSIT_MULTIPLIER` (default `40`): deposit = price × this, at least
  the seller's floor; minimum 3.
- `X402_GRANT` (no default): `x-grant` on every request.
- `X402_RPC_URL` (default the chain's public RPC): your node for chain reads.
- `X402_STATE_DIR` (default `~/.x402-mcp-bridge/<host>/<address>`): channel
  state; keep it.
- `X402_SALT` (default the scheme's): a distinct channel.
- `X402_ASSET` (default first quoted): address or symbol.
- `X402_NETWORK` (default `eip155:8453`): CAIP-2.

USDT, DAI and WETH settle through Permit2: approve `0x000000000022D473030F116dDEE9F6B43aC78BA3` once. USDC needs no
approval.

## Limits

- It exits when stdin closes, and lets its line go.
- It stops at `X402_MAX_SPEND`: further calls return `x402_bridge_spend_cap_reached`.
- Lost state costs one probe to resync, then one deposit.

## Verify before you run it

The versions are pinned exactly.

    npm view @zeam-labs/x402-mcp-bridge@3.0.3 version dist.integrity
    npm pack @zeam-labs/x402-mcp-bridge@3.0.3
    less package/index.mjs

MIT.
