import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { callGroq, type ChatMsg } from "../_shared/groq.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface Document {
  id: string;
  name: string;
  content_text?: string;
  file_type: string;
}

async function callLLM(
  system: string,
  messages: ChatMsg[],
  apiKey: string,
  provider: string
): Promise<string> {
  if (provider === "groq") {
    const key = apiKey || Deno.env.get("GROQ_API_KEY") || "";
    const { text, model } = await callGroq({
      apiKey: key,
      system,
      messages,
    });
    console.log(`[Chat] Groq answered with ${model}`);
    return text;
  }

  if (provider === "anthropic") {
    const key = apiKey || Deno.env.get("ANTHROPIC_API_KEY") || "";
    if (!key) throw new Error("No API key for Anthropic");

    const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-5-5";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        system,
        messages,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const json = await res.json();
    return json.content?.[0]?.text ?? "";
  }

  if (provider === "openai") {
    const key = apiKey || Deno.env.get("OPENAI_API_KEY") || "";
    if (!key) throw new Error("No API key for OpenAI");

    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o-mini";
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        temperature: 0.3,
        messages: [{ role: "system", content: system }, ...messages],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { message, history, documents, apiKey, provider } = await req.json();

    if (!message) {
      return new Response(
        JSON.stringify({ error: "Message is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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

    const chat: ChatMsg[] = [...(history || []), { role: "user", content: message }]
      .filter((m: { role: string }) => m.role === "user" || m.role === "assistant")
      .slice(-12);
    while (chat.length && chat[0].role !== "user") chat.shift();

    const usedProvider = provider || "groq";
    const responseText = await callLLM(systemPrompt, chat, apiKey, usedProvider);

    return new Response(
      JSON.stringify({
        response: responseText,
        provider: usedProvider,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
