# Changelog

## 3.0.1

- The npm page: keywords, author, homepage https://zeamprism.com/connect, LICENSE and CHANGELOG.md in the package.
  The README says `ethers` must be installed for the ethers provider and no longer names test files the package
  does not carry. No code changes.

## 3.0.0

- Lines are ZEAM :: Pass lines: `POST <base>/line` open → EIP-191 proof by the payer key → credential, sent as
  `_meta["zeam-pass/line"]` (MCP) or `x-line` (HTTP). The `/pay` websocket is gone.
- Time is bought with `buy_time {blocks}`, N × the block price, no more than the collateral covers.
- Meter: `off` after 1000 ms idle, `on` before the next call; `meter_off`, `out_of_time` and `line_unknown` are handled
  by code.
- Auto mode: per call until 2 time-tool calls arrive within 10 s, then a line; a call cut at one block is called again
  on a line. Per-call tools never ride.
- Refunds: `POST <base>/refund` signed `ZEAM Pass refund`; the 409 `refund_quote` is paid with a signed USDC gas
  payment; `--self-send`; unburned time is returned (`timeReturnedMs`).
- A deposit reaches the seller's floor, read from the 402's `deposit` line or `neededMicroUSD`. The chain transport
  deposits 40 × the price, like the bridge (it was the scheme's 5).
- `X402_GRANT` is sent as `x-grant` on every request.
- `structuredContent`, `isError` and `_meta` reach the MCP client unchanged.
- `x402_fetch`: pay any x402 URL under `exact`, or pass a Pass gate with a zero-value payment.
- `--times N` repeats a `--call` in one process.
