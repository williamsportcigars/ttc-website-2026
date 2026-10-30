# Project notes for Claude Code

## Clover data: always force a fresh sync before trusting it

The Clover MCP mirror (used via `mcp__Clover__*` tools) can serve stale data on
individual fields — stock counts and item-category links have both shown this.
`items.stock_count` in particular lags behind the real number; `item_stocks.quantity`
is the reliable source for stock. Category links ride along with the `items`
resource sync and can also be stale.

**At the start of any new conversation, or when resuming one, call
`mcp__Clover__sync_now` (e.g. `resources: ["items", "item_stocks"]`, or omit
`resources` for everything) before relying on any Clover-derived numbers or
reporting something as missing/zero/wrong.** This has already produced false
"0 in stock" and "no category" findings that turned out to be mirror lag, not
real gaps — don't repeat that mistake.
