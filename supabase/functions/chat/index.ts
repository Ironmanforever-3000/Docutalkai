import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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

    // Build messages array
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    // Add conversation history
    if (history && Array.isArray(history)) {
      history.slice(-10).forEach((msg: ChatMessage) => {
        messages.push(msg);
      });
    }

    // Add current user message
    messages.push({ role: "user", content: message });

    let responseText = "";
    let usedProvider = provider || "groq";

    // Try Anthropic API
    if (!responseText && (provider === "anthropic" || !responseText) && (apiKey || Deno.env.get("ANTHROPIC_API_KEY"))) {
      try {
        const anthropicKey = apiKey || Deno.env.get("ANTHROPIC_API_KEY") || "";
        const anthropicModel = Deno.env.get("ANTHROPIC_MODEL") || "claude-3-5-sonnet-20241022";
        const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: anthropicModel,
            max_tokens: 2048,
            system: systemPrompt,
            messages: messages.filter((m: ChatMessage) => m.role !== "system").slice(-20),
          }),
        });

        if (anthropicResponse.ok) {
          const anthropicData = await anthropicResponse.json();
          responseText = anthropicData.content[0]?.text || "";
          usedProvider = "anthropic";
        } else {
          console.error("Anthropic API error:", await anthropicResponse.text());
        }
      } catch (e) {
        console.error("Anthropic request failed:", e);
      }
    }

    // Try Groq API (fast and free tier available)
    if (!responseText && (apiKey || Deno.env.get("GROQ_API_KEY"))) {
      try {
        const groqApiKey = apiKey || Deno.env.get("GROQ_API_KEY");
        const groqModel = Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-120b";
        const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: groqModel,
            messages: messages,
            temperature: 0.7,
            max_tokens: 2048,
            stream: false,
          }),
        });

        if (groqResponse.ok) {
          const groqData = await groqResponse.json();
          responseText = groqData.choices[0]?.message?.content || "";
          usedProvider = "groq";
        } else {
          console.error("Groq API error:", await groqResponse.text());
        }
      } catch (e) {
        console.error("Groq request failed:", e);
      }
    }

    // Fallback to OpenAI if others fail
    if (!responseText && Deno.env.get("OPENAI_API_KEY")) {
      try {
        const openaiKey = Deno.env.get("OPENAI_API_KEY") || "";
        const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: messages,
            temperature: 0.7,
            max_tokens: 2048,
          }),
        });

        if (openaiResponse.ok) {
          const openaiData = await openaiResponse.json();
          responseText = openaiData.choices[0]?.message?.content || "";
          usedProvider = "openai";
        }
      } catch (e) {
        console.error("OpenAI request failed:", e);
      }
    }

    // If no API configured, provide a simulated RAG response
    if (!responseText) {
      const docCount = documents?.length || 0;
      const hasContent = documents?.some((d: Document) => d.content_text);

      if (!hasContent || docCount === 0) {
        responseText = `Welcome to DocuTalk AI! I'm your intelligent document assistant.

**Status:** No documents with content are currently available for analysis.

**To get started:**
1. Upload documents to your Files library
2. I'll automatically process them for RAG-based responses
3. Ask questions about your documents and I'll provide context-aware answers

**What I can do:**
- Search through your documents for specific information
- Summarize content from your files
- Compare information across multiple documents
- Extract key insights and data points
- Answer questions with document citations

Upload some documents and ask me anything!`;
      } else {
        responseText = `Based on your ${docCount} document(s) in the library, I can help you analyze and extract insights.

**Your documents:**
${documents.map((d: Document, i: number) => `${i + 1}. ${d.name} (${d.file_type})`).join('\n')}

${contextText ? `I found relevant context in your documents. You asked: "${message}"

Here's what I found:

Based on the documents you've uploaded, I can analyze and provide insights. For more specific information, please ask detailed questions about particular aspects of your documents.

*Note: For enhanced AI responses, you can configure an API key in Settings > API Keys (Groq or OpenAI).*` : `Your documents are uploaded but haven't been fully processed yet. You asked: "${message}"

Please ask specific questions about your documents, and I'll do my best to help!`}`;
      }
      usedProvider = "simulated";
    }

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
    return new Response(
      JSON.stringify({ error: "Internal server error", details: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
