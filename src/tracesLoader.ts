import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import * as fs from 'fs';

export interface TraceEntry {
  trace: string;
}

export type TracesMap = Map<string, string>; // "filepath:functionName" → description

interface TracesYml {
  functions?: Record<string, TraceEntry>;
}

const FALLBACK_PATHS = [
  '/home/websites/emillar_v2/traces.yml',
];

export async function loadTracesMap(): Promise<TracesMap> {
  const map: TracesMap = new Map();

  // Try workspace first
  const files = await vscode.workspace.findFiles('traces.yml', '**/node_modules/**', 1);
  const raw = files.length > 0
    ? Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString('utf8')
    : tryFallback();

  if (!raw) {
    console.log('[Spadework] No traces.yml found in workspace or fallback paths.');
    return map;
  }

  let parsed: TracesYml;
  try {
    parsed = yaml.load(raw) as TracesYml;
  } catch (err) {
    vscode.window.showWarningMessage(`[Spadework] Could not parse traces.yml: ${err}`);
    return map;
  }

  const functions = parsed?.functions ?? {};
  for (const [key, entry] of Object.entries(functions)) {
    if (entry?.trace) {
      map.set(key, entry.trace);
    }
  }

  console.log(`[Spadework] Loaded ${map.size} trace entries from traces.yml`);
  return map;
}

function tryFallback(): string | null {
  for (const p of FALLBACK_PATHS) {
    if (fs.existsSync(p)) {
      console.log(`[Spadework] Using fallback traces.yml at ${p}`);
      return fs.readFileSync(p, 'utf8');
    }
  }
  return null;
}