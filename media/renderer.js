(function () {
    console.log('renderer.js loaded');

    const vscode = acquireVsCodeApi();

    vscode.postMessage({ command: 'ready' });

    // ── Diagram picker ────────────────────────────────────────────────────────

    const picker = document.getElementById('diagramPicker');
    picker.addEventListener('change', function () {
        const selected = picker.options[picker.selectedIndex];
        vscode.postMessage({ command: 'loadDiagramFile', file: selected.dataset.file });
    });

    // ── Message handler ───────────────────────────────────────────────────────

    window.addEventListener('message', function(event) {
        const message = event.data;
        console.log('message received:', message.command);

        if (message.command === 'loadManifest') {
            populatePicker(message.data);
        }

        if (message.command === 'loadDiagram') {
            clearSvg();
            renderDiagram(message.data);
        }
    });

    function populatePicker(manifest) {
        picker.innerHTML = '';
        manifest.diagrams.forEach(function(d) {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.title;
            opt.dataset.file = d.file;
            picker.appendChild(opt);
        });
    }

    function clearSvg() {
        const svgEl = document.getElementById('diagram');
        while (svgEl.firstChild) { svgEl.removeChild(svgEl.firstChild); }
    }

    // ── Tooltip ───────────────────────────────────────────────────────────────

    const tooltip = document.createElement('div');
    tooltip.style.cssText = [
        'position:fixed',
        'background:#252526',
        'border:1px solid #4a9eff',
        'border-radius:6px',
        'padding:8px 12px',
        'font-size:12px',
        'color:#ccc',
        'max-width:280px',
        'line-height:1.5',
        'pointer-events:none',
        'opacity:0',
        'transition:opacity 0.15s',
        'z-index:999',
        'box-shadow:0 4px 12px rgba(0,0,0,0.4)',
    ].join(';');
    document.body.appendChild(tooltip);

    function showTooltip(e, node) {
        if (!node.trace) { return; }
        tooltip.innerHTML =
            '<div style="color:#4a9eff;font-weight:600;margin-bottom:4px">' + escHtml(node.label.replace(/\n/g, ' ')) + '</div>' +
            '<div>' + escHtml(node.trace) + '</div>' +
            '<div style="margin-top:6px;color:#666;font-size:11px">' + escHtml(node.file) + ':' + node.line + '</div>';
        tooltip.style.opacity = '1';
        moveTooltip(e);
    }

    function moveTooltip(e) {
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top  = (e.clientY - 10) + 'px';
    }

    function hideTooltip() {
        tooltip.style.opacity = '0';
    }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Renderer ──────────────────────────────────────────────────────────────

    function renderDiagram(data) {
        console.log('renderDiagram called', data.title);

        const SVG_NS = 'http://www.w3.org/2000/svg';
        const NODE_W = 180;
        const NODE_H = 44;
        const COL_X  = 300;
        const ROW_H  = 100;
        const TRACE_RING = '#9b6dff';

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
            Object.keys(attrs).forEach(function(k) { e.setAttribute(k, attrs[k]); });
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

        // Edges
        data.edges.forEach(function(edge) {
            const from = positions[edge.from];
            const to   = positions[edge.to];
            if (!from || !to) { return; }

            svgEl.appendChild(el('line', {
                x1: from.x, y1: from.y + NODE_H / 2,
                x2: to.x,   y2: to.y   - NODE_H / 2,
                stroke: '#555', 'stroke-width': '2',
                'marker-end': 'url(#arrow)'
            }));

            if (edge.label) {
                const t = el('text', {
                    x: (from.x + to.x) / 2 + 8,
                    y: (from.y + NODE_H / 2 + to.y - NODE_H / 2) / 2,
                    fill: '#aaa', 'font-size': '11', 'dominant-baseline': 'middle'
                });
                t.textContent = edge.label;
                svgEl.appendChild(t);
            }
        });

        // Nodes
        data.nodes.forEach(function(node) {
            const pos = positions[node.id];
            const cx  = pos.x;
            const cy  = pos.y;
            const col = COLOURS[node.type] || COLOURS.function;
            const hasTrace = !!node.trace;

            const g = el('g');
            g.style.cursor = 'pointer';

            g.addEventListener('click', function() {
                vscode.postMessage({ command: 'openFile', file: node.file, line: node.line });
            });
            g.addEventListener('mouseenter', function(e) { showTooltip(e, node); });
            g.addEventListener('mousemove',  function(e) { moveTooltip(e); });
            g.addEventListener('mouseleave', hideTooltip);

            // Trace ring
            if (hasTrace) {
                if (node.type === 'decision') {
                    const hw = NODE_W / 2 + 4, hh = NODE_H / 2 + 10;
                    g.appendChild(el('polygon', {
                        points: cx+','+(cy-hh)+' '+(cx+hw)+','+cy+' '+cx+','+(cy+hh)+' '+(cx-hw)+','+cy,
                        fill: 'none', stroke: TRACE_RING, 'stroke-width': '1', opacity: '0.5'
                    }));
                } else {
                    g.appendChild(el('rect', {
                        x: cx - NODE_W / 2 - 3, y: cy - NODE_H / 2 - 3,
                        width: NODE_W + 6, height: NODE_H + 6,
                        rx: node.type === 'event' ? NODE_H / 2 + 3 : '6',
                        fill: 'none', stroke: TRACE_RING, 'stroke-width': '1', opacity: '0.5'
                    }));
                }
            }

            // Node shape
            if (node.type === 'event') {
                g.appendChild(el('rect', {
                    x: cx - NODE_W / 2, y: cy - NODE_H / 2,
                    width: NODE_W, height: NODE_H, rx: NODE_H / 2,
                    fill: col.fill, stroke: col.stroke, 'stroke-width': '2'
                }));
            } else if (node.type === 'decision') {
                const hw = NODE_W / 2, hh = NODE_H / 2 + 6;
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

            // Label
            const lines  = node.label.split('\n');
            const lineH  = 14;
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

            // Trace dot
            if (hasTrace) {
                g.appendChild(el('circle', {
                    cx: cx + NODE_W / 2 - 6, cy: cy - NODE_H / 2 + 6,
                    r: '4', fill: TRACE_RING
                }));
            }

            const title = el('title');
            title.textContent = node.file + ':' + node.line;
            g.appendChild(title);

            svgEl.appendChild(g);
        });
    }

}());