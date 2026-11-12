"use client";

import { useState } from "react";
import { useAtlas } from "@/lib/state/store";
import { answer, groundingContext, QUESTIONS, type AnalystAnswer, type QuestionId } from "@/lib/analyst/analyst";
import { Badge, Card, cn, fmt } from "../ui";
import { Loading } from "./CommandView";

export function AnalystView() {
  const snap = useAtlas((s) => s.snap);
  const [q, setQ] = useState<QuestionId>("forced");
  const [free, setFree] = useState("");
  const [llm, setLlm] = useState<{ q: string; text?: string; error?: string; loading?: boolean; asOf: number } | null>(null);
  if (!snap) return <Loading />;
  const a = answer(q, snap);

  const ask = async () => {
    if (!free.trim()) return;
    const asOf = snap.ts;
    setLlm({ q: free, loading: true, asOf });
    try {
      const r = await fetch("/api/analyst", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: free, context: groundingContext(snap) }) });
      const j = await r.json();
      setLlm({ q: free, asOf, ...(r.ok ? { text: j.text } : { error: j.error }) });
    } catch (e) {
      setLlm({ q: free, asOf, error: (e as Error).message });
    }
  };

  return (
    <div className="grid gap-3 xl:grid-cols-[300px_1fr]">
      <Card title="Ask ATLAS" subtitle="Answers computed from live observations only">
        <div className="flex flex-col gap-1">
          {QUESTIONS.map((x) => (
            <button key={x.id} type="button" onClick={() => setQ(x.id)} className={cn("rounded-md px-2.5 py-2 text-left text-[12px] cursor-pointer border", q === x.id ? "bg-elev border-info/50 text-fg" : "border-transparent text-dim hover:bg-elev/50")}>{x.q}</button>
          ))}
        </div>
      </Card>
      <div className="space-y-3">
        <AnswerCard a={a} />
        <Card title="Free-form question (LLM, grounded)" subtitle="Sends the computed snapshot (not raw feeds) to Claude via /api/analyst; requires ANTHROPIC_API_KEY on the server">
          <div className="flex gap-2">
            <input value={free} onChange={(e) => setFree(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} placeholder="e.g. Is the bounce off the lows supported by spot demand?" className="flex-1 min-w-0 rounded-md border border-line bg-bg px-2.5 py-1.5 text-[12px] outline-none focus:border-info/60" />
            <button type="button" onClick={ask} className="rounded-md bg-elev px-3 text-[12px] border border-line hover:border-info/60 cursor-pointer">Ask</button>
          </div>
          {llm && (
            <div className="mt-3 text-[12px]">
              <div className="text-[10px] text-mute mb-1">Q: {llm.q} · grounded on snapshot {fmt.time(llm.asOf)}</div>
              {llm.loading ? <p className="text-dim">Thinking…</p> : llm.error ? <p className="text-warn">{llm.error}</p> : <div className="whitespace-pre-wrap leading-relaxed text-dim [&_strong]:text-fg" dangerouslySetInnerHTML={{ __html: md(llm.text ?? "") }} />}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function AnswerCard({ a }: { a: AnalystAnswer }) {
  const S = ({ t, children, tone }: { t: string; children: React.ReactNode; tone?: string }) => (
    <div>
      <h4 className={cn("text-[10px] font-semibold uppercase tracking-wider mb-1", tone ?? "text-dim")}>{t}</h4>
      <div className="text-[12px] leading-relaxed text-fg/90">{children}</div>
    </div>
  );
  return (
    <Card title={a.question} subtitle={`as of ${fmt.time(a.asOf)} · deterministic analyst`} right={<Badge tone={a.confidence.level === "high" ? "bull" : a.confidence.level === "medium" ? "warn" : "bear"}>confidence: {a.confidence.level}</Badge>}>
      <div className="grid gap-4 md:grid-cols-2">
        <S t="Observation" tone="text-info"><ul className="list-disc pl-4 space-y-1 tnum">{a.observation.map((o, i) => <li key={i}>{o}</li>)}</ul></S>
        <S t="Interpretation">{a.interpretation}</S>
        <S t="Strongest counterargument" tone="text-bear">{a.counterargument}</S>
        <S t="Implications">{a.implications}</S>
        <S t="Invalidation" tone="text-warn">{a.invalidation}</S>
        <S t="Data confidence">{a.confidence.why}<div className="mt-1 text-[10px] text-mute">Sources: {a.sources.join(", ")}</div></S>
      </div>
    </Card>
  );
}

function md(s: string) {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
