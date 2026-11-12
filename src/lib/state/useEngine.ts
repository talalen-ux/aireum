"use client";

import { useCallback, useEffect, useRef } from "react";
import type { AnyEvent } from "../core/types";
import type { WorkerIn, WorkerOut } from "../engine/worker";
import { useAtlas } from "./store";

/** Owns the engine Web Worker: starts feeds for the selected asset/mode, streams snapshots into the store. */
export function useEngine() {
  const asset = useAtlas((s) => s.asset);
  const mode = useAtlas((s) => s.mode);
  const worker = useRef<Worker | null>(null);
  const exportCb = useRef<((nd: string, n: number) => void) | null>(null);

  useEffect(() => {
    const w = new Worker(new URL("../engine/worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      if (m.type === "snapshot") useAtlas.getState().ingest(m.snap);
      else if (m.type === "error") { console.error("[atlas worker]", m.message); useAtlas.getState().setError(m.message.split("\n")[0]); }
      else if (m.type === "export") exportCb.current?.(m.ndjson, m.count);
    };
    return () => { w.postMessage({ type: "stop" } satisfies WorkerIn); w.terminate(); worker.current = null; };
  }, []);

  useEffect(() => {
    const w = worker.current;
    if (!w || mode === "replay") return;
    useAtlas.getState().reset();
    w.postMessage({ type: "start", asset, mode } satisfies WorkerIn);
  }, [asset, mode]);

  const replay = useCallback((events: AnyEvent[], speed: number) => {
    useAtlas.getState().reset();
    useAtlas.getState().setMode("replay");
    worker.current?.postMessage({ type: "replay", asset: useAtlas.getState().asset, events, speed } satisfies WorkerIn);
  }, []);
  const record = useCallback((on: boolean) => worker.current?.postMessage({ type: "record", on } satisfies WorkerIn), []);
  const exportRecording = useCallback((cb: (nd: string, n: number) => void) => {
    exportCb.current = cb;
    worker.current?.postMessage({ type: "export" } satisfies WorkerIn);
  }, []);
  return { replay, record, exportRecording };
}
