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
                // Send manifest so webview can populate the dropdown
                const manifestPath = path.join(context.extensionPath, 'diagrams', 'manifest.json');
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                panel.webview.postMessage({ command: 'loadManifest', data: manifest });

                // Load the first diagram by default
                const firstFile = manifest.diagrams[0]?.file;
                if (firstFile) {
                    sendDiagram(panel, context, firstFile, tracesMap);
                }
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

    // Annotate nodes with trace descriptions from tracesMap
    const annotated = {
        ...diagram,
        nodes: diagram.nodes.map((n: any) => ({
            ...n,
            trace: tracesMap.get(n.id),
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
        body { background: #1e1e1e; color: #ccc; font-family: sans-serif; margin: 0; padding: 16px; }
        h3 { color: #4a9eff; margin-bottom: 8px; }
        svg { width: 100%; }
        select {
            background: #2d2d2d;
            color: #ccc;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 13px;
            margin-bottom: 12px;
            cursor: pointer;
        }
        select:focus { outline: 1px solid #4a9eff; }
    </style>
</head>
<body>
    <h3>Spadework Companion</h3>
    <select id="diagramPicker"></select>
    <svg id="diagram" xmlns="http://www.w3.org/2000/svg"></svg>
    <script src="${rendererUri}"></script>
</body>
</html>`;
}