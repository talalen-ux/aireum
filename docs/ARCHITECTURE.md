# ATLAS architecture

## Today (this repository)

```
 Browser main thread (Next.js / React 19 / Tailwind v4)
   │  zustand store ◄── snapshots @ 2 Hz (+ incremental heatmap columns)
   ▼
 Web Worker: Engine
   ├─ Venue adapters (WebSocket + REST, one per venue)  ──► normalized events
   │     snapshot/delta sequencing · gap → resync · stale · drift · dedupe
   ├─ L2Book per stream (sequence-validated; invalid books produce no analytics)
   ├─ BarSeries 1m…1w (reference venue for consistency with history)
   ├─ FeatureStore → Regime engine (per TF, overlapping regimes, scores)
   ├─ Exhaustion engine · Detectors → OpportunityBook (lifecycle + audit digests)
   ├─ Micro: lead–lag xcorr · impact asymmetry · walls/pulls · large trades
   ├─ Liquidation model (3 leverage scenarios → uncertainty band)
   └─ Recorder (NDJSON) ⇄ Replay (same code path, simulated clock)
 Next.js route handlers: /api/analyst (Claude, grounded), /api/macro (FRED)
```

### Event contract
Every event carries `venue, symbol, market, contract kind, quote, multiplier, exchTs, recvTs, source, quality[]` (see `src/lib/core/types.ts`). Sizes are normalized to base units, OI to base and USD, and funding to an 8h equivalent. Feed state is explicit (`connecting · syncing · live · gap_recovering · stale · disconnected · unavailable`).

### Integrity guarantees
* A sequence break invalidates the book. Nothing derived from that book (depth, imbalance, walls, heatmap) is produced until a fresh snapshot arrives. Tests: `src/lib/engine/engine.test.ts` and `src/lib/adapters/adapters.test.ts`.
* Features use only data at or before each bar (a test mutates future bars and asserts past features are unchanged).
* Missing inputs give `null` and reduce *completeness*. They are never imputed.
* Every opportunity lifecycle transition is logged with an FNV-1a digest of its evidence.

## Production path (spec phases 1–5)

| Layer | Choice | Notes |
|---|---|---|
| Ingestion | Go or Rust services, one per venue, sharing the adapter semantics proven here | co-located; NTP/PTP-disciplined clocks; raw frames archived |
| Event log | Redpanda/Kafka, topic per venue×channel, keyed by symbol | replayable source of truth |
| Time series | ClickHouse (trades, book deltas, bars, features, signals) | materialized views for bars/features |
| Research | Parquet on object storage + DuckDB / Polars (`research/`) | point-in-time datasets |
| App records | PostgreSQL (users, journals, workspaces, audit) · Redis (hot snapshots) | |
| Observability | OpenTelemetry → Prometheus/Grafana | feed latency, gap rate, resync time, uptime SLOs |
| Security | read-only exchange keys by default, KMS-encrypted, least privilege, audit log; simulation strictly separated from any execution path | |

The browser engine works as a standalone client. In production the same detectors run server-side on the event log, so signals are reproducible across users and can be audited.
