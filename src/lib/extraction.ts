// src/lib/extraction.ts
import * as pdfjsLib from "pdfjs-dist";
import mammoth from "mammoth";

// Ensure Web Worker is configured properly for pdfjs-dist
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).toString();
} catch {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
    window.location.origin
  ).toString();
}

export interface ExtractionProgress {
  phase: "reading" | "extracting" | "complete";
  currentPage?: number;
  totalPages?: number;
  percent: number;
}

export interface ExtractionResult {
  text: string;
  pageCount: number;
  charCount: number;
}

export interface LegacyExtractionResult {
  status: "ready" | "failed";
  text: string | null;
  charCount: number;
  errorMessage: string | null;
  pageCount?: number;
}

const yieldToMainThread = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Extracts text from a PDF file page-by-page while aggressively freeing RAM
 * and converting larger font sizes into Markdown headings (# / ##).
 */
async function extractPdfStreamed(
  file: File,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<ExtractionResult> {
  onProgress?.({ phase: "reading", percent: 5 });

  const arrayBuffer = await file.arrayBuffer();
  const typedArray = new Uint8Array(arrayBuffer);

  const loadingTask = pdfjsLib.getDocument({
    data: typedArray,
    disableAutoFetch: true, // Do not pre-allocate all pages in memory
    disableStream: false,
  });

  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pageTexts: string[] = [];
  let totalChars = 0;

  try {
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // 1. Estimate median body font height on this page
      const fontHeights: number[] = [];
      for (const item of textContent.items as Array<Record<string, unknown>>) {
        if (typeof item.str === "string" && item.str.trim() && Array.isArray(item.transform)) {
          const fontHeight = Math.abs((item.transform[3] as number) || (item.height as number) || 10);
          if (fontHeight > 0) fontHeights.push(fontHeight);
        }
      }

      fontHeights.sort((a, b) => a - b);
      const medianFontHeight =
        fontHeights.length > 0
          ? fontHeights[Math.floor(fontHeights.length / 2)]
          : 11;

      // 2. Group text items into lines by Y-coordinate and infer headings
      const lines: { text: string; maxHeight: number; y: number }[] = [];
      let currentLineText = "";
      let currentLineMaxHeight = 0;
      let lastY: number | null = null;

      for (const item of textContent.items as Array<Record<string, unknown>>) {
        if (typeof item.str !== "string") continue;
        const transform = Array.isArray(item.transform) ? item.transform : [];
        const y = transform.length >= 6 ? Math.round(transform[5] as number) : 0;
        const height = transform.length >= 4
          ? Math.abs((transform[3] as number) || (item.height as number) || medianFontHeight)
          : medianFontHeight;

        // Detect line break when Y coordinate shifts by more than 3pt
        if (lastY !== null && Math.abs(y - lastY) > 3) {
          if (currentLineText.trim()) {
            lines.push({
              text: currentLineText.trim(),
              maxHeight: currentLineMaxHeight,
              y: lastY,
            });
          }
          currentLineText = item.str;
          currentLineMaxHeight = height;
        } else {
          currentLineText +=
            currentLineText && !currentLineText.endsWith(" ") && !item.str.startsWith(" ")
              ? ` ${item.str}`
              : item.str;
          currentLineMaxHeight = Math.max(currentLineMaxHeight, height);
        }
        lastY = y;
      }

      if (currentLineText.trim() && lastY !== null) {
        lines.push({
          text: currentLineText.trim(),
          maxHeight: currentLineMaxHeight,
          y: lastY,
        });
      }

      // 3. Convert lines to Markdown with heading prefixes for large fonts
      const formattedLines: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const ratio = medianFontHeight > 0 ? line.maxHeight / medianFontHeight : 1;
        const isShortHeading =
          line.text.length > 2 &&
          line.text.length < 100 &&
          !line.text.endsWith(".");

        if (isShortHeading && ratio >= 1.45) {
          formattedLines.push(`\n# ${line.text}\n`);
        } else if (isShortHeading && ratio >= 1.2) {
          formattedLines.push(`\n## ${line.text}\n`);
        } else {
          // Insert paragraph break if vertical gap to previous line is large
          const prevY = i > 0 ? lines[i - 1].y : line.y;
          const verticalGap = Math.abs(prevY - line.y);
          if (i > 0 && verticalGap > medianFontHeight * 1.8) {
            formattedLines.push(`\n${line.text}`);
          } else {
            formattedLines.push(line.text);
          }
        }
      }

      const pageString = formattedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (pageString) {
        pageTexts.push(pageString);
        totalChars += pageString.length;
      }

      // CRITICAL: Release page resources immediately so 30MB PDFs don't balloon RAM
      page.cleanup();

      const percent = Math.min(95, Math.round((pageNum / totalPages) * 90) + 5);
      onProgress?.({
        phase: "extracting",
        currentPage: pageNum,
        totalPages,
        percent,
      });

      // Yield to browser UI thread every 5 pages so the tab stays responsive
      if (pageNum % 5 === 0) {
        await yieldToMainThread();
      }
    }
  } finally {
    try {
      await pdf.cleanup();
      await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
    } catch {
      // Ignore destroy errors
    }
  }

  const fullText = pageTexts.join("\n\n");

  if (totalChars < 50) {
    throw new Error(
      `This PDF has no selectable text (extracted ${totalChars} characters across ${totalPages} pages). It appears to be a scanned image PDF — OCR is not supported yet.`
    );
  }

  onProgress?.({
    phase: "complete",
    currentPage: totalPages,
    totalPages,
    percent: 100,
  });

  return {
    text: fullText,
    pageCount: totalPages,
    charCount: totalChars,
  };
}

export async function extractDocumentText(
  file: File,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<ExtractionResult> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (file.type === "application/pdf" || ext === "pdf") {
    return await extractPdfStreamed(file, onProgress);
  }

  if (
    file.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    onProgress?.({ phase: "extracting", percent: 40 });
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    const clean = value.trim();
    if (clean.length < 20) {
      throw new Error("DOCX file contains no readable text.");
    }
    onProgress?.({ phase: "complete", percent: 100 });
    return { text: clean, pageCount: 1, charCount: clean.length };
  }

  // Plain text, Markdown, CSV, JSON
  onProgress?.({ phase: "extracting", percent: 50 });
  const text = (await file.text()).trim();
  if (!text) {
    throw new Error("The uploaded text file is empty.");
  }
  onProgress?.({ phase: "complete", percent: 100 });
  return { text, pageCount: 1, charCount: text.length };
}

/**
 * Backward-compatible wrapper for existing components.
 */
export async function extractTextFromFile(
  file: File,
  onProgress?: (progress: ExtractionProgress) => void
): Promise<LegacyExtractionResult> {
  try {
    const result = await extractDocumentText(file, onProgress);
    return {
      status: "ready",
      text: result.text,
      charCount: result.charCount,
      pageCount: result.pageCount,
      errorMessage: null,
    };
  } catch (err: unknown) {
    return {
      status: "failed",
      text: null,
      charCount: 0,
      errorMessage: err instanceof Error ? err.message : "Text extraction failed.",
    };
  }
}
