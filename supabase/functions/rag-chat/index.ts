// supabase/functions/rag-chat/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { embed } from "../_shared/embed.ts";
import {
  streamChatWithFallback,
  chatWithFallback,
  LlmUnavailableError,
  type StreamChatMessage,
  type Provider,
  type ChatMsg,
} from "../_shared/llm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const NEEDS_CONDENSE_REGEX =
  /\b(it|its|that|this|they|them|their|those|these|he|she|what about|how about|why|and the)\b/i;

function formatSSE(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      message,
      history = [],
      document_ids = null,
      provider = "groq",
      model,
      apiKey = "",
      apiKeys,
      stream = true, // Defaults to SSE streaming
    } = body;

    if (!message) {
      return new Response(JSON.stringify({ error: "message is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Lightweight contextual query condensing for ambiguous follow-ups
    let searchQuery = message;
    const wordCount = message.trim().split(/\s+/).length;
    if (history.length > 0 && (wordCount < 8 || NEEDS_CONDENSE_REGEX.test(message))) {
      const recentContext = history
        .slice(-2)
        .map((m: { role: string; content: string }) => m.content.slice(0, 200))
        .join(" | ");
      searchQuery = `${recentContext} — ${message}`;
    }

    // 2. Embed query (1024-dim Voyage-3) and retrieve chunks via hybrid search
    const [queryEmbedding] = await embed([searchQuery], "query");

    const matchDocIds =
      Array.isArray(document_ids) && document_ids.length > 0 ? document_ids : null;

    let matchedChunks: Array<Record<string, unknown>> = [];

    // Attempt hybrid search RPC
    const { data: chunks, error: rpcError } = await supabase.rpc("hybrid_match_chunks", {
      query_text: searchQuery,
      query_embedding: queryEmbedding,
      match_user_id: user.id,
      match_count: 8,
      match_document_ids: matchDocIds,
    });

    if (rpcError) {
      console.warn("hybrid_match_chunks failed, attempting fallback:", rpcError.message);
      // Fallback to match_document_chunks if hybrid_match_chunks is not yet deployed
      const { data: legacyChunks } = await supabase.rpc("match_document_chunks", {
        query_embedding: queryEmbedding,
        match_user_id: user.id,
        match_count: 8,
        match_threshold: 0.25,
        match_document_ids: matchDocIds,
      });
      if (legacyChunks) matchedChunks = legacyChunks;
    } else if (chunks) {
      matchedChunks = chunks;
    }

    // Fetch document titles for source cards
    const docIds = [
      ...new Set(matchedChunks.map((c) => c.document_id as string).filter(Boolean)),
    ];
    const docNameMap: Record<string, string> = {};
    if (docIds.length > 0) {
      const { data: docs } = await supabase
        .from("documents")
        .select("id, name")
        .in("id", docIds);
      for (const d of docs ?? []) {
        docNameMap[d.id] = d.name;
      }
    }

    const sources = matchedChunks.map((c, idx) => ({
      citationIndex: idx + 1,
      id: c.id as string,
      document_id: c.document_id as string,
      document_name: (c.document_name as string) || docNameMap[c.document_id as string] || "Document",
      chunk_index: (c.chunk_index as number) ?? idx,
      content: (c.content as string) || "",
      similarity: Number(c.similarity ?? c.rrf_score ?? 0),
      x_coordinate: (c.x_coordinate as number) ?? null,
      y_coordinate: (c.y_coordinate as number) ?? null,
    }));

    // 3. Assemble prompt with strict grounding and citation instructions
    const contextXml =
      sources.length > 0
        ? sources
            .map(
              (s) =>
                `<source id="${s.citationIndex}" document="${s.document_name}" chunk="${s.chunk_index}">\n${s.content}\n</source>`
            )
            .join("\n\n")
        : "<no_matching_passages_found />";

    const systemPrompt = `You are DocuTalk AI, a precise document intelligence assistant.
Answer the user's question using ONLY the provided <source> passages.
- Cite facts inline using bracketed numbers like [1] or [2] corresponding to the <source id="...">.
- If <no_matching_passages_found /> is present or the sources do not contain the answer, clearly state that the active documents do not contain passages matching this question. Never fabricate facts.

Retrieved Passages:
${contextXml}`;

    const chatHistory = history
      .filter((m: { role: string; content?: string; isError?: boolean }) =>
        (m.role === "user" || m.role === "assistant") &&
        !m.isError &&
        !(m.content || "").startsWith("AI connection failed")
      )
      .slice(-6);

    const streamMessages: StreamChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.map((m: { role: "user" | "assistant"; content: string }) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user", content: message },
    ];

    // If caller explicitly requested non-streaming JSON:
    if (!stream) {
      const nonStreamHistory: ChatMsg[] = [...chatHistory, { role: "user", content: message }];
      while (nonStreamHistory.length && nonStreamHistory[0].role !== "user") {
        nonStreamHistory.shift();
      }

      const result = await chatWithFallback({
        requested: provider,
        system: systemPrompt,
        messages: nonStreamHistory,
        keys: { apiKey, apiKeys },
      });

      return new Response(
        JSON.stringify({
          response: result.text,
          provider_used: result.provider,
          model_used: result.model,
          notice: result.notice,
          sources,
          vectorSearch: sources.length > 0,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 4. Open upstream LLM stream (resolves provider fallback before streaming begins)
    const {
      provider: activeProvider,
      model: activeModel,
      fallbackNotice,
      tokenStream,
    } = await streamChatWithFallback({
      provider: provider as Provider,
      model,
      keys: { apiKey, apiKeys },
      apiKey,
      messages: streamMessages,
    });

    // 5. Stream metadata first, then token deltas, then completion signal
    const readable = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(
            formatSSE({
              type: "meta",
              sources,
              provider: activeProvider,
              model: activeModel,
              fallbackNotice,
            })
          );

          for await (const token of tokenStream) {
            controller.enqueue(
              formatSSE({
                type: "token",
                content: token,
              })
            );
          }

          controller.enqueue(formatSSE({ type: "done" }));
        } catch (streamErr: unknown) {
          controller.enqueue(
            formatSSE({
              type: "error",
              message:
                streamErr instanceof Error
                  ? streamErr.message
                  : "Stream interrupted",
            })
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err: unknown) {
    console.error("rag-chat error:", err);
    if (err instanceof LlmUnavailableError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
