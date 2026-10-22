// supabase/functions/process-document/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { embed } from "../_shared/embed.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Target ~450 tokens (~1,800 chars) with ~15% sentence overlap (~270 chars)
const TARGET_CHUNK_CHARS = 1800;
const OVERLAP_CHARS = 270;

// Voyage batching & Edge Function wall-clock safety budget
const VOYAGE_BATCH_SIZE = 64;
const VOYAGE_FREE_TIER_DELAY_MS = 20_000; // Set to 0 if payment method is attached
const MAX_EXECUTION_BUDGET_MS = 110_000;  // Self-chain before Supabase 150s hard wall-clock limit

export interface StructuredChunk {
  chunkIndex: number;
  headingPath: string;
  content: string; // Includes Document + Section breadcrumb prefix
}

interface HeadingNode {
  level: number;
  title: string;
}

/**
 * Detects Markdown headings (# to ####) and structured PDF section headers
 * (e.g., "1.2 Scope of Work" or "SECTION 4: INDEMNIFICATION").
 */
function detectHeading(line: string): HeadingNode | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 120) return null;

  // 1. Standard Markdown Heading (# to ####)
  const mdMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
  if (mdMatch) {
    return {
      level: mdMatch[1].length,
      title: mdMatch[2].replace(/#+\s*$/, "").trim(),
    };
  }

  // 2. Numbered PDF Section Headings (e.g., "1. Introduction", "2.3.1 Warranty Terms")
  const numberedMatch = trimmed.match(/^(\d+(?:\.\d+){0,3})\.?\s+([A-Z][A-Za-z0-9\s,&/-]{2,80})$/);
  if (numberedMatch && !trimmed.endsWith(".")) {
    const depth = numberedMatch[1].split(".").length;
    return {
      level: Math.min(depth, 4),
      title: `${numberedMatch[1]} ${numberedMatch[2].trim()}`,
    };
  }

  return null;
}

/**
 * Splits oversized text along sentence boundaries while preserving overlap.
 */
function splitOversizedParagraph(text: string, maxChars: number, overlapChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
  const results: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    if ((current + " " + s).trim().length <= maxChars) {
      current = current ? `${current} ${s}` : s;
    } else {
      if (current) {
        results.push(current);
        const tail = current.slice(-overlapChars);
        const firstSpace = tail.indexOf(" ");
        const cleanOverlap = firstSpace !== -1 ? tail.slice(firstSpace + 1) : tail;
        current = `${cleanOverlap} ${s}`.trim();
      } else {
        // Single sentence exceeds maxChars — hard slice as last resort
        for (let i = 0; i < s.length; i += maxChars - overlapChars) {
          results.push(s.slice(i, i + maxChars));
        }
        current = "";
      }
    }
  }

  if (current) results.push(current);
  return results;
}

/**
 * Splits large Markdown tables across chunks while repeating column headers
 * at the top of each continuation chunk.
 */
function splitMarkdownTable(tableBlock: string, maxChars: number): string[] {
  const rows = tableBlock.trim().split("\n");
  if (rows.length <= 3 || tableBlock.length <= maxChars) {
    return [tableBlock];
  }

  const headerRow = rows[0];
  const separatorRow = rows[1].includes("---") ? rows[1] : "| --- |";
  const dataStartIndex = rows[1].includes("---") ? 2 : 1;
  const tableHeaderPrefix = `${headerRow}\n${separatorRow}`;

  const tableChunks: string[] = [];
  let currentChunk = tableHeaderPrefix;

  for (let i = dataStartIndex; i < rows.length; i++) {
    const row = rows[i];
    if ((currentChunk + "\n" + row).length > maxChars && currentChunk !== tableHeaderPrefix) {
      tableChunks.push(currentChunk);
      currentChunk = `${tableHeaderPrefix}\n${row}`;
    } else {
      currentChunk += `\n${row}`;
    }
  }

  if (currentChunk !== tableHeaderPrefix) {
    tableChunks.push(currentChunk);
  }

  return tableChunks;
}

/**
 * Structure-aware chunker that tracks heading breadcrumbs and keeps atomic blocks intact.
 */
export function chunkDocumentWithBreadcrumbs(
  rawText: string,
  documentTitle: string
): StructuredChunk[] {
  const normalized = rawText.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const lines = normalized.split("\n");
  const headingStack: HeadingNode[] = [];

  interface SectionBlock {
    breadcrumb: string;
    paragraphs: string[];
  }

  const sections: SectionBlock[] = [];
  let currentParagraphLines: string[] = [];
  let currentSection: SectionBlock = {
    breadcrumb: "Overview",
    paragraphs: [],
  };
  sections.push(currentSection);

  let inCodeFence = false;
  let inTable = false;

  const getBreadcrumbString = () =>
    headingStack.length > 0 ? headingStack.map((h) => h.title).join(" > ") : "Overview";

  const flushParagraph = () => {
    const joined = currentParagraphLines.join("\n").trim();
    if (joined) {
      currentSection.paragraphs.push(joined);
    }
    currentParagraphLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Protect fenced code blocks from heading detection or blank-line splitting
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      currentParagraphLines.push(line);
      if (!inCodeFence) flushParagraph();
      continue;
    }

    if (inCodeFence) {
      currentParagraphLines.push(line);
      continue;
    }

    // Group contiguous Markdown table rows together
    const isTableRow = trimmed.startsWith("|") && trimmed.endsWith("|");
    if (isTableRow) {
      if (!inTable) {
        flushParagraph();
        inTable = true;
      }
      currentParagraphLines.push(line);
      continue;
    } else if (inTable) {
      flushParagraph();
      inTable = false;
    }

    // Check for section heading
    const heading = detectHeading(line);
    if (heading) {
      flushParagraph();

      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= heading.level
      ) {
        headingStack.pop();
      }
      headingStack.push(heading);

      currentSection = {
        breadcrumb: getBreadcrumbString(),
        paragraphs: [],
      };
      sections.push(currentSection);
      continue;
    }

    // Blank line marks paragraph boundary
    if (!trimmed) {
      flushParagraph();
    } else {
      currentParagraphLines.push(line);
    }
  }
  flushParagraph();

  // Pack section paragraphs into chunks and prepend breadcrumb headers
  const finalChunks: StructuredChunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    if (section.paragraphs.length === 0) continue;

    const headerPrefix = `[Document: ${documentTitle} | Section: ${section.breadcrumb}]\n\n`;
    const bodyBudget = Math.max(TARGET_CHUNK_CHARS - headerPrefix.length, 600);

    let buffer = "";

    const emitChunk = (bodyText: string) => {
      const cleanBody = bodyText.trim();
      if (!cleanBody) return;
      finalChunks.push({
        chunkIndex: chunkIndex++,
        headingPath: section.breadcrumb,
        content: `${headerPrefix}${cleanBody}`,
      });
    };

    for (const para of section.paragraphs) {
      const isTableBlock = para.startsWith("|") && para.includes("\n|");

      if (isTableBlock) {
        if (buffer) {
          emitChunk(buffer);
          buffer = "";
        }
        const tableSlices = splitMarkdownTable(para, bodyBudget);
        for (const slice of tableSlices) {
          emitChunk(slice);
        }
        continue;
      }

      if (para.length > bodyBudget) {
        if (buffer) {
          emitChunk(buffer);
          buffer = "";
        }
        const subChunks = splitOversizedParagraph(para, bodyBudget, OVERLAP_CHARS);
        for (const sub of subChunks) {
          emitChunk(sub);
        }
        continue;
      }

      if ((buffer + "\n\n" + para).trim().length <= bodyBudget) {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
      } else {
        emitChunk(buffer);
        const tail = buffer.slice(-OVERLAP_CHARS);
        const firstBreak = tail.indexOf(" ");
        const overlapSnippet = firstBreak !== -1 ? tail.slice(firstBreak + 1).trim() : "";
        buffer = overlapSnippet ? `${overlapSnippet}\n\n${para}` : para;
      }
    }

    if (buffer) {
      emitChunk(buffer);
    }
  }

  return finalChunks;
}

/**
 * Computes centered 2D coordinates for DocuTalk AI's 2D semantic chunk visualizer.
 */
function compute2DProjection(embeddings: number[][]): { x: number; y: number }[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;

  const rawCoords = embeddings.map((vec) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < dim; i++) {
      x += vec[i] * Math.cos((i * 17) % 360);
      y += vec[i] * Math.sin((i * 31) % 360);
    }
    return { x, y };
  });

  const xs = rawCoords.map((c) => c.x);
  const ys = rawCoords.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  return rawCoords.map((c) => ({
    x: Number((((c.x - minX) / spanX) * 2 - 1).toFixed(4)),
    y: Number((((c.y - minY) / spanY) * 2 - 1).toFixed(4)),
  }));
}

/**
 * Self-chains the next Edge Function invocation if approaching the timeout budget.
 */
async function spawnNextInvocation(
  documentId: string,
  nextOffset: number,
  fallbackAuthHeader: string
): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl) return;

  const authHeader = serviceKey ? `Bearer ${serviceKey}` : fallbackAuthHeader;

  await fetch(`${supabaseUrl}/functions/v1/process-document`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({
      document_id: documentId,
      start_offset: nextOffset,
    }),
  }).catch((err) => {
    console.error("[process-document] Self-chain invocation failed:", err);
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const startTime = Date.now();
  const callerAuthHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

  const supabase = createClient(
    supabaseUrl,
    supabaseServiceKey || supabaseAnonKey,
    callerAuthHeader && !supabaseServiceKey
      ? { global: { headers: { Authorization: callerAuthHeader } } }
      : undefined
  );

  let documentId: string | null = null;

  try {
    const body = await req.json();
    documentId = body.document_id;
    const startOffset: number = body.start_offset ?? 0;

    if (!documentId) {
      return new Response(JSON.stringify({ error: "document_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Fetch document record
    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("id, user_id, name, content_text, extracted_text")
      .eq("id", documentId)
      .single();

    if (docErr || !doc) {
      throw new Error(`Document not found (${documentId}): ${docErr?.message}`);
    }

    let rawText: string = doc.content_text || doc.extracted_text || "";

    // If the client offloaded large extracted text (>400KB) to Supabase Storage:
    if (rawText.startsWith("__STORAGE_SIDECAR__:")) {
      const sidecarPath = rawText.replace("__STORAGE_SIDECAR__:", "").trim();
      const { data: sidecarBlob, error: downloadErr } = await supabase.storage
        .from("documents")
        .download(sidecarPath);

      if (downloadErr || !sidecarBlob) {
        throw new Error(
          `Failed to read sidecar text from storage (${sidecarPath}): ${downloadErr?.message}`
        );
      }
      rawText = await sidecarBlob.text();
    }

    if (rawText.trim().length < 20) {
      await supabase
        .from("documents")
        .update({ status: "failed", error_message: "Document contains no extractable text." })
        .eq("id", documentId);

      return new Response(
        JSON.stringify({ error: "Document contains no extractable text." }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Mark document as processing and clear stale chunks on initial run
    if (startOffset === 0) {
      await supabase.from("documents").update({ status: "processing" }).eq("id", documentId);
      await supabase.from("document_chunks").delete().eq("document_id", documentId);
    }

    // 3. Generate structure-aware chunks with heading breadcrumbs
    const allChunks = chunkDocumentWithBreadcrumbs(rawText, doc.name || "Untitled Document");
    const remainingChunks = allChunks.slice(startOffset);

    let processedUpTo = startOffset;

    // 4. Process in batches of 64 chunks per Voyage AI request
    for (let i = 0; i < remainingChunks.length; i += VOYAGE_BATCH_SIZE) {
      const elapsedMs = Date.now() - startTime;
      if (i > 0 && elapsedMs > MAX_EXECUTION_BUDGET_MS) {
        console.log(
          `[process-document] Approaching timeout (${elapsedMs}ms). Chaining at offset ${processedUpTo}/${allChunks.length}`
        );
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
          EdgeRuntime.waitUntil(
            spawnNextInvocation(documentId, processedUpTo, callerAuthHeader)
          );
        } else {
          spawnNextInvocation(documentId, processedUpTo, callerAuthHeader);
        }

        return new Response(
          JSON.stringify({
            status: "processing_continued",
            document_id: documentId,
            processed_chunks: processedUpTo,
            total_chunks: allChunks.length,
          }),
          { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (i > 0 && VOYAGE_FREE_TIER_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, VOYAGE_FREE_TIER_DELAY_MS));
      }

      const batch = remainingChunks.slice(i, i + VOYAGE_BATCH_SIZE);
      const batchTexts = batch.map((c) => c.content);

      const embeddings = await embed(batchTexts, "document");
      const coords = compute2DProjection(embeddings);

      const rowsToInsert = batch.map((chunk, idx) => ({
        document_id: doc.id,
        user_id: doc.user_id,
        chunk_index: chunk.chunkIndex,
        content: chunk.content,
        embedding: embeddings[idx],
        x_coordinate: coords[idx]?.x ?? 0,
        y_coordinate: coords[idx]?.y ?? 0,
      }));

      const { error: insertErr } = await supabase
        .from("document_chunks")
        .insert(rowsToInsert);

      if (insertErr) {
        throw new Error(`Failed inserting chunks: ${insertErr.message}`);
      }

      processedUpTo += batch.length;
    }

    // 5. All chunks embedded and stored — mark document ready
    await supabase
      .from("documents")
      .update({
        status: "ready",
        processed: true,
      })
      .eq("id", documentId);

    return new Response(
      JSON.stringify({
        status: "ready",
        document_id: documentId,
        total_chunks: allChunks.length,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    console.error("[process-document] Fatal error:", err);

    if (documentId) {
      await supabase
        .from("documents")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", documentId)
        .catch(() => {});
    }

    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Failed to process document" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
