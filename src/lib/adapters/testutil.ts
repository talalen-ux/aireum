/** Test doubles for adapter tests (node, no network). */
import type { AnyEvent } from "../core/types";
import type { FetchLike, FetchResponseLike, WSLike } from "./base";

export class FakeWS implements WSLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
  }
  static reset() {
    FakeWS.instances = [];
  }
  static find(pred: (w: FakeWS) => boolean) {
    const w = FakeWS.instances.filter(pred);
    return w[w.length - 1];
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(d: string) {
    this.sent.push(d === "ping" ? d : JSON.parse(d));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  recv(m: unknown) {
    this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) });
  }
}

export function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

/** Fetch whose responses are controlled per call. */
export function routedFetch(route: (url: string) => FetchResponseLike | Promise<FetchResponseLike>) {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    return route(url);
  };
  return { fn, calls };
}

export function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export function collector() {
  const events: AnyEvent[] = [];
  return {
    events,
    emit: (e: AnyEvent) => events.push(e),
    of<K extends AnyEvent["kind"]>(k: K) {
      return events.filter((e): e is Extract<AnyEvent, { kind: K }> => e.kind === k);
    },
    statuses() {
      return events.filter((e): e is Extract<AnyEvent, { kind: "feed_status" }> => e.kind === "feed_status");
    },
    clear() {
      events.length = 0;
    },
  };
}

export const flush = () => new Promise((r) => setTimeout(r, 0));
