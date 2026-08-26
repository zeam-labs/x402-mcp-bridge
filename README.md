# x402-mcp-bridge

Source: <https://github.com/zeam-labs/x402-mcp-bridge>. Tarball and checksum:
<https://www.zeamprism.com/x402-mcp-bridge-1.4.8.tgz> ·
<https://www.zeamprism.com/x402-mcp-bridge-1.4.8.tgz.sha256>

The tarball is built from this source at the tagged version, and the checksum
above is of that build — verify it before you run anything.

Put a wallet in front of a paid MCP server.

## The line, and when this client drops it

The server holds an idle line for **5000ms** and bills for that time. This client drops its own line after **four tick intervals (1000ms)** of no use, so a pause costs you a reopen rather than four extra seconds of billing. That is deliberate and it is cheaper for you — but it means the `closesAfterIdleMs: 5000` you read in `services.json` is the server's ceiling, not this client's behaviour. A cold buyer measured a line dying three times in a twelve-second session and was right to call the two numbers a contradiction. Set `X402_LINE=off` to pay per call instead.

## The problem

A metered MCP endpoint takes payment inside the tool call's `params._meta` — a
signed x402 payload the **client** constructs, per call, against accumulating
channel state. No stock MCP client does that.

So when a paid endpoint advertises itself as an MCP server over streamable-HTTP —
which is exactly what a registry listing looks like — adding the URL to your
config gets you:

- `tools/list` — works
- any free tool — works
- **every paid tool — 402, forever**

Nothing is broken and nothing says what is missing. There is no API key to paste,
because there is no API key. Until now the only way to buy was to write your own
client.

## What this is

That client, wearing a stdio MCP server on the front. Your existing client talks
to this; this talks money upstream.

```json
{
  "mcpServers": {
    "prism": {
      "command": "npx",
      "args": ["-y", "https://www.zeamprism.com/x402-mcp-bridge-1.4.8.tgz"],
      "env": { "X402_PRIVATE_KEY": "0x..." }
    }
  }
}
```

The URL, not a package name — this is deliberately not published on npm, and an
install line that 404s is worse in a README than nowhere at all. Verify the
tarball before you run it; see [below](#why-the-versions-are-pinned-exactly).

The key stays on your machine. It signs vouchers locally; it is never sent
anywhere. The bridge holds no funds — your deposit sits in the upstream's
settlement contract, withdrawable by your side of the channel alone: the
`payer`, or the `payerAuthorizer` you named when the channel was opened, which
for most clients is the same key but need not be.

That escrow is not the seller's. It is x402's own batch-settlement contract,
hardcoded in [`@x402/evm`](https://www.npmjs.com/package/@x402/evm) and published
to npm by Coinbase in `2.12.0` on 2026-05-13 — two days before the contract
existed on Base. No owner, no pause, no upgrade, no sweep.

```
npm pack @x402/evm@2.12.0 && grep -rl 0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003 package/
```

## Permit2 assets need one approval first

USDT, DAI and WETH settle through Permit2, so the wallet must approve the Permit2
contract once before its first payment:

```
approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, amount)   // on the token
```

A bounded amount is enough. Without it the payment is refused with
`invalid_batch_settlement_evm_permit2_allowance_required`. USDC and EURC also
accept EIP-3009, which needs no approval at all.

## Paying without asking first

The stock x402 flow sends every call **unpaid**, reads the 402 it comes back
with, and then sends the same call again carrying payment. Two network round
trips for one call. At a 130ms round trip that is 260ms instead of 130ms — and on
a meter that bills time on the line, the buyer pays for a handshake nobody
needed. Those probes are also unpaid calls, and a server may cap how many of
those it will answer, which is how a funded wallet gets locked out of a channel
it has money in.

The terms are static and published, so this bridge reads them once from
`/.well-known/x402` at connect and attaches payment to its **first** request.
Measured against the same server: six calls issued six 402 challenges the old
way, and zero the new way.

A refused payment re-reads the terms and retries once, because quotes for
non-stable assets move with the oracle. Anything still failing falls back to the
old probe-then-pay path rather than dropping your call.

## Holding a line

Upstream sells **time**, not calls, and there is a cheaper way to buy it than
paying per call.

1. Deposit once — your first paid call does it for you.
2. Open a line on the endpoint's `/pay` websocket. It hands back a credential.
3. Call the `tick` tool on a steady cadence, passing `{line: "<credential>"}`.
   That is an ordinary paid call and it buys the milliseconds since your previous
   tick.
4. Every other call carries only `{line: "<credential>"}` and costs **nothing** —
   no signature per call, nothing to serialise, and as many calls in flight at
   once as you like.

Stop ticking and the line closes. An open line bills the whole time it is open,
so a line you forget costs at most one idle-close window past your last tick and
then stops existing.

**This bridge drives a line for you.** `X402_LINE` controls it:

| value | |
|---|---|
| `auto` *(default)* | open a line on your first call, hold it while calls keep coming, let it lapse when they stop. A line is cheaper than per-call pricing exactly while work is flowing and more expensive while it is not, so this follows the work. |
| `on` | hold a line from startup and keep paying whether or not anyone calls. |
| `off` | per-call payment only. Works against any x402 endpoint. |

If the server refuses a call because the line is gone — an ordinary rotate or
idle close — the bridge **reopens the line and retries**, and only pays per call
if that fails too. That ordering matters: falling straight through to per-call
payment turns one closed line into a signed payment per in-flight call,
serialised behind one channel, and when those run out of road they become unpaid
requests that burn the hourly ceiling and lock a funded wallet out of its own
channel. Measured before the fix, at 25-way concurrency: 3 of 12 calls served.
After: 200 of 200 across 8 line deaths.

**Cold starts.** A voucher signs a *cumulative* total, and that total is not on
the chain — the escrow knows your balance and what has been claimed, not what has
been metered. The only place it exists is the seller's 402. So on a cold start,
or whenever a payment is refused as stale, the bridge spends one probing round
trip to resync rather than handing you a failed call. Keep `X402_STATE_DIR` and
it happens once; lose it, or run the same key on a second machine, and it happens
again on the next call and then not after.

Two things worth knowing if you write your own client. Pay a tick against
`tickAccepts` from `/.well-known/x402` — same figure as a call, and the ceiling on
one tick. And never send two ticks at once: a voucher signs a cumulative total, so
a channel carries one payment at a time and an overlapping tick is refused as
`channel_busy`.

## Configuration

| variable | default | |
|---|---|---|
| `X402_PRIVATE_KEY` | — | **required.** Funds the channel and signs vouchers. |
| `X402_MCP_URL` | `https://mcp.zeamprism.com/mcp` | any x402-paid MCP endpoint |
| `X402_NETWORK` | `eip155:8453` | CAIP-2 |
| `X402_LINE` | `auto` | `auto`, `on` or `off` — see **Holding a line** above |
| `X402_ASSET` | first quoted | address or symbol, if you hold a specific token |
| `X402_RPC_URL` | the chain's own public RPC | chain reads. Point it at your own node — checking a seller's claims through the seller proves nothing. |
| `X402_STATE_DIR` | `~/.x402-mcp-bridge/<host>/<address>` | channel state |
| `X402_SALT` | scheme default | open a distinct channel. A bytes32 hex value |
| `X402_MAX_SPEND` | `10000000` (=$10) | ceiling on what **this run** may spend, in micro-USD. `0` removes it — see below |
| `X402_DEPOSIT_MULTIPLIER` | `400` | how much collateral a deposit puts in escrow, as a multiple of the quote. **The quote is 250 micro-USD, so the default deposit is 400 x 250 = 100,000 micro-USD = $0.10.** That is refundable collateral, not a charge — but it leaves your wallet the moment you open a channel, and no page said the number out loud until a cold buyer had to multiply two figures from two documents to find out what plugging in the config would cost it. Lower it if $0.10 is more than you want committed; the scheme refuses below 3x. |

## It stops spending when you stop watching

This process holds your key and pays without asking, so two limits bound it.

**It dies with its parent.** `npx` is a wrapper, so a client killing its child
kills npx and not this. A stdio server's parent going away closes stdin, and that
is what this watches. `X402_LINE=auto` also lapses an unused line after four tick
intervals; `X402_LINE=on` holds one regardless, so use it deliberately.

**It will not spend past `X402_MAX_SPEND`** (default 10,000,000 µUSD ≈ $10, about
three hours of held line), counted from where the meter stood at startup. On
reaching it the line drops and further calls return
`x402_bridge_spend_cap_reached` with the numbers. `X402_MAX_SPEND=0` removes it.

## Channel state matters

Keep `X402_STATE_DIR` on disk. A client that reconnects to an existing channel
with empty state pays a deposit it did not need, and can only recover if its
signer can **read the chain** — so this bridge always gives the signer a reader.
By default that reader is the upstream's own free `/bootstrap` surface, which
means recovery costs nothing and needs no RPC of your own.

Measured against `mcp.zeamprism.com`: fresh channel, first call 2.6s (one
on-chain deposit) then ~180ms per call. State deliberately wiped: healed and
served in 3.9s, then ~150ms.

## What it does not do

It does not custody funds, meter you, or add a fee. It forwards `tools/list` and
`tools/call` unchanged and attaches payment. If the upstream is free, you do not
need this.

## Why the versions are pinned exactly

An evaluating agent read all 637 lines of this file, found no exfiltration path,
and still would not run it: the dependencies floated on `"*"`, and the signing
happens inside them. `npx -y` today and `npx -y` next month could execute
different code against your key. They are pinned to exact versions now. Verify
what you are about to run:

    curl -sO https://www.zeamprism.com/x402-mcp-bridge-1.4.8.tgz
    curl -s  https://www.zeamprism.com/x402-mcp-bridge-1.4.8.tgz.sha256
    sha256sum x402-mcp-bridge-1.4.8.tgz          # also quoted in services.json
    curl -s https://www.zeamprism.com/x402-mcp-bridge.mjs | less   # 637 lines

The checksum is published by us, on our own domain, so it proves the tarball
was not altered in transit — not that we are honest. The file is short on
purpose: read it.

MIT.
