// Unit conversion for the spend cap. Pure, and separate from index.mjs so it can
// be tested without standing up an MCP server -- which is why the bug below
// shipped in the first place.
//
// THE BUG THIS EXISTS TO PREVENT: the micro-USD half of the conversion used to be
// a constant holding one seller's price, while the other half came from the
// seller's terms. Against that seller it was exact. Against anyone else it
// mis-scaled in the direction that costs money -- spend recorded low, so the cap
// never trips.

// Liberal in where it looks, strict about giving up. A server that does not say
// what a call costs in USD gets NO GUESS.
export function quoteFromTerms(j) {
  for (const c of [
    j?.rate?.deposit?.tickQuoteMicroUSD,
    j?.rate?.tickQuoteMicroUSD,
    j?.rate?.microUSDPerCall,
    j?.quoteMicroUSD,
  ]) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

// `units` are base units of the CHANNEL'S asset -- 6 decimals for USDC, 18 for
// WETH. They are not money until something converts them.
//
// `quotedAmount` must come from the accepts entry the selector actually chose,
// never accepts[0]: converting WETH units by a USDC quote is the same units bug
// wearing a different hat.
//
// With no published price we return the units unchanged and the CALLER must say
// so -- the number still bounds something real, it is just not denominated in
// dollars. Dressing base units up as micro-USD is exactly how a cap silently
// stops capping.
export function microUSDOf(units, quoteMicroUSD, quotedAmount) {
  const quoted = Number(quotedAmount ?? 0)
  if (quoteMicroUSD === null || quoteMicroUSD === undefined) return units
  if (!(quoted > 0)) return units
  return units * (quoteMicroUSD / quoted)
}
