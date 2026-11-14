# ATLAS Profit Harvesting — Implementation Reference

## Example (hypothetical, not live)
Linear BTCUSDT long, E=$67,000, q=2 BTC, 0.06% taker each side, no funding or slippage.

### A: Partial closing
After a $100 favorable move, close c=1 BTC at $67,100. Gross=$100. Entry fee=$40.20; exit fee=$40.26; net realized=$19.54. Remaining 1 BTC still carries full market risk. The combined net PNL is not $100 and may become negative if BTC falls.

To net $100 on 1 BTC after two 0.06% taker fees, solve `X=(100+67000*1.0006)/0.9994`, giving approximately $67,180.57. Fees and fills may differ.

### B: Standalone trades
For each independent 1 BTC long with same E and fees, $100 net requires approximately $180.57 favorable price movement, before slippage/funding. On each closure, return to flat; next entry requires fresh signal and risk allocation.

For a $100 net winner versus $250 net loser, break-even win probability is `250/(100+250)=71.43%` before any omitted costs. A high hit rate alone is insufficient.

## Suggested API objects
```json
{
  "market_observation": {
    "venue": "kucoin",
    "symbol": "BTCUSDT",
    "event_time_utc": "ISO-8601",
    "ingest_time_utc": "ISO-8601",
    "mark": null,
    "bid": null,
    "ask": null,
    "spread_bps": null,
    "spot_cvd": null,
    "perp_cvd": null,
    "open_interest": null,
    "funding_rate": null,
    "data_quality": "unavailable|degraded|verified"
  },
  "position": {
    "direction": "long|short",
    "contract_type": "linear|inverse|other",
    "quantity": null,
    "average_entry": null,
    "isolated_collateral": null,
    "leverage": null,
    "venue_liquidation_price": null,
    "stop_price": null,
    "cumulative_realized_net": null,
    "unrealized_net": null,
    "pending_reduce_only_orders": []
  },
  "risk_budget": {
    "cumulative_loss_limit_usd": null,
    "realized_losses_usd": null,
    "other_open_risk_usd": null,
    "remaining_loss_allowance_usd": null
  }
}
```

## Required ATLAS widgets
- Strategy toggle: Core Harvest vs Independent Micro-Profit.
- Net profit slider: default $100, configurable.
- Fee-aware required move, maker/taker choice, spread/slippage estimate.
- Remaining-position exposure and combined realized/unrealized equity graph.
- Venue liquidation buffer with live data freshness indicator.
- Cumulative risk budget and loss-limit guardrail.
- Exit ladder visualization, reduce-only order coverage, and order reconciliation.
- Replay comparison with baseline and full trade cost attribution.
- Evidence panel: bull/bear, spot/perp divergence, OI, funding, liquidations and macro catalysts.

## Minimum unit tests
1. Long and short net-target formulas invert net-PNL equations.
2. Closing 25% of a position decreases exposure by exactly 25% absent adds.
3. Partial profits never conceal a larger unrealized loss.
4. Aggregate reduce-only close quantities never exceed remaining position.
5. Stop beyond liquidation is flagged as unsafe.
6. Missing exchange maintenance tiers suppresses precise liquidation output.
7. Cumulative realized losses decrease remaining budget across sessions.
8. Stale feeds never produce a 'live' signal.
9. A $100 gross win is not mislabeled $100 net.
10. Risk-adjusted comparison uses same maximum dollar risk, not merely same leverage.

## Suggested Claude project usage
Install folder as `.claude/skills/atlas-futures-profit-harvesting/` with SKILL.md and references/implementation.md. Invoke with: 'Use the atlas-futures-profit-harvesting skill to compare a partial-close BTC position with repeated $100 net BTC trades, using current venue data and the remaining account-wide loss budget. Show both long and short cases and reject unsupported signals.'
