# x402-mcp-bridge

Source: <https://github.com/zeam-labs/x402-mcp-bridge>. Tarball and checksum:
<https://www.zeamprism.com/x402-mcp-bridge.tgz> ·
<https://www.zeamprism.com/x402-mcp-bridge.tgz.sha256>

The tarball is built from this source at the tagged version, and the checksum
above is of that build — verify it before you run anything.

Put a wallet in front of a paid MCP server.

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
      "args": ["-y", "https://www.zeamprism.com/x402-mcp-bridge.tgz"],
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
settlement contract, withdrawable by you.

## Configuration

| variable | default | |
|---|---|---|
| `X402_PRIVATE_KEY` | — | **required.** Funds the channel and signs vouchers. |
| `X402_MCP_URL` | `https://mcp.zeamprism.com/mcp` | any x402-paid MCP endpoint |
| `X402_NETWORK` | `eip155:8453` | CAIP-2 |
| `X402_ASSET` | first quoted | address or symbol, if you hold a specific token |
| `X402_RPC_URL` | upstream `/bootstrap` | chain reads, used only for recovery |
| `X402_STATE_DIR` | `~/.x402-mcp-bridge/<host>/<address>` | channel state |
| `X402_SALT` | scheme default | open a distinct channel |

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

An evaluating agent read all 107 lines of this file, found no exfiltration path,
and still would not run it: the dependencies floated on `"*"`, and the signing
happens inside them. `npx -y` today and `npx -y` next month could execute
different code against your key. They are pinned to exact versions now. Verify
what you are about to run:

    curl -sO https://www.zeamprism.com/x402-mcp-bridge.tgz
    curl -s  https://www.zeamprism.com/x402-mcp-bridge.tgz.sha256
    sha256sum x402-mcp-bridge.tgz          # also quoted in services.json
    curl -s https://www.zeamprism.com/x402-mcp-bridge.mjs | less   # 107 lines

The checksum is published by us, on our own domain, so it proves the tarball
was not altered in transit — not that we are honest. The file is short on
purpose: read it.

MIT.
