// The first tests this package has ever had. It handles money.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quoteFromTerms, microUSDOf } from '../src/quote.mjs'
import { readFileSync } from 'node:fs'

// The REAL terms, captured from https://mcp.zeamprism.com/.well-known/x402 --
// not a fixture someone wrote to match the parser.
const REAL = JSON.parse(readFileSync(new URL('./fixtures/zeamprism-x402.json', import.meta.url)))

test('derives the price from the seller\'s own published terms', () => {
  assert.equal(quoteFromTerms(REAL), 250)
})

test('a server that publishes no price gets NO GUESS', () => {
  assert.equal(quoteFromTerms({ x402Version: 2, accepts: [{ amount: '1000' }] }), null)
  assert.equal(quoteFromTerms({ rate: {} }), null)
  assert.equal(quoteFromTerms({}), null)
  assert.equal(quoteFromTerms(null), null)
})

test('refuses nonsense prices rather than scaling by them', () => {
  for (const bad of [0, -1, 'abc', NaN, Infinity, null, undefined])
    assert.equal(quoteFromTerms({ rate: { deposit: { tickQuoteMicroUSD: bad } } }), null)
})

test('USDC against our own quote is the identity', () => {
  // 250 base units at 6 decimals IS 250 micro-USD. This is the case that made the
  // old hardcoded constant look correct.
  assert.equal(microUSDOf(250, 250, '250'), 250)
})

test('THE BUG: another seller\'s price is not ours', () => {
  // A server charging 1000 micro-USD a call. Spending 4000 of its units is $0.004.
  // The old code assumed 250 and reported a QUARTER of that, so a $10 cap did not
  // stop the agent until it had spent $40.
  assert.equal(microUSDOf(4000, 1000, '1000'), 4000)      // correct, price from terms
  assert.equal(microUSDOf(4000, 250, '1000'), 1000)       // what the constant did
})

test('WETH is converted by the WETH quote, not the USDC one', () => {
  // The measured failure: 131,218 wei read as 131,274,717,136 "micro-USD" and
  // tripped a $10 cap on a $0.0003 session.
  const wethQuote = '101843852466'                         // one call, in wei
  assert.ok(Math.abs(microUSDOf(101843852466, 250, wethQuote) - 250) < 1e-6)
  // converting those wei by the USDC entry instead is the bug in a new hat
  assert.ok(microUSDOf(101843852466, 250, '250') > 1e11)
})

test('no published price counts base units unchanged, never invents dollars', () => {
  assert.equal(microUSDOf(4000, null, '1000'), 4000)
  assert.equal(microUSDOf(4000, undefined, '1000'), 4000)
})

test('nothing paid yet still bounds something', () => {
  assert.equal(microUSDOf(4000, 250, 0), 4000)
  assert.equal(microUSDOf(4000, 250, undefined), 4000)
})
