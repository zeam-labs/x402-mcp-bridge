# Changelog

## 3.1.0

- Line time is bought in milliseconds. A ZEAM :: Pass seller now tags `buy_time` `{"usd", "per": "ms", "ms"}`
  and takes `buy_time {"ms"}`; the bridge reads that price and buys `X402_LINE_AHEAD_MS` of it, never less than
  250 ms. 3.0.x understood only the older per-block tag, and against a seller that sells milliseconds it never
  bought time and paid per call.
- A seller on an older ZEAM :: Pass, tagging `buy_time` per block, is still read and still asked for blocks.
- An agent that calls `buy_time` itself through the bridge, with `ms` or with `blocks`, is priced correctly.

## 3.0.3

- No URL in the README or this changelog is followed by punctuation: plain-text link finders on package
  pages kept a trailing comma or bracket in the URL. No code changes.

## 3.0.2

- README reads in a narrow column: the `X402_LINE` and configuration tables are lists, and every code
  block fits 80 columns. No code changes.

## 3.0.1

- The npm page: keywords, author, homepage https://zeamprism.com/connect and LICENSE and CHANGELOG.md in the package.
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
