import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Types — mirror the EpcNode shape from epc_tracer.py
// ---------------------------------------------------------------------------
interface EntryPoint {
  type: string;   // @click | onMounted | watch | pinia_action | django_view | signal
  name: string;
  line: number;
}

interface EpcMeta {
  entry: string;
  root: string;
  depth_limit: number;
  files_traced: number;
}

interface EpcData {
  meta: EpcMeta;
  tree: EpcNode;
}

interface EpcNode {
  id: string;
  label: string;
  description: string;
  type: string;
  language: string;
  file: string;
  line: number;
  boundary: boolean;
  source_snippet: string[];
  children: EpcNode[];
  warning: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getScriptsDir(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'scripts');
}

function getMediaDir(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'media');
}

function getOutputDir(workspaceRoot: string): string {
  const dir = path.join(workspaceRoot, '.spadework');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Relative path from workspace root, forward slashes */
function relPath(workspaceRoot: string, absPath: string): string {
  return path.relative(workspaceRoot, absPath).replace(/\\/g, '/');
}

/** Badge label shown in the quick-pick */
function typeLabel(type: string): string {
  const map: Record<string, string> = {
    '@click':       '$(play)   @click',
    'onMounted':    '$(clock)  onMounted',
    'watch':        '$(eye)    watch',
    'pinia_action': '$(database) Pinia action',
    'django_view':  '$(server) Django view',
    'signal':       '$(bell)   signal',
    'view_fn':      '$(server) view fn',
  };
  return map[type] ?? `$(symbol-function) ${type}`;
}

// ---------------------------------------------------------------------------
// Step 1: detect entry points in the active file
// ---------------------------------------------------------------------------

async function detectEntryPoints(
  filePath: string,
  tracerScript: string,
  workspaceRoot: string
): Promise<EntryPoint[]> {
  return new Promise((resolve) => {
    const args = ['--list', relPath(workspaceRoot, filePath), '--root', workspaceRoot];
    const proc = spawn('python3', [tracerScript, ...args], { cwd: workspaceRoot });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 || !stdout.trim()) {
        // Fall back to python if python3 not found
        const proc2 = spawn('python', [tracerScript, ...args], { cwd: workspaceRoot });
        let out2 = '';
        proc2.stdout.on('data', (d: Buffer) => { out2 += d.toString(); });
        proc2.on('close', () => {
          try { resolve(JSON.parse(out2)); } catch { resolve([]); }
        });
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
    });
  });
}

// ---------------------------------------------------------------------------
// Step 2: show picker — pre-select the entry point nearest the cursor
// ---------------------------------------------------------------------------

async function pickEntryPoint(
  entries: EntryPoint[],
  cursorLine: number,
  fileName: string
): Promise<EntryPoint | undefined> {
  if (entries.length === 0) {
    vscode.window.showWarningMessage(
      `Spadework: no entry points detected in ${path.basename(fileName)}. ` +
      `Try placing your cursor inside a function and running the command again.`
    );
    return undefined;
  }

  // Find the entry closest to (and not after) the cursor
  const closest = entries.reduce((best, curr) => {
    const currDist = Math.abs(curr.line - cursorLine);
    const bestDist = Math.abs(best.line - cursorLine);
    return currDist < bestDist ? curr : best;
  }, entries[0]);

  type EntryItem = vscode.QuickPickItem & { entry: EntryPoint };

  const items: EntryItem[] = entries.map(e => ({
    label: typeLabel(e.type),
    description: e.name,
    detail: `line ${e.line}`,
    entry: e,
    // Pre-select the closest one
    picked: e === closest,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `Trace EPC — ${path.basename(fileName)}`,
    placeHolder: 'Select entry point to trace from',
    matchOnDescription: true,
    matchOnDetail: false,
  });

  return picked?.entry;
}

// ---------------------------------------------------------------------------
// Step 3: run the tracer
// ---------------------------------------------------------------------------

async function runTracer(
  tracerScript: string,
  workspaceRoot: string,
  relativeFilePath: string,
  funcName: string,
  outputPath: string,
  depth: number = 10
): Promise<EpcData> {
  return new Promise((resolve, reject) => {
    const entry = `${relativeFilePath}::${funcName}`;
    const args = [
      tracerScript,
      '--entry', entry,
      '--root', workspaceRoot,
      '--output', outputPath,
      '--depth', String(depth),
    ];

    const trySpawn = (cmd: string) => {
      const proc = spawn(cmd, args, { cwd: workspaceRoot });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          if (cmd === 'python3') {
            // Retry with python
            trySpawn('python');
          } else {
            reject(new Error(`Tracer exited ${code}:\n${stderr}`));
          }
          return;
        }
        try {
          const data = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
          resolve(data as EpcData);
        } catch (e) {
          reject(new Error(`Could not parse tracer output: ${e}`));
        }
      });
    };

    trySpawn('python3');
  });
}

// ---------------------------------------------------------------------------
// Step 4: open / update the webview panel
// ---------------------------------------------------------------------------

let _panel: vscode.WebviewPanel | undefined;

function openEpcViewer(
  context: vscode.ExtensionContext,
  epcData: EpcData,
  title: string
): void {
  const mediaDir = getMediaDir(context);
  const viewerPath = path.join(mediaDir, 'epc_viewer.html');

  if (!fs.existsSync(viewerPath)) {
    vscode.window.showErrorMessage(
      'Spadework: epc_viewer.html not found in media/. Please check your installation.'
    );
    return;
  }

  if (_panel) {
    // Reuse existing panel
    _panel.title = title;
    _panel.reveal(vscode.ViewColumn.Beside);
  } else {
    _panel = vscode.window.createWebviewPanel(
      'spadeworkEpc',
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(mediaDir)],
        retainContextWhenHidden: true,
      }
    );

    _panel.onDidDispose(() => { _panel = undefined; }, null, context.subscriptions);
  }

  // Load HTML and patch resource URIs for the webview sandbox
  let html = fs.readFileSync(viewerPath, 'utf-8');

  // Replace any local resource references (future-proofing)
  const mediaUri = _panel.webview.asWebviewUri(vscode.Uri.file(mediaDir));
  html = html.replace(/src="([^"]+)"/g, (match, src) => {
    if (src.startsWith('http')) return match;
    return `src="${mediaUri}/${src}"`;
  });

  _panel.webview.html = html;

  // Post the data once the webview is ready
  // Small delay ensures the webview JS has registered its message listener
  setTimeout(() => {
    _panel?.webview.postMessage({ type: 'epc_data', payload: epcData });
  }, 400);

  // Handle messages back from the webview (e.g. "jump to file:line")
  _panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.type === 'open_file' && message.file && message.line) {
        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) return;
        const absPath = path.join(workspaceRoot, message.file);
        if (!fs.existsSync(absPath)) return;
        const doc = await vscode.workspace.openTextDocument(absPath);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const targetLine = Math.max(0, (message.line as number) - 1);
        const range = new vscode.Range(targetLine, 0, targetLine, 0);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    },
    undefined,
    context.subscriptions
  );
}

// ---------------------------------------------------------------------------
// Main command export
// ---------------------------------------------------------------------------

export async function traceEpcCommand(context: vscode.ExtensionContext): Promise<void> {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Spadework: no workspace folder open.');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Spadework: open a Vue, TypeScript, or Python file first.');
    return;
  }

  const filePath = editor.document.uri.fsPath;
  const ext = path.extname(filePath).toLowerCase();
  if (!['.vue', '.ts', '.js', '.py'].includes(ext)) {
    vscode.window.showErrorMessage(
      `Spadework: EPC tracing supports .vue, .ts, .js, and .py files (got ${ext}).`
    );
    return;
  }

  const cursorLine = editor.selection.active.line + 1; // 1-indexed
  const tracerScript = path.join(getScriptsDir(context), 'epc_tracer.py');

  if (!fs.existsSync(tracerScript)) {
    vscode.window.showErrorMessage(
      'Spadework: epc_tracer.py not found in scripts/. Please check your installation.'
    );
    return;
  }

  // --- Detect entry points ---
  const entries = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Spadework: scanning entry points…' },
    () => detectEntryPoints(filePath, tracerScript, workspaceRoot)
  );

  // --- Picker ---
  const chosen = await pickEntryPoint(entries, cursorLine, filePath);
  if (!chosen) return;

  // --- Run tracer ---
  const safeName = chosen.name.replace(/[^\w]/g, '_');
  const outputDir = getOutputDir(workspaceRoot);
  const outputPath = path.join(outputDir, `epc_${safeName}.json`);
  const relFile = relPath(workspaceRoot, filePath);

  let epcData: EpcData;
  try {
    epcData = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Spadework: tracing ${chosen.name}…`,
        cancellable: false,
      },
      () => runTracer(tracerScript, workspaceRoot, relFile, chosen.name, outputPath)
    );
  } catch (err) {
    vscode.window.showErrorMessage(`Spadework EPC trace failed: ${err}`);
    return;
  }

  // --- Open viewer ---
  const title = `EPC — ${chosen.name}`;
  openEpcViewer(context, epcData, title);

  // Offer to reveal the JSON file
  const reveal = await vscode.window.showInformationMessage(
    `EPC trace complete — ${countNodes(epcData.tree)} nodes across ${epcData.meta.files_traced} files.`,
    'Reveal JSON'
  );
  if (reveal === 'Reveal JSON') {
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputPath));
  }
}

function countNodes(node: EpcNode): number {
  return 1 + (node.children || []).reduce((sum, c) => sum + countNodes(c), 0);
}