import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callGroq } from "../_shared/groq.ts";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json();
    const { provider, apiKey } = body;

    if (!provider || !apiKey) {
      return jsonResponse({ error: 'provider and apiKey are required' }, 400);
    }

    if (provider === 'groq') {
      const { model } = await callGroq({
        apiKey,
        system: 'Reply with just the word "ok".',
        messages: [{ role: 'user', content: 'ping' }],
        maxTokens: 256,
      });
      return jsonResponse({ success: true, model });
    }

    if (provider === 'anthropic') {
      const model = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-5-5';
      const providerRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 100,
          system: 'Reply with just the word "ok".',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });

      if (!providerRes.ok) {
        const text = await providerRes.text().catch(() => 'No response body');
        return jsonResponse({ error: `Provider responded with ${providerRes.status}: ${text}` }, 400);
      }

      return jsonResponse({ success: true, model });
    }

    if (provider === 'openai') {
      const model = Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini';
      const providerRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'Reply with just the word "ok".' },
            { role: 'user', content: 'ping' },
          ],
          max_tokens: 100,
        }),
      });

      if (!providerRes.ok) {
        const text = await providerRes.text().catch(() => 'No response body');
        return jsonResponse({ error: `Provider responded with ${providerRes.status}: ${text}` }, 400);
      }

      return jsonResponse({ success: true, model });
    }

    return jsonResponse({ error: `Unsupported provider: ${provider}` }, 400);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Provider test failed';
    return jsonResponse({ error: msg }, 500);
  }
});
