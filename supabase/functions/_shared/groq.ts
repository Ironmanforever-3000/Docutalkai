// supabase/functions/_shared/groq.ts
//
// One place for Groq model choice, reasoning settings and fallback, so
// rag-chat, chat and test-provider can never drift apart again.
//
// Change models WITHOUT touching code:
//   supabase secrets set GROQ_MODELS="openai/gpt-oss-120b,openai/gpt-oss-20b"

export type ChatMsg = { role: "user" | "assistant"; content: string };

// Production models first. qwen/qwen3.8-27b is a Groq *preview* model, which
// can be withdrawn without notice, so it stays last as a safety net.
const DEFAULT_GROQ_MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
];

export function groqModels(): string[] {
  const fromEnv = Deno.env.get("GROQ_MODELS");
  const list = (fromEnv ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_GROQ_MODELS;
}

// All of these are reasoning models. For RAG we want short, fast, clean answers:
//  - gpt-oss: low reasoning effort, and don't return the reasoning text
//  - qwen:    hide the reasoning so no <think> block reaches the chat window
function reasoningParams(model: string): Record<string, unknown> {
  if (model.startsWith("openai/gpt-oss")) {
    return { reasoning_effort: "low", include_reasoning: false };
  }
  if (model.startsWith("qwen/")) {
    return { reasoning_format: "hidden" };
  }
  return {};
}

// Belt and braces: strip any <think>...</think> that slips through.
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function shorten(s: string, n = 160): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export async function callGroq(opts: {
  apiKey: string;
  system: string;
  messages: ChatMsg[];
  maxTokens?: number; // keep >= 256 for connection tests: reasoning models spend tokens thinking
}): Promise<{ text: string; model: string }> {
  const { apiKey, system, messages, maxTokens = 2048 } = opts;
  if (!apiKey) throw new Error("No API key for Groq");

  const errors: string[] = [];

  for (const model of groqModels()) {
    let res: Response;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, ...messages],
          max_tokens: maxTokens,
          temperature: 0.3,
          ...reasoningParams(model),
        }),
      });
    } catch (err) {
      errors.push(`${model}: network error (${err instanceof Error ? err.message : err})`);
      continue;
    }

    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = stripThinking(json.choices?.[0]?.message?.content ?? "");
      if (text) return { text, model };
      errors.push(`${model}: empty response`);
      continue;
    }

    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const detail = body?.error?.message ?? `HTTP ${res.status}`;

    // A bad key will fail on every model; don't burn through the list.
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Groq rejected the API key (${res.status}): ${shorten(detail)}`);
    }

    // Otherwise (model retired, rate limit, 5xx, unsupported parameter) try the next model.
    errors.push(`${model}: ${res.status} ${shorten(detail)}`);
  }

  throw new Error(`All Groq models failed. ${errors.join(" | ")}`);
}
