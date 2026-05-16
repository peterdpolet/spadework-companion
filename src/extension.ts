import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Spadework Companion active');

    const disposable = vscode.commands.registerCommand('spadework.openDiagram', () => {
        const panel = vscode.window.createWebviewPanel(
            'spadeworkDiagram',
            'Spadework Diagram',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.webview.html = getDiagramHtml();

        // Handle node clicks from the webview
        panel.webview.onDidReceiveMessage(async (message) => {
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

function getDiagramHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <style>
        body { background: #1e1e1e; color: #ccc; font-family: sans-serif; padding: 20px; }
        svg { width: 100%; height: 500px; }
        .node { cursor: pointer; }
        .node rect { fill: #2d5a8e; stroke: #4a9eff; stroke-width: 2; rx: 6; }
        .node:hover rect { fill: #3a6fa8; }
        .node text { fill: #fff; font-size: 13px; text-anchor: middle; dominant-baseline: middle; }
        .arrow { stroke: #4a9eff; stroke-width: 2; fill: none; marker-end: url(#arrowhead); }
        .label { fill: #aaa; font-size: 11px; }
    </style>
</head>
<body>
    <h3 style="color:#4a9eff">JWT Refresh Flow — Ewan Millar</h3>
    <svg viewBox="0 0 600 480" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7"
                refX="10" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="#4a9eff" />
            </marker>
        </defs>

        <!-- Node 1: API Request -->
        <g class="node" onclick="openFile('frontend/src/api/axios.js', 1)">
            <rect x="200" y="20" width="200" height="44" rx="6"/>
            <text x="300" y="42">Axios API Request</text>
        </g>

        <!-- Node 2: 401 Interceptor -->
        <g class="node" onclick="openFile('frontend/src/api/axios.js', 25)">
            <rect x="200" y="120" width="200" height="44" rx="6"/>
            <text x="300" y="142">401 Interceptor Fires</text>
        </g>

        <!-- Node 3: Refresh Token -->
        <g class="node" onclick="openFile('frontend/src/api/axios.js', 47)">
            <rect x="200" y="220" width="200" height="44" rx="6"/>
            <text x="300" y="242">POST /auth/token/refresh</text>
        </g>

        <!-- Node 4: Retry -->
        <g class="node" onclick="openFile('frontend/src/api/axios.js', 60)">
            <rect x="200" y="320" width="200" height="44" rx="6"/>
            <text x="300" y="342">Retry Original Request</text>
        </g>

        <!-- Node 5: Response -->
        <g class="node" onclick="openFile('frontend/src/stores/useAuthStore.js', 12)">
            <rect x="200" y="420" width="200" height="44" rx="6"/>
            <text x="300" y="442">Return to Component</text>
        </g>

        <!-- Arrows -->
        <line x1="300" y1="64" x2="300" y2="118" class="arrow"/>
        <line x1="300" y1="164" x2="300" y2="218" class="arrow"/>
        <line x1="300" y1="264" x2="300" y2="318" class="arrow"/>
        <line x1="300" y1="364" x2="300" y2="418" class="arrow"/>
    </svg>

    <script>
        const vscode = acquireVsCodeApi();
        function openFile(file, line) {
            vscode.postMessage({ command: 'openFile', file, line });
        }
    </script>
</body>
</html>`;
}
