import { TracesMap } from './tracesLoader';

export interface TraceNode {
  id: string;           // unique — e.g. "matching/views.py:MatchingRequestViewSet.get"
  label: string;        // short display name — e.g. "MatchingRequestViewSet.get"
  file: string;         // relative path — e.g. "backend/matching/views.py"
  line: number;         // 1-indexed, for openFile navigation
  duration?: number;    // ms — optional, used for heat colouring in the renderer
  trace?: string;       // intent description loaded from traces.yml
  timestamp: number;    // Date.now() at call time
}

export interface TraceEdge {
  from: string;         // TraceNode.id
  to: string;           // TraceNode.id
}

export interface TraceGraph {
  nodes: TraceNode[];
  edges: TraceEdge[];
}

// ─── Raw call record (what you feed in) ──────────────────────────────────────

export interface CallRecord {
  id: string;
  label: string;
  file: string;
  line: number;
  duration?: number;
  timestamp: number;
  parentId?: string;    // if present, an edge from → to is created
}

// ─── Graph builder ────────────────────────────────────────────────────────────

export function buildGraph(calls: CallRecord[], tracesMap: TracesMap): TraceGraph {
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  const seen = new Set<string>();

  for (const call of calls) {
    if (!seen.has(call.id)) {
      nodes.push({
        id:        call.id,
        label:     call.label,
        file:      call.file,
        line:      call.line,
        duration:  call.duration,
        trace:     tracesMap.get(call.id),   // undefined if not in traces.yml — that's fine
        timestamp: call.timestamp,
      });
      seen.add(call.id);
    }

    if (call.parentId) {
      edges.push({ from: call.parentId, to: call.id });
    }
  }

  return { nodes, edges };
}