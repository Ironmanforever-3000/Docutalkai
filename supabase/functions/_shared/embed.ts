// supabase/functions/_shared/embed.ts

export type EmbedInputType = "document" | "query";

const VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-3"; // Native 1024 dimensions
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function embed(
  texts: string[],
  inputType: EmbedInputType = "document"
): Promise<number[][]> {
  if (!texts.length) return [];

  const apiKey = Deno.env.get("VOYAGE_API_KEY");
  if (!apiKey) {
    throw new Error("Missing VOYAGE_API_KEY in Edge Function secrets.");
  }

  // Sanitize empty strings so Voyage API doesn't reject the batch
  const sanitizedTexts = texts.map((t) => (t.trim().length > 0 ? t : " "));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(VOYAGE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: sanitizedTexts,
        model: VOYAGE_MODEL,
        input_type: inputType,
        truncation: true,
      }),
    });

    if (res.ok) {
      const payload = await res.json();
      // Return native 1024-dimensional embeddings without zero-padding
      return payload.data.map((item: { embedding: number[] }) => item.embedding);
    }

    const errText = await res.text().catch(() => `HTTP ${res.status}`);

    // Handle rate limits (429) or transient 5xx errors with exponential backoff
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retrySeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const backoffMs = !isNaN(retrySeconds)
        ? retrySeconds * 1000
        : Math.min(20_000 * Math.pow(1.5, attempt), 45_000);

      console.warn(
        `[embed] Voyage HTTP ${res.status} on attempt ${attempt + 1}. Waiting ${backoffMs}ms...`
      );
      await sleep(backoffMs);
      continue;
    }

    throw new Error(`Voyage embedding error (${res.status}): ${errText.slice(0, 250)}`);
  }

  throw new Error("Exhausted retries calling Voyage AI embeddings.");
}
