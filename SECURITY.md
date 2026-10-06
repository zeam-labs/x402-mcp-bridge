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

The package is `@zeam-labs/x402-mcp-bridge` on npm. Check what you are about to run
before you run it:

    npm view @zeam-labs/x402-mcp-bridge dist.integrity version
    npm pack @zeam-labs/x402-mcp-bridge && tar xzf zeam-labs-x402-mcp-bridge-*.tgz
    less package/index.mjs

npm's integrity hash proves the bytes you fetched are the bytes that were published.
It does not prove we are honest — read the source, it is short on purpose, and it matches this
repository commit for commit.

`npx -y @zeam-labs/x402-mcp-bridge` fetches the current release every launch, so a future version
could differ from the one you audited. Pin the version you audited — `npx -y @zeam-labs/x402-mcp-bridge@<version>` — or
vendor the tarball at a known integrity hash and run it from disk. Dependencies are
pinned to exact versions precisely so that the code under the code cannot move beneath you.

## Supported versions

The current release is the only supported one. There are no backported fixes.

