import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

const SYSTEM = `You are the ATLAS market analyst. You answer questions about the crypto market using ONLY the JSON observations provided (computed by the ATLAS engine, with timestamps and provenance tags: observed / modeled / inferred).
Rules:
- Never invent order books, whales, wallets, institutions, signals, prices or probabilities. If the data needed is absent, say it is unavailable.
- Never claim an anonymous trade is institutional. Modeled liquidation levels are estimates, not observations.
- Evaluate long and short hypotheses symmetrically.
- If mode is "simulation" or "replay", say so in the first line.
Respond in exactly these sections, each 1–4 sentences, citing the specific values you used:
**Observation** · **Interpretation** · **Strongest counterargument** · **Implications** · **Invalidation** · **Data confidence**`;

/** Optional LLM analyst. Requires ANTHROPIC_API_KEY on the server; otherwise the UI uses the deterministic analyst. */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return Response.json({ error: "LLM analyst not configured (set ANTHROPIC_API_KEY on the server). The deterministic analyst remains available." }, { status: 501 });
  }
  const { question, context } = (await req.json()) as { question?: string; context?: unknown };
  if (!question || typeof question !== "string" || question.length > 2000 || !context) {
    return Response.json({ error: "question and context are required" }, { status: 400 });
  }
  const client = new Anthropic();
  try {
    const params = {
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `Observations (JSON):\n${JSON.stringify(context)}\n\nQuestion: ${question}` }],
    };
    const msg = await client.beta.messages.create(params as unknown as Parameters<typeof client.beta.messages.create>[0]) as Anthropic.Beta.BetaMessage;
    if (msg.stop_reason === "refusal") return Response.json({ error: "The model declined this request." }, { status: 422 });
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n");
    return Response.json({ text, model: msg.model });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "Rate limited — retry shortly." }, { status: 429 });
    if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: "Invalid API credentials on server." }, { status: 401 });
    if (e instanceof Anthropic.APIError) return Response.json({ error: `API error ${e.status}: ${e.message}` }, { status: 502 });
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
