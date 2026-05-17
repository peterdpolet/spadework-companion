import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    console.log('Spadework Companion active');

    const disposable = vscode.commands.registerCommand('spadework.openDiagram', () => {
        const panel = vscode.window.createWebviewPanel(
            'spadeworkDiagram',
            'Spadework Diagram',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = getDiagramHtml(context, panel);

        // Single handler for ALL messages from the webview
        panel.webview.onDidReceiveMessage(async (message) => {

            if (message.command === 'ready') {
                const diagramPath = path.join(context.extensionPath, 'diagrams', 'jwt-refresh.json');
                const diagramJson = fs.readFileSync(diagramPath, 'utf8');
                panel.webview.postMessage({ command: 'loadDiagram', data: JSON.parse(diagramJson) });
            }

            if (message.command === 'openFile') {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
                if (!workspaceRoot) return;

                const filePath = path.join(workspaceRoot, message.file);
                const uri = vscode.Uri.file(filePath);
                const doc = await vscode.workspace.openTextDocument(uri);
                const line = message.line - 1; // VSCode is 0-indexed
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
        h3 { color: #4a9eff; margin-bottom: 12px; }
        svg { width: 100%; }
    </style>
</head>
<body>
    <h3>JWT Refresh Flow — Ewan Millar</h3>
    <svg id="diagram" xmlns="http://www.w3.org/2000/svg"></svg>
    <script src="${rendererUri}"></script>
</body>
</html>`;
}