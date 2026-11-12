import { describe, expect, it } from "vitest";
import { badges, brier, reliability, resolve, type Forecast } from "./journal";

const mk = (p: Partial<Forecast>): Forecast => ({ id: Math.random().toString(), createdAt: 0, asset: "BTC", mode: "live", direction: "up", horizonMin: 60, prob: 0.7, priceAt: 100, invalidation: 95, counterArgument: "", rationale: "", ...p });

describe("journal calibration", () => {
  it("resolves only after the horizon", () => {
    expect(resolve(mk({}), 110, 59 * 60_000).outcome).toBeUndefined();
    expect(resolve(mk({}), 110, 60 * 60_000).outcome).toBe(1);
    expect(resolve(mk({ direction: "down" }), 110, 60 * 60_000).outcome).toBe(0);
  });
  it("computes Brier and reliability bins", () => {
    const fs = [mk({ prob: 0.8, outcome: 1 }), mk({ prob: 0.8, outcome: 0 }), mk({ prob: 0.6, outcome: 1 })];
    expect(brier(fs)).toBeCloseTo((0.04 + 0.64 + 0.16) / 3);
    const r = reliability(fs);
    expect(r.find((b) => b.lo === 0.8)!.observed).toBe(0.5);
  });
  it("never rewards frequency", () => {
    const fs = Array.from({ length: 12 }, (_, i) => mk({ createdAt: 0 + i }));
    expect(badges(fs, 0).find((b) => b.id === "patience")!.earned).toBe(false);
  });
});
