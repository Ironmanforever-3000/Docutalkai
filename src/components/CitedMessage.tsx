// src/components/CitedMessage.tsx
import React, { useState } from "react";
import { FileText, Compass, Sparkles, X, Loader2 } from "lucide-react";
import type { SourceCitation } from "../types";

export interface CitedMessageProps {
  content: string;
  sources?: SourceCitation[];
  isStreaming?: boolean;
  status?: "thinking" | "streaming" | "done" | "error";
  onLocate?: (chunkId: string) => void;
  onInspectSource?: (source: SourceCitation) => void;
}

/**
 * Parses section breadcrumbs like `[Document: ... | Section: ...]` from the raw chunk text.
 */
function cleanChunkBody(raw: string): { section: string | null; body: string } {
  const match = raw.match(/^\[Document:\s*.*?\s*\|\s*Section:\s*(.*?)\]\s*\n+/i);
  if (match) {
    return {
      section: match[1].trim(),
      body: raw.replace(match[0], "").trim(),
    };
  }
  return { section: null, body: raw.trim() };
}

export const CitedMessage: React.FC<CitedMessageProps> = ({
  content,
  sources = [],
  isStreaming = false,
  status = "done",
  onLocate,
  onInspectSource,
}) => {
  const [activeTooltip, setActiveTooltip] = useState<{
    citationIndex: number;
    source: SourceCitation;
    x: number;
    y: number;
  } | null>(null);

  // Map sources by citation index
  const sourceMap = new Map<number, SourceCitation>();
  sources.forEach((s) => {
    if (s.citationIndex) {
      sourceMap.set(s.citationIndex, s);
    }
  });

  const handleSourceSelect = (source: SourceCitation) => {
    onInspectSource?.(source);
    if (source.id) {
      onLocate?.(source.id);
    }
  };

  // Helper to render inline citations inside text strings
  const renderTextWithCitations = (text: string) => {
    const parts = text.split(/(\[\d+\])/g);

    return parts.map((part, index) => {
      const match = part.match(/^\[(\d+)\]$/);
      if (!match) {
        return <span key={index}>{part}</span>;
      }

      const num = parseInt(match[1], 10);
      const source = sourceMap.get(num);

      if (!source) {
        return (
          <span
            key={index}
            className="inline-flex items-center px-1.5 py-0.2 mx-0.5 rounded text-[11px] font-mono font-semibold bg-white/10 text-white/60 border border-white/10"
          >
            [{num}]
          </span>
        );
      }

      return (
        <button
          key={index}
          type="button"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setActiveTooltip((prev) =>
              prev?.citationIndex === num
                ? null
                : {
                    citationIndex: num,
                    source,
                    x: rect.left,
                    y: rect.bottom + 6,
                  }
            );
          }}
          className="inline-flex items-center gap-0.5 px-1.5 py-0.2 mx-0.5 rounded text-[11px] font-mono font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 hover:border-amber-400 transition-all cursor-pointer focus:outline-none"
          title={`Source [${num}]: ${source.document_name}`}
        >
          [{num}]
        </button>
      );
    });
  };

  // Parses text and Markdown tables into structured blocks
  const renderBlocks = () => {
    if (!content) return null;

    const lines = content.split("\n");
    const blocks: React.ReactNode[] = [];
    let currentTextLines: string[] = [];
    let inTable = false;
    let tableRows: string[][] = [];

    const flushText = () => {
      if (currentTextLines.length > 0) {
        const textChunk = currentTextLines.join("\n");
        blocks.push(
          <div key={`text-${blocks.length}`} className="whitespace-pre-wrap leading-relaxed">
            {renderTextWithCitations(textChunk)}
          </div>
        );
        currentTextLines = [];
      }
    };

    const flushTable = () => {
      if (tableRows.length >= 2) {
        // First row is header, second row is separator (---)
        const header = tableRows[0];
        const dataStartIndex = tableRows[1]?.some((c) => c.includes("---")) ? 2 : 1;
        const bodyRows = tableRows.slice(dataStartIndex);

        blocks.push(
          <div key={`table-${blocks.length}`} className="my-3 overflow-x-auto rounded-lg border border-ink-700 bg-ink-900/50">
            <table className="min-w-full divide-y divide-ink-700 text-xs text-left">
              <thead className="bg-ink-800/80 text-parchment font-semibold">
                <tr>
                  {header.map((col, idx) => (
                    <th key={idx} className="px-3 py-2 border-r border-ink-700/60 last:border-r-0">
                      {renderTextWithCitations(col.trim())}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-800 text-ash">
                {bodyRows.map((row, rIdx) => (
                  <tr key={rIdx} className="hover:bg-ink-800/40 transition-colors">
                    {row.map((cell, cIdx) => (
                      <td key={cIdx} className="px-3 py-2 border-r border-ink-700/40 last:border-r-0">
                        {renderTextWithCitations(cell.trim())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      tableRows = [];
      inTable = false;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check if line is a table row (starts and ends with |)
      const isTableRow = trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;

      if (isTableRow) {
        if (!inTable) {
          flushText();
          inTable = true;
        }
        // Split row into cell columns
        const cells = trimmed
          .slice(1, -1)
          .split("|")
          .map((c) => c.trim());
        tableRows.push(cells);
      } else {
        if (inTable) {
          flushTable();
        }
        currentTextLines.push(line);
      }
    }

    if (inTable) flushTable();
    flushText();

    return blocks;
  };

  return (
    <div className="relative">
      {/* Thinking Indicator */}
      {status === "thinking" && !content && (
        <div className="flex items-center gap-2 py-1 text-xs text-amber-300/90 font-medium">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
          <span>Searching knowledge base and thinking...</span>
        </div>
      )}

      {/* Main text & table content */}
      <div className="text-sm text-parchment space-y-1">
        {renderBlocks()}
        {isStreaming && (
          <span className="inline-block w-2 h-4 ml-1 bg-amber-500 animate-pulse align-middle" />
        )}
      </div>

      {/* Floating Citation Popover */}
      {activeTooltip && (
        <div
          className="fixed z-50 w-80 rounded-xl bg-ink-900 border border-amber-500/40 shadow-2xl p-3 text-xs animate-in fade-in zoom-in-95 duration-150"
          style={{
            top: `${Math.min(activeTooltip.y, window.innerHeight - 190)}px`,
            left: `${Math.max(16, Math.min(activeTooltip.x - 80, window.innerWidth - 340))}px`,
          }}
        >
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-ink-700">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="px-1.5 py-0.5 rounded bg-amber-500 text-ink-950 font-bold text-[10px]">
                [{activeTooltip.citationIndex}]
              </span>
              <FileText className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
              <span className="font-semibold text-parchment truncate">
                {activeTooltip.source.document_name}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setActiveTooltip(null)}
              className="p-0.5 rounded hover:bg-ink-800 text-ash hover:text-parchment transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {(() => {
            const { section, body } = cleanChunkBody(activeTooltip.source.content);
            return (
              <div className="mt-2 space-y-2">
                {section && (
                  <div className="text-[11px] text-amber-300 font-medium truncate">
                    Section: {section}
                  </div>
                )}
                <p className="text-ash/90 text-[11px] line-clamp-3 leading-relaxed">
                  {body || "No text available for this snippet."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    handleSourceSelect(activeTooltip.source);
                    setActiveTooltip(null);
                  }}
                  className="w-full mt-2 py-1.5 px-2 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Compass className="w-3.5 h-3.5" />
                  Locate in 2D Map
                </button>
              </div>
            );
          })()}
        </div>
      )}

      {/* Bottom Source Citations Row */}
      {sources.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-ink-700/60">
          <div className="text-[10px] uppercase font-semibold tracking-wider text-ash/60 mb-1.5 flex items-center gap-1">
            <Sparkles className="w-3 h-3 text-ember-400" />
            Sources Cited ({sources.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => (
              <button
                key={s.id || s.citationIndex}
                type="button"
                onClick={() => handleSourceSelect(s)}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-ink-900 hover:bg-ink-700 border border-ink-700 hover:border-amber-500/50 text-ash hover:text-parchment text-[11px] transition-colors group"
              >
                <span className="w-4 h-4 rounded bg-amber-500/20 text-amber-400 font-mono font-bold flex items-center justify-center text-[10px] group-hover:bg-amber-500 group-hover:text-ink-950 transition-colors">
                  {s.citationIndex}
                </span>
                <span className="truncate max-w-[140px] font-medium">
                  {s.document_name}
                </span>
                <span className="text-[10px] text-ash/50 font-mono">
                  #{(s.chunk_index ?? 0) + 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
