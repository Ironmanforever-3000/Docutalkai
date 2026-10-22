// supabase/functions/_shared/llm.ts
//
// One provider layer for every edge function (rag-chat, chat, test-provider).
// It REPLACES _shared/groq.ts: delete that file and import from here instead.
//
// What it guarantees:
//  1. Keys are cleaned (whitespace, quotes, newlines) before use.
//  2. A key is only ever sent to the provider it belongs to (gsk_ = Groq,
//     sk-ant- = Anthropic, sk- = OpenAI). A Groq key saved in the browser can
//     never be sent to Anthropic again, which is what produced
//     "Anthropic 401 invalid x-api-key".
//  3. Each provider tries the browser key first, then the server secret.
//  4. If the chosen provider fails (bad key, no credits, rate limit, outage,
//     retired model), the next configured provider answers, and the caller gets
//     a plain-language `notice` to show the user.
//  5. Every failure is typed, so the UI can say exactly what went wrong.
//
// Optional Supabase secrets (all have safe defaults):
//   LLM_FALLBACK_ORDER = "groq,anthropic,openai"
//   GROQ_MODELS        = "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b"
//   ANTHROPIC_MODEL    = "claude-sonnet-5-5"
//   OPENAI_MODEL       = "gpt-4o-mini"

export type Provider = "groq" | "anthropic" | "openai";
export type ChatMsg = { role: "user" | "assistant"; content: string };
export type FailureKind =
  | "config"       // no usable key for this provider
  | "auth"         // 401/403: key rejected
  | "quota"        // out of credits / billing
  | "rate_limit"   // 429 / request too large
  | "overloaded"   // 5xx, 529, timeout
  | "model"        // model id retired or not available to this key
  | "bad_request"  // 400-class problem with the request itself
  | "network"      // could not reach the provider
  | "empty";       // provider answered with no text

export interface Failure {
  provider: Provider;
  kind: FailureKind;
  status?: number;
  message: string;
  source?: "browser" | "server";
}

export class LlmError extends Error {
  provider: Provider;
  kind: FailureKind;
  status?: number;
  constructor(provider: Provider, kind: FailureKind, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }
}

export class LlmUnavailableError extends Error {
  failures: Failure[];
  constructor(message: string, failures: Failure[]) {
    super(message);
    this.name = "LlmUnavailableError";
    this.failures = failures;
  }
}

export interface LlmResult {
  text: string;
  provider: Provider;
  model: string;
  keySource: "browser" | "server";
  /** Plain-language note for the user when a fallback happened; null otherwise. */
  notice: string | null;
  failures: Failure[];
}

/** What the frontend may send. `apiKey` is the legacy single field. */
export interface KeyInput {
  apiKey?: unknown;
  apiKeys?: Partial<Record<Provider, unknown>>;
}

// ── Providers, names, key shapes ─────────────────────────────────────────────

const ALL_PROVIDERS: Provider[] = ["groq", "anthropic", "openai"];
const NAMES: Record<Provider, string> = { groq: "Groq", anthropic: "Anthropic", openai: "OpenAI" };
const PREFIX: Record<Provider, string> = { groq: "gsk_", anthropic: "sk-ant-", openai: "sk-" };
const SERVER_ENV: Record<Provider, string> = {
  groq: "GROQ_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function isProvider(x: unknown): x is Provider {
  return typeof x === "string" && (ALL_PROVIDERS as string[]).includes(x);
}

export function providerName(p: Provider): string {
  return NAMES[p];
}

/** Trim, drop surrounding quotes, and remove any whitespace/newlines inside. */
export function cleanKey(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, "");
}

/** True if `key` has the shape of a key for `p`. Prevents cross-provider sends. */
export function keyMatchesProvider(p: Provider, key: string): boolean {
  if (key.length < 20 || !key.startsWith(PREFIX[p])) return false;
  if (p === "openai" && key.startsWith("sk-ant-")) return false; // Anthropic keys also start with "sk-"
  return true;
}

export function fallbackOrder(): Provider[] {
  const raw = (Deno.env.get("LLM_FALLBACK_ORDER") ?? "").split(",").map((s) => s.trim().toLowerCase());
  const valid = raw.filter(isProvider);
  const seen = new Set<Provider>();
  const out: Provider[] = [];
  for (const p of [...valid, ...ALL_PROVIDERS]) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// ── Key resolution ───────────────────────────────────────────────────────────

export type ServerKeyState = "ok" | "missing" | "malformed";

function serverKey(p: Provider): { key: string; state: ServerKeyState } {
  const key = cleanKey(Deno.env.get(SERVER_ENV[p]));
  if (!key) return { key: "", state: "missing" };
  return keyMatchesProvider(p, key) ? { key, state: "ok" } : { key: "", state: "malformed" };
}

/** Usable keys for a provider, best first: the user's own key, then the server secret. */
export function candidateKeys(p: Provider, input: KeyInput): Array<{ key: string; source: "browser" | "server" }> {
  const out: Array<{ key: string; source: "browser" | "server" }> = [];
  const perProvider = cleanKey(input.apiKeys?.[p]);
  const legacy = cleanKey(input.apiKey);
  for (const k of [perProvider, legacy]) {
    if (k && keyMatchesProvider(p, k) && !out.some((o) => o.key === k)) {
      out.push({ key: k, source: "browser" });
    }
  }
  const s = serverKey(p);
  if (s.state === "ok" && !out.some((o) => o.key === s.key)) out.push({ key: s.key, source: "server" });
  return out;
}

export function providerStatus(): {
  default: Provider;
  order: Provider[];
  providers: Record<Provider, { serverKey: ServerKeyState; model: string }>;
} {
  const order = fallbackOrder();
  const providers = {} as Record<Provider, { serverKey: ServerKeyState; model: string }>;
  for (const p of ALL_PROVIDERS) {
    providers[p] = { serverKey: serverKey(p).state, model: defaultModel(p) };
  }
  const firstOk = order.find((p) => providers[p].serverKey === "ok");
  return { default: firstOk ?? order[0], order, providers };
}

// ── Models ───────────────────────────────────────────────────────────────────

// Production models first. qwen/qwen3.8-27b is a Groq *preview* model, which can
// be withdrawn without notice, so it stays last.
const DEFAULT_GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];

export function groqModels(): string[] {
  const list = (Deno.env.get("GROQ_MODELS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_GROQ_MODELS;
}

function anthropicModel(): string {
  return Deno.env.get("ANTHROPIC_MODEL")?.trim() || "claude-sonnet-5-5";
}

function openaiModel(): string {
  return Deno.env.get("OPENAI_MODEL")?.trim() || "gpt-4o-mini";
}

function defaultModel(p: Provider): string {
  return p === "groq" ? groqModels()[0] : p === "anthropic" ? anthropicModel() : openaiModel();
}

// These are reasoning models. For RAG we want short, clean answers:
//  - gpt-oss: low effort, and don't return the reasoning text
//  - qwen:    hide the reasoning so no <think> block reaches the chat window
function groqReasoningParams(model: string): Record<string, unknown> {
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low", include_reasoning: false };
  if (model.startsWith("qwen/")) return { reasoning_format: "hidden" };
  return {};
}

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// ── HTTP + error mapping ─────────────────────────────────────────────────────

const TIMEOUT_MS = 45_000;

function short(s: string, n = 180): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}...` : one;
}

function kindFromStatus(status: number, body: string): FailureKind {
  const b = body.toLowerCase();
  if (b.includes("insufficient_quota") || b.includes("credit balance") || b.includes("billing") || status === 402) {
    return "quota";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 404 || b.includes("model_not_found") || b.includes("does not exist")) return "model";
  if (status === 429 || status === 413) return "rate_limit";
  if (status === 408 || status >= 500) return "overloaded"; // includes Anthropic 529
  return "bad_request";
}

async function post(
  provider: Provider,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new LlmError(
      provider,
      timedOut ? "overloaded" : "network",
      timedOut ? "request timed out" : `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try {
      const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
      detail = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? raw;
    } catch { /* not JSON */ }
    throw new LlmError(provider, kindFromStatus(res.status, raw), `${res.status}: ${short(detail)}`, res.status);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new LlmError(provider, "bad_request", "provider returned a non-JSON response", res.status);
  }
}

// ── The three providers ──────────────────────────────────────────────────────

type CallOpts = { key: string; system: string; messages: ChatMsg[]; maxTokens: number };
type CallResult = { text: string; model: string };

async function callGroq(o: CallOpts): Promise<CallResult> {
  const errors: LlmError[] = [];
  for (const model of groqModels()) {
    try {
      const json = await post("groq", "https://api.groq.com/openai/v1/chat/completions", {
        Authorization: `Bearer ${o.key}`,
      }, {
        model,
        messages: [{ role: "system", content: o.system }, ...o.messages],
        max_tokens: o.maxTokens,
        temperature: 0.3,
        ...groqReasoningParams(model),
      });
      const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
      const text = stripThinking(choices?.[0]?.message?.content ?? "");
      if (text) return { text, model };
      errors.push(new LlmError("groq", "empty", `${model}: empty response`));
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      // A bad key fails on every model: stop here instead of burning through the list.
      if (e.kind === "auth" || e.kind === "quota") throw e;
      errors.push(new LlmError("groq", e.kind, `${model}: ${e.message}`, e.status));
    }
  }
  throw new LlmError("groq", errors[0]?.kind ?? "bad_request", `all Groq models failed: ${errors.map((e) => e.message).join(" | ")}`, errors[0]?.status);
}

async function callAnthropic(o: CallOpts): Promise<CallResult> {
  const model = anthropicModel();
  const json = await post("anthropic", "https://api.anthropic.com/v1/messages", {
    "x-api-key": o.key,
    "anthropic-version": "2023-06-01",
  }, { model, max_tokens: o.maxTokens, system: o.system, messages: o.messages });
  const content = json.content as Array<{ type?: string; text?: string }> | undefined;
  const text = (content ?? []).filter((c) => c.type === "text" || c.text).map((c) => c.text ?? "").join("").trim();
  if (!text) throw new LlmError("anthropic", "empty", "empty response");
  return { text, model };
}

async function callOpenAI(o: CallOpts): Promise<CallResult> {
  const model = openaiModel();
  const body: Record<string, unknown> = {
    model,
    max_completion_tokens: o.maxTokens,
    messages: [{ role: "system", content: o.system }, ...o.messages],
  };
  if (model.startsWith("gpt-4")) body.temperature = 0.3; // reasoning models reject custom temperature
  const json = await post("openai", "https://api.openai.com/v1/chat/completions", { Authorization: `Bearer ${o.key}` }, body);
  const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
  const text = (choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new LlmError("openai", "empty", "empty response");
  return { text, model };
}

/** Call ONE provider with ONE key, no fallback. Used by Test Connection. */
export function callProvider(p: Provider, o: CallOpts): Promise<CallResult> {
  return p === "groq" ? callGroq(o) : p === "anthropic" ? callAnthropic(o) : callOpenAI(o);
}

// ── Fallback orchestration ───────────────────────────────────────────────────

function reasonFor(f: Failure): string {
  switch (f.kind) {
    case "config": return "has no API key configured";
    case "auth": return `rejected the API key (${f.status ?? 401})`;
    case "quota": return "has no credits left";
    case "rate_limit": return "hit a rate limit";
    case "overloaded": return "is temporarily unavailable";
    case "model": return "doesn't have the requested model available";
    case "network": return "couldn't be reached";
    case "empty": return "returned an empty answer";
    default: return `rejected the request (${short(f.message, 90)})`;
  }
}

function hintFor(f: Failure): string {
  if (f.kind === "auth" || f.kind === "config" || f.kind === "quota") {
    return ` Check the ${NAMES[f.provider]} key in AI Settings.`;
  }
  return "";
}

/**
 * Answer with the requested provider, falling back to the others in order.
 * Throws LlmUnavailableError only when every configured provider failed.
 */
export async function chatWithFallback(opts: {
  requested?: unknown;
  system: string;
  messages: ChatMsg[];
  keys: KeyInput;
  maxTokens?: number;
}): Promise<LlmResult> {
  const { system, messages, keys, maxTokens = 2048 } = opts;
  const order = fallbackOrder();
  const requested: Provider = isProvider(opts.requested) ? opts.requested : order[0];
  const sequence: Provider[] = [requested, ...order.filter((p) => p !== requested)];

  const failures: Failure[] = [];

  for (const provider of sequence) {
    const candidates = candidateKeys(provider, keys);
    if (candidates.length === 0) {
      // Only worth reporting for the provider the user actually chose.
      if (provider === requested) {
        failures.push({ provider, kind: "config", message: "no usable API key (browser or server)" });
      }
      continue;
    }
    for (const { key, source } of candidates) {
      try {
        const r = await callProvider(provider, { key, system, messages, maxTokens });
        const first = failures.find((f) => f.provider === requested);
        const notice = provider === requested || !first
          ? null
          : `${NAMES[requested]} ${reasonFor(first)}, so this answer came from ${NAMES[provider]} (${r.model}).${hintFor(first)}`;
        if (failures.length) {
          console.warn(`[llm] fallback to ${provider}: ${failures.map((f) => `${f.provider}/${f.kind}`).join(", ")}`);
        }
        return { text: r.text, provider, model: r.model, keySource: source, notice, failures };
      } catch (e) {
        const f: Failure = e instanceof LlmError
          ? { provider, kind: e.kind, status: e.status, message: e.message, source }
          : { provider, kind: "bad_request", message: e instanceof Error ? e.message : String(e), source };
        failures.push(f);
        console.warn(`[llm] ${provider} (${source} key) failed: ${f.kind} ${short(f.message, 120)}`);
      }
    }
  }

  const summary = failures.length
    ? failures.map((f) => `${NAMES[f.provider]} ${reasonFor(f)}`).join("; ")
    : "no AI provider is configured";
  throw new LlmUnavailableError(
    `No AI provider could answer. ${summary}. Add or fix a key in AI Settings, or set a server secret (GROQ_API_KEY).`,
    failures,
  );
}

// ── Streaming with Multi-Provider Fallback ────────────────────────────────────

export interface StreamChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  provider?: unknown;
  model?: string;
  messages: StreamChatMessage[];
  keys?: KeyInput;
  apiKey?: string;
  temperature?: number;
}

export interface StreamHandshakeResult {
  provider: Provider;
  model: string;
  fallbackNotice?: string;
  tokenStream: AsyncGenerator<string, void, unknown>;
}

async function openProviderStream(
  provider: Provider,
  apiKey: string,
  model: string,
  messages: StreamChatMessage[],
  temperature = 0.2
): Promise<Response> {
  if (provider === "anthropic") {
    const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
    const chatMsgs = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    return await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model || anthropicModel(),
        max_tokens: 2048,
        temperature,
        system: systemMsg,
        messages: chatMsgs,
        stream: true,
      }),
    });
  }

  const url =
    provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";

  const resolvedModel =
    model || (provider === "groq" ? groqModels()[0] : openaiModel());

  const extraBody =
    provider === "groq" && resolvedModel.startsWith("openai/gpt-oss")
      ? { reasoning_effort: "low", include_reasoning: false }
      : provider === "groq" && resolvedModel.startsWith("qwen/")
      ? { reasoning_format: "hidden" }
      : {};

  return await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
      messages,
      temperature,
      stream: true,
      ...extraBody,
    }),
  });
}

async function* parseUpstreamSSE(
  response: Response,
  provider: Provider
): AsyncGenerator<string, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const evt of events) {
        const lines = evt.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const rawData = line.slice(5).trim();
          if (!rawData || rawData === "[DONE]") continue;

          try {
            const parsed = JSON.parse(rawData);

            if (provider === "anthropic") {
              if (
                parsed.type === "content_block_delta" &&
                parsed.delta?.type === "text_delta" &&
                typeof parsed.delta.text === "string"
              ) {
                yield parsed.delta.text;
              }
            } else {
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                yield delta;
              }
            }
          } catch {
            // Ignore malformed keep-alive comments or partial frames
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function streamChatWithFallback(
  opts: StreamOptions
): Promise<StreamHandshakeResult> {
  const keys: KeyInput = opts.keys ?? { apiKey: opts.apiKey };
  const order = fallbackOrder();
  const requested: Provider = isProvider(opts.provider) ? opts.provider : order[0];
  const sequence: Provider[] = [requested, ...order.filter((p) => p !== requested)];

  let lastError = "No usable API key found.";

  for (let i = 0; i < sequence.length; i++) {
    const prov = sequence[i];
    const candidates = candidateKeys(prov, keys);
    if (!candidates.length) {
      lastError = `No valid key configured for ${prov}.`;
      continue;
    }

    const model =
      prov === requested && opts.model
        ? opts.model
        : prov === "groq"
        ? groqModels()[0]
        : prov === "anthropic"
        ? anthropicModel()
        : openaiModel();

    for (const { key } of candidates) {
      try {
        const res = await openProviderStream(
          prov,
          key,
          model,
          opts.messages,
          opts.temperature ?? 0.2
        );

        if (res.ok && res.body) {
          const fallbackNotice =
            i > 0
              ? `Switched from ${requested} to ${prov} (${model}) due to upstream error: ${lastError}`
              : undefined;

          return {
            provider: prov,
            model,
            fallbackNotice,
            tokenStream: parseUpstreamSSE(res, prov),
          };
        }

        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        lastError = `${prov} (${res.status}): ${errText.slice(0, 160)}`;
      } catch (err: unknown) {
        lastError = `${prov}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  throw new Error(`All providers failed to stream: ${lastError}`);
}

