import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  candidateKeys,
  callProvider,
  providerStatus,
  providerName,
  isProvider,
  LlmError,
  type Provider,
} from "../_shared/llm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const PREFIX: Record<Provider, string> = {
  groq: "gsk_",
  anthropic: "sk-ant-",
  openai: "sk-",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const { action, provider, apiKey, apiKeys } = body;

    if (action === "status") {
      return jsonResponse(providerStatus(), 200);
    }

    if (!provider || !isProvider(provider)) {
      return jsonResponse({ success: false, error: "Valid provider is required" }, 200);
    }

    const candidates = candidateKeys(provider, { apiKey, apiKeys });
    if (candidates.length === 0) {
      const name = providerName(provider);
      const prefix = PREFIX[provider];
      return jsonResponse(
        {
          success: false,
          error: `No usable ${name} key. Keys for this provider start with ${prefix}. Paste one in AI Settings or set the server secret.`,
          kind: "config",
        },
        200
      );
    }

    let lastError: LlmError | Error | null = null;
    for (const { key, source } of candidates) {
      try {
        const { model } = await callProvider(provider, {
          key,
          system: "Reply with OK.",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 256,
        });
        return jsonResponse({ success: true, model, keySource: source }, 200);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    const name = providerName(provider);
    const kind = lastError instanceof LlmError ? lastError.kind : "bad_request";
    const detail = lastError instanceof LlmError ? lastError.message : (lastError?.message ?? "test failed");
    return jsonResponse(
      {
        success: false,
        error: `${name} ${detail}`,
        kind,
      },
      200
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Provider test failed";
    return jsonResponse({ success: false, error: msg }, 200);
  }
});
