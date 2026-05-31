import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { loadTracesMap } from './tracesLoader';
import { buildGraph, CallRecord } from './tracer';

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

                const calls: CallRecord[] = [
                    {
                        id:        'backend/matching/views.py:ThreeWayMatchView.post',
                        label:     'ThreeWayMatchView.post',
                        file:      'backend/matching/views.py',
                        line:      341,
                        timestamp: Date.now(),
                    },
                    {
                        id:        'backend/purchasing/views/purchase_order.py:PurchaseOrderViewSet',
                        label:     'PurchaseOrderViewSet',
                        file:      'backend/purchasing/views/purchase_order.py',
                        line:      16,
                        timestamp: Date.now(),
                        parentId:  'backend/matching/views.py:ThreeWayMatchView.post',
                    },
                    {
                        id:        'backend/purchasing/views/goods_receipt.py:GoodsReceiptViewSet',
                        label:     'GoodsReceiptViewSet',
                        file:      'backend/purchasing/views/goods_receipt.py',
                        line:      13,
                        timestamp: Date.now(),
                        parentId:  'backend/matching/views.py:ThreeWayMatchView.post',
                    },
                    {
                        id:        'backend/inventory/print_views.py:print_label',
                        label:     'print_label',
                        file:      'backend/inventory/print_views.py',
                        line:      92,
                        timestamp: Date.now(),
                        parentId:  'backend/matching/views.py:ThreeWayMatchView.post',
                    },
                    {
                        id:        'backend/inventory/print_views.py:print_queue_pending',
                        label:     'print_queue_pending',
                        file:      'backend/inventory/print_views.py',
                        line:      152,
                        timestamp: Date.now(),
                        parentId:  'backend/inventory/print_views.py:print_label',
                    },
                ];

                const graph = buildGraph(calls, tracesMap);

                const data = {
                    nodes: graph.nodes.map(n => ({
                        id:    n.id,
                        label: n.label,
                        file:  n.file,
                        line:  n.line,
                        type:  'function',
                        trace: n.trace,
                    })),
                    edges: graph.edges,
                };

                panel.webview.postMessage({ command: 'loadDiagram', data });
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
    <h3>Three-Way Match Flow — Ewan Millar</h3>
    <svg id="diagram" xmlns="http://www.w3.org/2000/svg"></svg>
    <script src="${rendererUri}"></script>
</body>
</html>`;
}