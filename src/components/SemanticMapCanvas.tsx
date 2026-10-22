// src/components/SemanticMapCanvas.tsx
import React, { useEffect, useRef, useState, useMemo } from "react";
import { Compass, RotateCcw, ZoomIn, ZoomOut, X, Sparkles, FileText } from "lucide-react";
import type { SourceCitation } from "../types";

export interface MapChunkNode {
  id: string;
  document_id: string;
  document_name?: string;
  chunk_index: number;
  content: string;
  x_coordinate?: number | null;
  y_coordinate?: number | null;
  x_coord?: number | null;
  y_coord?: number | null;
}

interface SemanticMapCanvasProps {
  chunks: MapChunkNode[];
  activeSources: SourceCitation[];
  highlightedChunkId: string | null;
  onSelectChunk: (chunkId: string | null) => void;
}

interface NormalizedPoint {
  id: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  x: number; // Normalized to [-1, 1]
  y: number; // Normalized to [-1, 1]
  citationIndex?: number;
  similarity?: number;
  isRetrieved: boolean;
}

/**
 * Generates deterministic golden-angle spiral coordinates in [-0.85, 0.85]
 * if a chunk row was inserted before coordinates were computed.
 */
function fallbackCoords(index: number, total: number): { x: number; y: number } {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const radius = 0.15 + 0.7 * Math.sqrt((index + 1) / Math.max(total, 1));
  const theta = index * goldenAngle;
  return {
    x: Number((radius * Math.cos(theta)).toFixed(4)),
    y: Number((radius * Math.sin(theta)).toFixed(4)),
  };
}

/**
 * Strips the `[Document: ... | Section: ...]` prefix for clean HUD display.
 */
function extractBreadcrumbAndBody(raw: string): { section: string | null; body: string } {
  const match = raw.match(/^\[Document:\s*.*?\s*\|\s*Section:\s*(.*?)\]\s*\n+/i);
  if (match) {
    return {
      section: match[1].trim(),
      body: raw.replace(match[0], "").trim(),
    };
  }
  return { section: null, body: raw.trim() };
}

export const SemanticMapCanvas: React.FC<SemanticMapCanvasProps> = ({
  chunks,
  activeSources,
  highlightedChunkId,
  onSelectChunk,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const cameraRef = useRef({
    panX: 0,
    panY: 0,
    zoom: 1,
    targetPanX: 0,
    targetPanY: 0,
    targetZoom: 1,
  });

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const isDraggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });

  // Merge all background chunks with the active turn's retrieved citation sources
  const points: NormalizedPoint[] = useMemo(() => {
    const sourceById = new Map<string, SourceCitation>();
    activeSources.forEach((s) => sourceById.set(s.id, s));

    const mergedMap = new Map<string, NormalizedPoint>();

    chunks.forEach((c, idx) => {
      const matchedSource = sourceById.get(c.id);
      const rawX = c.x_coordinate ?? c.x_coord;
      const rawY = c.y_coordinate ?? c.y_coord;

      const hasValidCoords =
        typeof rawX === "number" &&
        typeof rawY === "number" &&
        (rawX !== 0 || rawY !== 0);

      const coords = hasValidCoords
        ? { x: rawX!, y: rawY! }
        : fallbackCoords(idx, chunks.length);

      mergedMap.set(c.id, {
        id: c.id,
        document_id: c.document_id,
        document_name: matchedSource?.document_name || c.document_name || "Document",
        chunk_index: c.chunk_index,
        content: c.content,
        x: Math.max(-1, Math.min(1, coords.x)),
        y: Math.max(-1, Math.min(1, coords.y)),
        citationIndex: matchedSource?.citationIndex,
        similarity: matchedSource?.similarity,
        isRetrieved: Boolean(matchedSource),
      });
    });

    activeSources.forEach((s, idx) => {
      if (!mergedMap.has(s.id)) {
        const rawX = s.x_coordinate;
        const rawY = s.y_coordinate;
        const hasValidCoords =
          typeof rawX === "number" &&
          typeof rawY === "number" &&
          (rawX !== 0 || rawY !== 0);

        const coords = hasValidCoords
          ? { x: rawX!, y: rawY! }
          : fallbackCoords(idx, activeSources.length);

        mergedMap.set(s.id, {
          id: s.id,
          document_id: s.document_id,
          document_name: s.document_name,
          chunk_index: s.chunk_index,
          content: s.content,
          x: Math.max(-1, Math.min(1, coords.x)),
          y: Math.max(-1, Math.min(1, coords.y)),
          citationIndex: s.citationIndex,
          similarity: s.similarity,
          isRetrieved: true,
        });
      }
    });

    return Array.from(mergedMap.values());
  }, [chunks, activeSources]);

  // Smoothly pan & zoom camera onto highlightedChunkId whenever it changes
  useEffect(() => {
    if (!highlightedChunkId) return;
    const targetNode = points.find((p) => p.id === highlightedChunkId);
    if (!targetNode) return;

    cameraRef.current.targetPanX = -targetNode.x;
    cameraRef.current.targetPanY = -targetNode.y;
    cameraRef.current.targetZoom = Math.max(cameraRef.current.targetZoom, 1.65);
  }, [highlightedChunkId, points]);

  const resetCamera = () => {
    cameraRef.current.targetPanX = 0;
    cameraRef.current.targetPanY = 0;
    cameraRef.current.targetZoom = 1;
  };

  const adjustZoom = (delta: number) => {
    cameraRef.current.targetZoom = Math.min(
      4,
      Math.max(0.7, cameraRef.current.targetZoom + delta)
    );
  };

  const toScreenCoords = (nx: number, ny: number, width: number, height: number) => {
    const cam = cameraRef.current;
    const pad = 42;
    const halfW = (width - pad * 2) / 2;
    const halfH = (height - pad * 2) / 2;
    const centerX = width / 2;
    const centerY = height / 2;

    return {
      sx: centerX + (nx + cam.panX) * halfW * cam.zoom,
      sy: centerY + (ny + cam.panY) * halfH * cam.zoom,
    };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;

    const render = (time: number) => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
        canvas.width = Math.round(rect.width * dpr);
        canvas.height = Math.round(rect.height * dpr);
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      const width = rect.width;
      const height = rect.height;

      const cam = cameraRef.current;
      cam.panX += (cam.targetPanX - cam.panX) * 0.12;
      cam.panY += (cam.targetPanY - cam.panY) * 0.12;
      cam.zoom += (cam.targetZoom - cam.zoom) * 0.12;

      ctx.fillStyle = "#0c101a";
      ctx.fillRect(0, 0, width, height);

      ctx.strokeStyle = "rgba(51, 65, 85, 0.25)";
      ctx.lineWidth = 1;
      const gridSteps = [-0.5, 0, 0.5];
      for (const g of gridSteps) {
        const { sx } = toScreenCoords(g, 0, width, height);
        const { sy } = toScreenCoords(0, g, width, height);

        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, height);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
        ctx.stroke();
      }

      const retrievedNodes = points.filter((p) => p.isRetrieved);
      if (retrievedNodes.length > 1) {
        ctx.save();
        ctx.strokeStyle = "rgba(99, 102, 241, 0.28)";
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        retrievedNodes.forEach((node, idx) => {
          const { sx, sy } = toScreenCoords(node.x, node.y, width, height);
          if (idx === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        });
        ctx.stroke();
        ctx.restore();
      }

      const sortedPoints = [...points].sort((a, b) => {
        if (a.id === highlightedChunkId) return 1;
        if (b.id === highlightedChunkId) return -1;
        if (a.isRetrieved !== b.isRetrieved) return a.isRetrieved ? 1 : -1;
        return 0;
      });

      for (const pt of sortedPoints) {
        const { sx, sy } = toScreenCoords(pt.x, pt.y, width, height);
        if (sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40) continue;

        const isHighlighted = pt.id === highlightedChunkId;
        const isHovered = pt.id === hoveredNodeId;

        if (isHighlighted) {
          const pulsePhase1 = (time % 1800) / 1800;
          const pulsePhase2 = ((time + 900) % 1800) / 1800;

          const drawSonarRing = (phase: number) => {
            const radius = 8 + phase * 34;
            const alpha = Math.max(0, (1 - phase) * 0.75);
            ctx.beginPath();
            ctx.arc(sx, sy, radius, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(245, 158, 11, ${alpha})`;
            ctx.lineWidth = 2.2;
            ctx.stroke();
          };

          drawSonarRing(pulsePhase1);
          drawSonarRing(pulsePhase2);

          ctx.strokeStyle = "rgba(251, 191, 36, 0.4)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx - 18, sy);
          ctx.lineTo(sx + 18, sy);
          ctx.moveTo(sx, sy - 18);
          ctx.lineTo(sx, sy + 18);
          ctx.stroke();
        }

        const baseRadius = isHighlighted ? 8.5 : pt.isRetrieved ? 6.5 : isHovered ? 5.5 : 3.8;

        ctx.beginPath();
        ctx.arc(sx, sy, baseRadius, 0, Math.PI * 2);

        if (isHighlighted) {
          ctx.fillStyle = "#f59e0b";
          ctx.shadowColor = "rgba(245, 158, 11, 0.8)";
          ctx.shadowBlur = 14;
        } else if (pt.isRetrieved) {
          ctx.fillStyle = "#6366f1";
          ctx.shadowColor = "rgba(99, 102, 241, 0.6)";
          ctx.shadowBlur = 8;
        } else if (isHovered) {
          ctx.fillStyle = "#94a3b8";
          ctx.shadowBlur = 0;
        } else {
          ctx.fillStyle = "rgba(100, 116, 139, 0.45)";
          ctx.shadowBlur = 0;
        }

        ctx.fill();
        ctx.shadowBlur = 0;

        if (isHighlighted || pt.isRetrieved || isHovered) {
          ctx.strokeStyle = isHighlighted ? "#fef3c7" : "#e0e7ff";
          ctx.lineWidth = isHighlighted ? 2 : 1.2;
          ctx.stroke();
        }

        if (pt.citationIndex !== undefined) {
          const label = `[${pt.citationIndex}]`;
          ctx.font = isHighlighted ? "bold 11px Inter, sans-serif" : "600 10px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.fillStyle = isHighlighted ? "#fde68a" : "#c7d2fe";
          ctx.fillText(label, sx, sy - baseRadius - 5);
        }
      }

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, [points, highlightedChunkId, hoveredNodeId]);

  const findNodeAtPosition = (clientX: number, clientY: number): NormalizedPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;

    let closest: NormalizedPoint | null = null;
    let minDist = 14;

    for (const pt of points) {
      const { sx, sy } = toScreenCoords(pt.x, pt.y, rect.width, rect.height);
      const dist = Math.hypot(mx - sx, my - sy);
      if (dist < minDist) {
        minDist = dist;
        closest = pt;
      }
    }
    return closest;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (isDraggingRef.current) {
      const rect = canvas.getBoundingClientRect();
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };

      const scaleX = ((rect.width - 84) / 2) * cameraRef.current.zoom;
      const scaleY = ((rect.height - 84) / 2) * cameraRef.current.zoom;

      cameraRef.current.targetPanX += dx / Math.max(scaleX, 1);
      cameraRef.current.targetPanY += dy / Math.max(scaleY, 1);
      return;
    }

    const hit = findNodeAtPosition(e.clientX, e.clientY);
    setHoveredNodeId(hit ? hit.id : null);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const moveDist = Math.hypot(
      e.clientX - lastMouseRef.current.x,
      e.clientY - lastMouseRef.current.y
    );
    isDraggingRef.current = false;

    if (moveDist < 4) {
      const hit = findNodeAtPosition(e.clientX, e.clientY);
      if (hit) {
        onSelectChunk(hit.id === highlightedChunkId ? null : hit.id);
      }
    }
  };

  const selectedNode = useMemo(
    () => points.find((p) => p.id === highlightedChunkId) || null,
    [points, highlightedChunkId]
  );

  const selectedMeta = useMemo(
    () => (selectedNode ? extractBreadcrumbAndBody(selectedNode.content) : null),
    [selectedNode]
  );

  return (
    <div className="relative flex flex-col h-full w-full rounded-xl bg-ink-950 border border-ink-700 overflow-hidden">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-ink-900/90 border-b border-ink-700 text-xs">
        <div className="flex items-center gap-2">
          <Compass className="w-4 h-4 text-amber-500" />
          <span className="font-semibold text-parchment">2D Semantic Chunk Map</span>
          <span className="text-[11px] text-ash/70">
            ({points.length} chunks • {activeSources.length} cited)
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => adjustZoom(0.35)}
            title="Zoom in"
            className="p-1 rounded hover:bg-ink-800 text-ash hover:text-parchment transition-colors"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => adjustZoom(-0.35)}
            title="Zoom out"
            className="p-1 rounded hover:bg-ink-800 text-ash hover:text-parchment transition-colors"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={resetCamera}
            title="Reset camera"
            className="p-1 rounded hover:bg-ink-800 text-ash hover:text-parchment transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Interactive Scatter Plot Canvas */}
      <div className="relative flex-1 min-h-[260px]">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            isDraggingRef.current = false;
            setHoveredNodeId(null);
          }}
          className={`w-full h-full block ${
            hoveredNodeId ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
          }`}
        />

        {/* Legend Pill */}
        <div className="absolute top-2.5 left-2.5 flex items-center gap-3 px-2.5 py-1 rounded-md bg-ink-900/85 backdrop-blur border border-ink-700 text-[10px] text-ash pointer-events-none">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-slate-500 inline-block" />
            Document Chunks
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-indigo-500 inline-block" />
            Retrieved [n]
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />
            Selected
          </span>
        </div>

        {/* Bottom HUD Inspector Card when a citation/node is highlighted */}
        {selectedNode && selectedMeta && (
          <div className="absolute inset-x-3 bottom-3 rounded-xl bg-ink-900/95 backdrop-blur-md border border-amber-500/40 shadow-xl p-3 text-xs animate-in fade-in slide-in-from-bottom-2 duration-150">
            <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-ink-700">
              <div className="flex items-center gap-1.5 min-w-0">
                {selectedNode.citationIndex && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-500 text-ink-950 font-bold text-[10px]">
                    [{selectedNode.citationIndex}]
                  </span>
                )}
                <FileText className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                <span className="font-semibold text-parchment truncate">
                  {selectedNode.document_name}
                </span>
                <span className="text-[10px] text-ash/60 font-mono flex-shrink-0">
                  • Chunk #{(selectedNode.chunk_index ?? 0) + 1}
                </span>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                {selectedNode.similarity !== undefined && selectedNode.similarity > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    <Sparkles className="w-2.5 h-2.5" />
                    {Math.round(
                      (selectedNode.similarity <= 1
                        ? selectedNode.similarity
                        : Math.min(selectedNode.similarity * 30, 0.99)) * 100
                    )}
                    %
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onSelectChunk(null)}
                  className="p-0.5 rounded hover:bg-ink-800 text-ash hover:text-parchment"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {selectedMeta.section && (
              <div className="mt-1.5 text-[11px] text-amber-300 font-medium truncate">
                Section: {selectedMeta.section}
              </div>
            )}

            <p className="mt-1 text-ash/90 line-clamp-3 leading-relaxed">
              {selectedMeta.body}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
