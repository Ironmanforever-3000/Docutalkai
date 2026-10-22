import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { chatWithFallback, LlmUnavailableError, type ChatMsg } from "../_shared/llm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface Document {
  id: string;
  name: string;
  content_text?: string;
  file_type: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { message, history, documents, apiKey, apiKeys, provider } = await req.json();

    if (!message) {
      return jsonResponse({ error: "Message is required" }, 400);
    }

    // Build context from documents
    let contextText = "";
    if (documents && documents.length > 0) {
      contextText = "\n\n--- Document Context ---\n";
      documents.forEach((doc: Document, index: number) => {
        if (doc.content_text) {
          contextText += `\n[Document ${index + 1}: ${doc.name}]\n${doc.content_text.slice(0, 2000)}\n`;
        }
      });
    }

    // Build system prompt
    const systemPrompt = `You are DocuTalk AI, an intelligent document assistant. You help users understand, analyze, and extract insights from their documents using RAG (Retrieval-Augmented Generation) technology.

Your capabilities include:
- Answering questions about document content
- Summarizing documents
- Comparing information across documents
- Extracting key insights and data points
- Providing citations when referencing documents

IMPORTANT: Always cite which document you're referencing when providing specific information.
${contextText ? `\n\nRelevant documents have been provided in the context. Use this information to answer user questions accurately.` : `\n\nNote: No documents with content are currently available in the user's library. Encourage them to upload documents for context-aware responses.`}

Be helpful, accurate, and concise. If you cannot find relevant information in the documents, clearly state that.`;

    const HISTORY_LIMIT = 12;

    const chat: ChatMsg[] = [...(history || []), { role: "user", content: message }]
      .filter(
        (m: { role: string; content?: string; isError?: boolean }) =>
          (m.role === "user" || m.role === "assistant") &&
          !m.isError &&
          !(m.content || "").startsWith("AI connection failed")
      )
      .slice(-HISTORY_LIMIT);
    while (chat.length && chat[0].role !== "user") chat.shift();

    const result = await chatWithFallback({
      requested: provider,
      system: systemPrompt,
      messages: chat,
      keys: { apiKey, apiKeys },
    });

    return jsonResponse({
      response: result.text,
      provider_used: result.provider,
      model_used: result.model,
      notice: result.notice,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error:", error);
    if (error instanceof LlmUnavailableError) {
      return jsonResponse({ error: error.message }, 502);
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    return jsonResponse({ error: message }, 500);
  }
});
