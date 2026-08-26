# Security Policy

This tool holds a funded private key. Treat everything below as the threat model you are accepting
when you run it.

## Reporting a vulnerability

**info@zeamlabs.com** — put `SECURITY` in the subject.

We are a small operator, not a security team with a rota. What you can expect: an acknowledgement
within 72 hours, and an honest answer about whether we can fix it and when. If a report is credible
and we cannot fix it quickly, we will say so publicly here rather than sit on it quietly.

Please do not open a public issue for anything that could expose a user's key or funds. Anything
else — a crash, a wrong error message, a dependency concern — is fine in the open.

There is no bug bounty. We will credit you by name or handle if you want it.

## What this software does with your key

`X402_PRIVATE_KEY` is read from the environment at startup and passed to `privateKeyToAccount` and
`toClientEvmSigner` from `viem` and `@x402/evm`. It signs x402 vouchers and channel deposits locally.
It is never transmitted, logged, or written to disk by this code.

The bridge custodies nothing. Your funds sit as collateral in the upstream's settlement contract and
are withdrawable by your signature alone, subject to that contract's withdraw delay.

**Your exposure is the size of your deposit**, not the price of a call. The bridge pays automatically
against the terms the upstream quotes, up to the per-request ceiling, without asking you per call.
Fund a channel with what you are willing to lose to a dishonest or broken meter, and use a key that
holds nothing else.

## In scope

- Any path by which the private key leaves the machine, reaches disk, or enters a log
- Signing a voucher for more than the upstream quoted, or outside the channel it was scoped to
- Channel-state handling that causes a duplicate deposit or an unrecoverable channel
- Dependency confusion or a supply-chain path in how the tarball is fetched, pinned, or resolved
- Anything that lets an upstream server extract more than the per-request ceiling it advertised

## Out of scope

- The upstream server's metering being dishonest. That is a trust question, not a vulnerability in
  this client — the meter runs server-side and cannot be verified from here. Documented, not fixable.
- Vulnerabilities in `viem`, `@x402/*`, or the MCP SDK. Report those upstream; tell us too and we
  will bump the pin.
- Losing your own key or your own `X402_STATE_DIR`.

## Verifying what you are about to run

This package is **not published on npm**. `@zeam/x402-mcp-bridge` does not exist; an install line
naming it is wrong. The distribution is a tarball:

    curl -sO https://www.zeamprism.com/x402-mcp-bridge-1.4.9.tgz
    curl -s  https://www.zeamprism.com/x402-mcp-bridge-1.4.9.tgz.sha256
    sha256sum x402-mcp-bridge-1.4.9.tgz          # also quoted in services.json
    curl -s https://www.zeamprism.com/x402-mcp-bridge.mjs | less   # 637 lines

The checksum is published by us on our own domain. It proves the tarball was not altered in transit.
It does not prove we are honest — read the source, it is short on purpose, and it matches this
repository commit for commit.

`npx -y <url>` refetches on every launch, so a future version could differ from the one you audited.
If that matters to you, vendor the tarball at a known hash and run it from disk. Dependencies are
pinned to exact versions precisely so that the code under the code cannot move beneath you.

## Supported versions

The current release is the only supported one. There are no backported fixes.

