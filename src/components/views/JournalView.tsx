"use client";

import { useEffect, useState } from "react";
import { useAtlas } from "@/lib/state/store";
import { badges, brier, reliability, resolve, type Forecast } from "@/lib/journal/journal";
import { Badge, Card, cn, fmt } from "../ui";

const KEY = "atlas.journal.v1";
const load = (): Forecast[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } };
const save = (f: Forecast[]) => { try { localStorage.setItem(KEY, JSON.stringify(f)); } catch { /* ignore */ } };

export function JournalView() {
  const snap = useAtlas((s) => s.snap);
  const [fs, setFs] = useState<Forecast[]>([]);
  const [form, setForm] = useState({ direction: "up" as "up" | "down", horizonMin: 60, prob: 0.6, invalidation: "", counter: "", rationale: "" });
  useEffect(() => setFs(load()), []);
  useEffect(() => {
    if (!snap?.price) return;
    const next = fs.map((f) => (f.asset === snap.asset && f.mode === snap.mode ? resolve(f, snap.price!, snap.ts) : f));
    if (next.some((f, i) => f !== fs[i])) { setFs(next); save(next); }
  }, [snap?.ts]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    if (!snap?.price) return;
    const f: Forecast = { id: crypto.randomUUID(), createdAt: snap.ts, asset: snap.asset, mode: snap.mode, direction: form.direction, horizonMin: form.horizonMin, prob: form.prob, priceAt: snap.price, invalidation: form.invalidation ? Number(form.invalidation) : null, counterArgument: form.counter, rationale: form.rationale };
    const next = [f, ...fs];
    setFs(next); save(next);
    setForm({ ...form, invalidation: "", counter: "", rationale: "" });
  };
  const b = brier(fs);
  const rel = reliability(fs);
  const notes = (() => { try { return Number(localStorage.getItem("atlas.counterNotes") ?? 0); } catch { return 0; } })();

  return (
    <div className="grid gap-3 xl:grid-cols-[380px_1fr]">
      <div className="space-y-3">
        <Card title="Log a forecast" subtitle={snap?.price ? `at ${fmt.px(snap.price)} · ${snap.mode}` : "waiting for price"}>
          <div className="space-y-2 text-[12px]">
            <div className="flex gap-2">
              {(["up", "down"] as const).map((d) => <button key={d} type="button" onClick={() => setForm({ ...form, direction: d })} className={cn("flex-1 rounded border py-1 cursor-pointer", form.direction === d ? (d === "up" ? "border-bull text-bull" : "border-bear text-bear") : "border-line text-dim")}>{d === "up" ? "Higher" : "Lower"}</button>)}
            </div>
            <label className="block text-[10px] text-mute">Horizon
              <select value={form.horizonMin} onChange={(e) => setForm({ ...form, horizonMin: Number(e.target.value) })} className="mt-0.5 w-full rounded border border-line bg-bg px-2 py-1 text-[12px] text-fg">
                {[15, 60, 240, 1440].map((h) => <option key={h} value={h}>{h < 60 ? `${h} min` : `${h / 60} h`}</option>)}
              </select>
            </label>
            <label className="block text-[10px] text-mute">Stated probability: <span className="text-fg tnum">{Math.round(form.prob * 100)}%</span>
              <input type="range" min={0.5} max={0.95} step={0.05} value={form.prob} onChange={(e) => setForm({ ...form, prob: Number(e.target.value) })} className="w-full accent-[#31B996]" />
            </label>
            <input placeholder="Invalidation price (required for Risk Architect)" value={form.invalidation} onChange={(e) => setForm({ ...form, invalidation: e.target.value })} className="w-full rounded border border-line bg-bg px-2 py-1" inputMode="decimal" />
            <textarea placeholder="Strongest counterargument to your own view" value={form.counter} onChange={(e) => setForm({ ...form, counter: e.target.value })} rows={2} className="w-full rounded border border-line bg-bg px-2 py-1" />
            <textarea placeholder="Rationale (which evidence?)" value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} rows={2} className="w-full rounded border border-line bg-bg px-2 py-1" />
            <button type="button" disabled={!snap?.price} onClick={add} className="w-full rounded-md bg-elev border border-line py-1.5 hover:border-info/60 cursor-pointer disabled:opacity-40">Record forecast</button>
            <p className="text-[10px] text-mute">Scored on calibration (Brier), not on profit. No leverage, streaks or leaderboards. Stored only in this browser.</p>
          </div>
        </Card>
        <Card title="Discipline badges">
          <ul className="space-y-1.5">
            {badges(fs, notes).map((x) => (
              <li key={x.id} className="flex items-start gap-2 text-[11px]">
                <span className={cn("mt-0.5 h-2 w-2 rounded-full shrink-0", x.earned ? "bg-bull" : "bg-line")} />
                <div className="flex-1"><div className={x.earned ? "text-fg" : "text-dim"}>{x.name}</div><div className="text-[10px] text-mute">{x.desc}</div></div>
                <span className="text-[10px] text-mute tnum">{x.progress}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="space-y-3">
        <Card title="Calibration" subtitle="Reliability: stated vs observed hit rate per probability bin" right={<Badge tone="info">Brier {b?.toFixed(3) ?? "—"}</Badge>}>
          <div className="grid grid-cols-5 gap-2">
            {rel.map((r) => (
              <div key={r.lo} className="text-center text-[10px]">
                <div className="relative mx-auto h-24 w-8 rounded bg-elev overflow-hidden">
                  {r.observed !== null && <div className="absolute bottom-0 w-full bg-info/70" style={{ height: `${r.observed * 100}%` }} />}
                  {r.stated !== null && <div className="absolute w-full border-t-2 border-warn" style={{ bottom: `${r.stated * 100}%` }} />}
                </div>
                <div className="mt-1 text-dim tnum">{Math.round(r.lo * 100)}–{Math.min(100, Math.round(r.hi * 100))}%</div>
                <div className="text-mute">n={r.n}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-mute">Bar = observed frequency, amber line = average stated probability. Perfect calibration: line meets bar top. Brier 0.25 = coin-flip baseline at 50%.</p>
        </Card>
        <Card title="Forecast log" bodyClass="p-0 overflow-x-auto">
          <table className="w-full min-w-[620px] text-[11px] tnum">
            <thead><tr className="text-left text-mute border-b border-line/60">{["Logged", "Mode", "Call", "p", "Horizon", "At", "Invalid.", "Result"].map((h) => <th key={h} className="px-2 py-1.5 font-normal">{h}</th>)}</tr></thead>
            <tbody>
              {fs.map((f) => (
                <tr key={f.id} className="border-b border-line/30" title={`${f.rationale}\nCounter: ${f.counterArgument}`}>
                  <td className="px-2 py-1 text-mute">{new Date(f.createdAt).toISOString().slice(5, 16).replace("T", " ")}</td>
                  <td className="px-2">{f.mode}</td>
                  <td className={cn("px-2", f.direction === "up" ? "text-bull" : "text-bear")}>{f.asset} {f.direction}</td>
                  <td className="px-2">{Math.round(f.prob * 100)}%</td>
                  <td className="px-2">{f.horizonMin}m</td>
                  <td className="px-2">{fmt.px(f.priceAt)}</td>
                  <td className="px-2 text-dim">{fmt.px(f.invalidation)}</td>
                  <td className="px-2">{f.outcome === undefined ? <span className="text-mute">pending</span> : f.outcome ? <span className="text-bull">✓ {fmt.px(f.priceAtResolve)}</span> : <span className="text-bear">✗ {fmt.px(f.priceAtResolve)}</span>}</td>
                </tr>
              ))}
              {!fs.length && <tr><td colSpan={8} className="px-2 py-4 text-center text-mute">No forecasts yet.</td></tr>}
            </tbody>
          </table>
        </Card>
        <Card title="Replay challenges">
          <p className="text-[11px] text-dim">Record a session (⏺ Rec in the top bar), save the NDJSON, then load it via <b>Replay…</b>. The engine replays the identical normalized event stream deterministically — log forecasts against it before revealing the outcome. Forecasts are tagged with their mode so replay scores never mix with live ones.</p>
        </Card>
      </div>
    </div>
  );
}
