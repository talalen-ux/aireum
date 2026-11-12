/// <reference lib="webworker" />
import type { AnyEvent, Asset, DataMode, Venue, VenueAdapter } from "../core/types";
import { TIMEFRAMES } from "../core/types";
import { createAdapters } from "../adapters";
import { Simulator } from "../sim/simulator";
import { Engine } from "./engine";
import { loadHistory } from "./history";

export type WorkerIn =
  | { type: "start"; asset: Asset; mode: Exclude<DataMode, "replay">; venues?: Venue[] }
  | { type: "replay"; asset: Asset; events: AnyEvent[]; speed: number }
  | { type: "record"; on: boolean }
  | { type: "export" }
  | { type: "stop" };

export type WorkerOut =
  | { type: "snapshot"; snap: ReturnType<Engine["snapshot"]> }
  | { type: "export"; ndjson: string; count: number }
  | { type: "error"; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let engine: Engine | null = null;
let adapters: VenueAdapter[] = [];
let loop: ReturnType<typeof setInterval> | null = null;
let replayTimer: ReturnType<typeof setTimeout> | null = null;
let gen = 0;

function post(m: WorkerOut) {
  ctx.postMessage(m);
}

function stopAll() {
  gen++;
  for (const a of adapters) a.stop();
  adapters = [];
  if (loop) clearInterval(loop);
  loop = null;
  if (replayTimer) clearTimeout(replayTimer);
  replayTimer = null;
  engine = null;
}

function runLoop(e: Engine) {
  let n = 0;
  loop = setInterval(() => {
    try {
      e.tick();
      n++;
      if (n % 2 === 0) post({ type: "snapshot", snap: e.snapshot({ includeChart: n % 8 === 0 || n <= 8 }) });
    } catch (err) {
      post({ type: "error", message: (err as Error).stack ?? String(err) });
    }
  }, 250);
}

ctx.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  if (m.type === "stop") return stopAll();
  if (m.type === "record") { if (engine) { engine.recording = m.on; if (m.on) engine.recorded = []; } return; }
  if (m.type === "export") {
    if (!engine) return;
    const ndjson = engine.recorded.map((x) => JSON.stringify(x)).join("\n");
    post({ type: "export", ndjson, count: engine.recorded.length });
    return;
  }
  if (m.type === "start") {
    stopAll();
    const my = gen;
    const e = new Engine(m.asset, m.mode);
    engine = e;
    runLoop(e);
    if (m.mode === "simulation") {
      const sim = new Simulator(m.asset);
      e.loadHistory(sim.history(), { source: "SIMULATION (synthetic history)", flowAvailable: true, errors: [] });
      adapters = [sim];
      sim.start((x) => e.ingest(x));
    } else {
      adapters = createAdapters(m.asset, m.venues);
      for (const a of adapters) a.start((x) => engine === e && e.ingest(x));
      loadHistory(m.asset, TIMEFRAMES).then((h) => {
        if (gen !== my) return;
        e.loadHistory(h.bars, { source: h.source, flowAvailable: h.flowAvailable, errors: h.errors });
      }).catch((err) => post({ type: "error", message: `history: ${(err as Error).message}` }));
    }
    return;
  }
  if (m.type === "replay") {
    stopAll();
    const my = gen;
    const events = [...m.events].sort((a, b) => ts(a) - ts(b));
    if (!events.length) return post({ type: "error", message: "Replay file contains no events" });
    const e = new Engine(m.asset, "replay", ts(events[0]));
    engine = e;
    e.history = { source: "REPLAY (recorded session)", flowAvailable: true, errors: [], loaded: true };
    runLoop(e);
    let i = 0;
    const t0 = ts(events[0]);
    const wall0 = Date.now();
    const speed = Math.max(0.25, m.speed);
    const pump = () => {
      if (gen !== my) return;
      const target = t0 + (Date.now() - wall0) * speed;
      while (i < events.length && ts(events[i]) <= target) e.ingest(events[i++]);
      if (i < events.length) replayTimer = setTimeout(pump, 50);
    };
    pump();
  }
};

function ts(e: AnyEvent) {
  return e.kind === "feed_status" ? e.ts : e.recvTs;
}
