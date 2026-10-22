// tests/llm.test.mjs
// Offline tests for supabase/functions/_shared/llm.ts (fetch is mocked, no network, no keys).
// Run with Node 22.6 or newer:
//   node --experimental-strip-types --no-warnings --test tests/llm.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

const env = {};
globalThis.Deno = { env: { get: (k) => env[k] } };
let calls = [];
let handler = () => { throw new Error("no handler"); };
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const headers = init.headers;
  calls.push({ url: String(url), body, headers });
  const r = handler(String(url), body, headers);
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
};
const reset = () => { for (const k of Object.keys(env)) delete env[k]; calls = []; };

const L = await import("../supabase/functions/_shared/llm.ts");
const GROQ_KEY = "gsk_" + "a".repeat(40);
const ANT_KEY = "sk-ant-" + "b".repeat(40);
const OAI_KEY = "sk-" + "c".repeat(40);
const ok = (text) => ({ json: { choices: [{ message: { content: text } }], content: [{ type: "text", text }] } });
const msgs = [{ role: "user", content: "hi" }];
const base = { system: "sys", messages: msgs };

test("cleanKey strips quotes, spaces, newlines", () => {
  assert.equal(L.cleanKey('  "gsk_abc\n def" \r\n'), "gsk_abcdef");
  assert.equal(L.cleanKey(undefined), "");
  assert.equal(L.cleanKey(42), "");
});

test("keyMatchesProvider never confuses Anthropic and OpenAI keys", () => {
  assert.ok(L.keyMatchesProvider("anthropic", ANT_KEY));
  assert.ok(!L.keyMatchesProvider("openai", ANT_KEY));
  assert.ok(L.keyMatchesProvider("openai", OAI_KEY));
  assert.ok(!L.keyMatchesProvider("anthropic", GROQ_KEY));
  assert.ok(!L.keyMatchesProvider("groq", "gsk_short"));
});

test("THE BUG: Groq key saved in browser, Anthropic selected -> never sent to Anthropic, Groq answers", async () => {
  reset();
  handler = (url) => { assert.ok(url.includes("groq.com"), "must not call " + url); return ok("hello from groq"); };
  const r = await L.chatWithFallback({ requested: "anthropic", ...base, keys: { apiKey: GROQ_KEY } });
  assert.equal(r.provider, "groq");
  assert.equal(r.keySource, "browser");
  assert.match(r.notice, /Anthropic has no API key configured, so this answer came from Groq/);
  assert.match(r.notice, /Check the Anthropic key in AI Settings/);
  assert.ok(calls.every((c) => c.url.includes("groq.com")));
});

test("Anthropic 401 -> falls back to Groq with a clear notice", async () => {
  reset(); env.ANTHROPIC_API_KEY = ANT_KEY; env.GROQ_API_KEY = GROQ_KEY;
  handler = (url) => url.includes("anthropic.com")
    ? { status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }
    : ok("groq answer");
  const r = await L.chatWithFallback({ requested: "anthropic", ...base, keys: {} });
  assert.equal(r.provider, "groq");
  assert.match(r.notice, /Anthropic rejected the API key \(401\), so this answer came from Groq/);
  assert.equal(r.failures[0].kind, "auth");
  assert.equal(calls[0].headers["x-api-key"], ANT_KEY);
  assert.equal(calls[0].body.system, "sys");               // system is top-level for Anthropic
  assert.ok(calls[0].body.messages.every((m) => m.role !== "system"));
});

test("revoked browser key -> same provider's server key is tried next", async () => {
  reset(); env.GROQ_API_KEY = "gsk_" + "z".repeat(40);
  handler = (url, body, h) => h.Authorization === `Bearer ${GROQ_KEY}`
    ? { status: 401, json: { error: { message: "Invalid API Key" } } } : ok("server key worked");
  const r = await L.chatWithFallback({ requested: "groq", ...base, keys: { apiKey: GROQ_KEY } });
  assert.equal(r.keySource, "server");
  assert.equal(r.provider, "groq");
  assert.equal(r.notice, null);                              // same provider answered: no fallback notice
});

test("retired Groq model -> next model; reasoning params are model-specific", async () => {
  reset(); env.GROQ_API_KEY = GROQ_KEY;
  handler = (url, body) => body.model === "openai/gpt-oss-120b"
    ? { status: 404, json: { error: { message: "The model `x` does not exist", code: "model_not_found" } } } : ok("ok");
  const r = await L.chatWithFallback({ requested: "groq", ...base, keys: {} });
  assert.equal(r.model, "openai/gpt-oss-20b");
  assert.equal(calls[0].body.reasoning_effort, "low");
  assert.equal(calls[0].body.include_reasoning, false);
});

test("Qwen gets reasoning_format hidden; <think> text is stripped", async () => {
  reset(); env.GROQ_API_KEY = GROQ_KEY; env.GROQ_MODELS = "qwen/qwen3.8-27b";
  handler = (url, body) => { assert.equal(body.reasoning_format, "hidden"); return ok("<think>secret</think>Answer"); };
  const r = await L.chatWithFallback({ requested: "groq", ...base, keys: {} });
  assert.equal(r.text, "Answer");
});

test("Groq auth failure stops immediately (does not loop all models)", async () => {
  reset(); env.GROQ_API_KEY = GROQ_KEY;
  handler = () => ({ status: 401, json: { error: { message: "bad" } } });
  await assert.rejects(L.chatWithFallback({ requested: "groq", ...base, keys: {} }), L.LlmUnavailableError);
  assert.equal(calls.length, 1);
});

test("OpenAI insufficient_quota -> kind quota, falls back to Groq", async () => {
  reset(); env.OPENAI_API_KEY = OAI_KEY; env.GROQ_API_KEY = GROQ_KEY;
  handler = (url) => url.includes("openai.com")
    ? { status: 429, json: { error: { message: "You exceeded your current quota", code: "insufficient_quota" } } } : ok("g");
  const r = await L.chatWithFallback({ requested: "openai", ...base, keys: {} });
  assert.equal(r.failures[0].kind, "quota");
  assert.match(r.notice, /OpenAI has no credits left/);
  assert.equal(calls[0].body.max_completion_tokens, 2048);
});

test("Anthropic 'credit balance too low' (HTTP 400) is classified as quota", async () => {
  reset(); env.ANTHROPIC_API_KEY = ANT_KEY; env.GROQ_API_KEY = GROQ_KEY;
  handler = (url) => url.includes("anthropic.com")
    ? { status: 400, json: { error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } } } : ok("g");
  const r = await L.chatWithFallback({ requested: "anthropic", ...base, keys: {} });
  assert.equal(r.failures[0].kind, "quota");
});

test("everything fails -> LlmUnavailableError lists each provider", async () => {
  reset(); env.ANTHROPIC_API_KEY = ANT_KEY; env.GROQ_API_KEY = GROQ_KEY;
  handler = () => ({ status: 529, json: { error: { message: "Overloaded" } } });
  await assert.rejects(L.chatWithFallback({ requested: "anthropic", ...base, keys: {} }), (e) => {
    assert.ok(e instanceof L.LlmUnavailableError);
    assert.match(e.message, /Anthropic is temporarily unavailable/);
    assert.match(e.message, /Groq is temporarily unavailable/);
    assert.equal(e.failures.length >= 2, true);
    return true;
  });
});

test("no keys anywhere -> clear message, no network calls", async () => {
  reset(); handler = () => { throw new Error("must not call"); };
  await assert.rejects(L.chatWithFallback({ requested: "groq", ...base, keys: {} }), /has no API key configured/);
  assert.equal(calls.length, 0);
});

test("malformed server secret (placeholder) is treated as missing, reported in status", () => {
  reset(); env.GROQ_API_KEY = "your_key_here"; env.ANTHROPIC_API_KEY = ANT_KEY + "\n";
  const s = L.providerStatus();
  assert.equal(s.providers.groq.serverKey, "malformed");
  assert.equal(s.providers.anthropic.serverKey, "ok");   // trailing newline cleaned
  assert.equal(s.providers.openai.serverKey, "missing");
  assert.equal(s.default, "anthropic");                   // first provider that is actually usable
  assert.ok(!JSON.stringify(s).includes(ANT_KEY));        // never leaks key material
});

test("fallback order is configurable and unknown values are ignored", () => {
  reset(); env.LLM_FALLBACK_ORDER = "openai, nonsense ,groq";
  assert.deepEqual(L.fallbackOrder(), ["openai", "groq", "anthropic"]);
});

test("unknown/legacy requested provider value falls back to default order", async () => {
  reset(); env.GROQ_API_KEY = GROQ_KEY; handler = () => ok("x");
  const r = await L.chatWithFallback({ requested: "gemini", ...base, keys: {} });
  assert.equal(r.provider, "groq"); assert.equal(r.notice, null);
});

test("per-provider apiKeys map is honoured and legacy key still works", async () => {
  reset(); handler = (url, b, h) => { assert.equal(h["x-api-key"], ANT_KEY); return ok("a"); };
  const r = await L.chatWithFallback({ requested: "anthropic", ...base, keys: { apiKeys: { anthropic: ` ${ANT_KEY}\n` } } });
  assert.equal(r.provider, "anthropic"); assert.equal(r.keySource, "browser");
});
