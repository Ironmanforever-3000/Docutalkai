import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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

    let endpoint = '';
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let payload: unknown;

    switch (provider) {
      case 'anthropic':
        endpoint = 'https://api.anthropic.com/v1/messages';
        headers = {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        };
        payload = {
          model: Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-3-5-sonnet-20241022',
          max_tokens: 10,
          system: 'Reply with just the word "ok".',
          messages: [{ role: 'user', content: 'ping' }],
        };
        break;
      case 'groq': {
        endpoint = 'https://api.groq.com/openai/v1/chat/completions';
        headers = {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        };
        const groqModels = (Deno.env.get("GROQ_MODELS") ?? "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b,llama-3.3-70b-versatile,llama-3.1-8b-instant").split(',').map(m => m.trim());
        payload = {
          model: groqModels[0],
          messages: [
            { role: 'system', content: 'Reply with just the word "ok".' },
            { role: 'user', content: 'ping' },
          ],
          max_tokens: 10,
        };
        break;
      }
      case 'openai':
        endpoint = 'https://api.openai.com/v1/chat/completions';
        headers = {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        };
        payload = {
          model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'Reply with just the word "ok".' },
            { role: 'user', content: 'ping' },
          ],
          max_tokens: 10,
        };
        break;
      default:
        return jsonResponse({ error: `Unsupported provider: ${provider}` }, 400);
    }

    const providerRes = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!providerRes.ok) {
      const text = await providerRes.text().catch(() => 'No response body');
      return jsonResponse({ error: `Provider responded with ${providerRes.status}: ${text}` }, 400);
    }

    return jsonResponse({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Provider test failed';
    return jsonResponse({ error: msg }, 500);
  }
});
