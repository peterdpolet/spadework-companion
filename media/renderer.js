(function () {
    console.log('renderer.js loaded');

    const vscode = acquireVsCodeApi();

    vscode.postMessage({ command: 'ready' });

    window.addEventListener('message', function(event) {
        const message = event.data;
        console.log('message received:', message.command);
        if (message.command === 'loadDiagram') {
            renderDiagram(message.data);
        }
    });

    function renderDiagram(data) {
        console.log('renderDiagram called');

        const SVG_NS = 'http://www.w3.org/2000/svg';
        const NODE_W = 180;
        const NODE_H = 44;
        const COL_X = 300;
        const ROW_H = 100;

        const COLOURS = {
            event:    { fill: '#1a3a5c', stroke: '#4a9eff' },
            function: { fill: '#2d5a2d', stroke: '#4aff6f' },
            decision: { fill: '#5a3a1a', stroke: '#ffaa4a' }
        };

        const positions = {};
        data.nodes.forEach(function(node, i) {
            positions[node.id] = { x: COL_X, y: 40 + i * ROW_H };
        });

        const svgEl = document.getElementById('diagram');
        const totalH = data.nodes.length * ROW_H + 60;
        svgEl.setAttribute('viewBox', '0 0 600 ' + totalH);
        svgEl.setAttribute('height', totalH);

        function el(tag, attrs) {
            attrs = attrs || {};
            const e = document.createElementNS(SVG_NS, tag);
            Object.keys(attrs).forEach(function(k) {
                e.setAttribute(k, attrs[k]);
            });
            return e;
        }

        const defs = el('defs');
        const marker = el('marker', {
            id: 'arrow', markerWidth: '10', markerHeight: '7',
            refX: '10', refY: '3.5', orient: 'auto'
        });
        marker.appendChild(el('polygon', { points: '0 0, 10 3.5, 0 7', fill: '#888' }));
        defs.appendChild(marker);
        svgEl.appendChild(defs);

        data.edges.forEach(function(edge) {
            const from = positions[edge.from];
            const to = positions[edge.to];
            if (!from || !to) { return; }

            const line = el('line', {
                x1: from.x, y1: from.y + NODE_H / 2,
                x2: to.x,   y2: to.y - NODE_H / 2,
                stroke: '#555', 'stroke-width': '2',
                'marker-end': 'url(#arrow)'
            });
            svgEl.appendChild(line);

            if (edge.label) {
                const t = el('text', {
                    x: (from.x + to.x) / 2 + 8,
                    y: (from.y + NODE_H / 2 + to.y - NODE_H / 2) / 2,
                    fill: '#aaa', 'font-size': '11',
                    'dominant-baseline': 'middle'
                });
                t.textContent = edge.label;
                svgEl.appendChild(t);
            }
        });

        data.nodes.forEach(function(node) {
            const pos = positions[node.id];
            const cx = pos.x;
            const cy = pos.y;
            const col = COLOURS[node.type] || COLOURS.function;

            const g = el('g');
            g.style.cursor = 'pointer';
            g.addEventListener('click', function() {
                vscode.postMessage({ command: 'openFile', file: node.file, line: node.line });
            });

            if (node.type === 'event') {
                g.appendChild(el('rect', {
                    x: cx - NODE_W / 2, y: cy - NODE_H / 2,
                    width: NODE_W, height: NODE_H,
                    rx: NODE_H / 2,
                    fill: col.fill, stroke: col.stroke, 'stroke-width': '2'
                }));
            } else if (node.type === 'decision') {
                const hw = NODE_W / 2;
                const hh = NODE_H / 2 + 6;
                g.appendChild(el('polygon', {
                    points: cx+','+(cy-hh)+' '+(cx+hw)+','+cy+' '+cx+','+(cy+hh)+' '+(cx-hw)+','+cy,
                    fill: col.fill, stroke: col.stroke, 'stroke-width': '2'
                }));
            } else {
                g.appendChild(el('rect', {
                    x: cx - NODE_W / 2, y: cy - NODE_H / 2,
                    width: NODE_W, height: NODE_H, rx: '4',
                    fill: col.fill, stroke: col.stroke, 'stroke-width': '2'
                }));
            }

            const lines = node.label.split('\n');
            const lineH = 14;
            const startY = cy - ((lines.length - 1) * lineH) / 2;
            lines.forEach(function(lineText, i) {
                const t = el('text', {
                    x: cx, y: startY + i * lineH,
                    fill: '#fff', 'font-size': '12',
                    'text-anchor': 'middle', 'dominant-baseline': 'middle'
                });
                t.textContent = lineText;
                g.appendChild(t);
            });

            const title = el('title');
            title.textContent = node.file + ':' + node.line;
            g.appendChild(title);

            svgEl.appendChild(g);
        });
    }

}());
