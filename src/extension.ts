import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadTracesMap, TracesMap } from './tracesLoader';

export async function activate(context: vscode.ExtensionContext) {

    const tracesMap = await loadTracesMap();

    console.log('Spadework Companion active');

    const disposable = vscode.commands.registerCommand('spadework.openDiagram', () => {
        const panel = vscode.window.createWebviewPanel(
            'spadeworkDiagram',
            'Spadework Diagram',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = getDiagramHtml(context, panel);

        panel.webview.onDidReceiveMessage(async (message) => {

            if (message.command === 'ready') {
                const manifestPath = path.join(context.extensionPath, 'diagrams', 'manifest.json');
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                panel.webview.postMessage({ command: 'loadManifest', data: manifest });

                // Pre-load all diagrams so the home screen can show node counts
                manifest.diagrams.forEach((entry: { file: string; id: string }) => {
                    const diagramPath = path.join(context.extensionPath, 'diagrams', entry.file);
                    if (fs.existsSync(diagramPath)) {
                        const diagram = JSON.parse(fs.readFileSync(diagramPath, 'utf8'));
                        const annotated = {
                            ...diagram,
                            nodes: diagram.nodes.map((n: any) => ({
                                ...n,
                                trace: tracesMap.get(n.id) || n.trace || null,
                            })),
                        };
                        panel.webview.postMessage({ command: 'loadDiagram', data: annotated });
                    }
                });
            }

            if (message.command === 'loadDiagramFile') {
                sendDiagram(panel, context, message.file, tracesMap);
            }

            if (message.command === 'openFile') {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath
                    ?? '/home/websites/emillar_v2';

                const filePath = path.join(workspaceRoot, message.file);
                const uri = vscode.Uri.file(filePath);
                const doc = await vscode.workspace.openTextDocument(uri);
                const line = message.line - 1;
                const range = new vscode.Range(line, 0, line, 0);

                await vscode.window.showTextDocument(doc, {
                    viewColumn: vscode.ViewColumn.One,
                    selection: range
                });
            }
        });
    });

    context.subscriptions.push(disposable);
}

function sendDiagram(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    file: string,
    tracesMap: TracesMap
) {
    const diagramPath = path.join(context.extensionPath, 'diagrams', file);
    const diagram = JSON.parse(fs.readFileSync(diagramPath, 'utf8'));

    const annotated = {
        ...diagram,
        nodes: diagram.nodes.map((n: any) => ({
            ...n,
            trace: tracesMap.get(n.id) || n.trace || null,
        })),
    };

    panel.webview.postMessage({ command: 'loadDiagram', data: annotated });
}

export function deactivate() {}


function getDiagramHtml(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): string {
    const rendererUri = panel.webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, 'media', 'renderer.js')
    );

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}; style-src 'unsafe-inline';">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #1e1e1e; color: #ccc; font-family: sans-serif; padding: 12px; }

        #search {
            width: 100%; padding: 6px 10px; margin-bottom: 12px;
            background: #2d2d2d; border: 1px solid #555; border-radius: 4px;
            color: #ccc; font-size: 13px;
        }
        #search:focus { outline: 1px solid #4a9eff; }

        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }

        .card {
            background: #252526; border: 1px solid #333; border-radius: 6px;
            padding: 12px; cursor: pointer; transition: border-color 0.15s;
        }
        .card:hover { border-color: #4a9eff; }
        .card-title { color: #4a9eff; font-weight: 600; font-size: 13px; margin-bottom: 4px; }
        .card-meta  { color: #666; font-size: 11px; margin-bottom: 6px; }

        .chip {
            display: inline-block; background: #1a3a5c; border: 1px solid #4a9eff;
            border-radius: 10px; padding: 2px 8px; font-size: 11px; color: #4a9eff;
            margin: 2px; cursor: pointer;
        }
        .chip:hover { background: #4a9eff; color: #fff; }
        .method-chip { background: #2d5a2d; border-color: #4aff6f; color: #4aff6f; }
        .method-chip:hover { background: #4aff6f; color: #000; }
        .has-trace { border-style: solid; border-width: 2px; }

        .breadcrumb { margin-bottom: 12px; font-size: 12px; color: #666; }
        .breadcrumb a { color: #4a9eff; text-decoration: none; }
        .breadcrumb a:hover { text-decoration: underline; }
        .bc-current { color: #ccc; }

        .class-header { background: #252526; border: 1px solid #4a9eff; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
        .class-name  { color: #4a9eff; font-size: 16px; font-weight: 600; margin-bottom: 4px; }
        .class-file  { color: #666; font-size: 11px; cursor: pointer; margin-bottom: 6px; }
        .class-file:hover { color: #4a9eff; }
        .class-trace { color: #aaa; font-size: 12px; font-style: italic; }

        .method-list { margin-bottom: 16px; }
        .method-row  {
            display: grid; grid-template-columns: 160px 1fr 1fr;
            gap: 8px; padding: 8px 10px; border-bottom: 1px solid #2d2d2d;
            cursor: pointer; font-size: 12px; align-items: center;
        }
        .method-row:hover { background: #252526; }
        .method-name  { color: #4aff6f; font-weight: 600; }
        .method-file  { color: #555; font-size: 11px; }
        .method-trace { color: #999; font-style: italic; }

        .svg-wrap { margin-top: 8px; overflow-x: auto; }
    </style>
</head>
<body>
    <div id="app"><p style="color:#666;padding:20px">Loading…</p></div>
    <script src="${rendererUri}"></script>
</body>
</html>`;
}