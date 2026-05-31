(function () {
    console.log('renderer.js loaded');

    const vscode = acquireVsCodeApi();

    vscode.postMessage({ command: 'ready' });

    // ── Diagram picker ────────────────────────────────────────────────────────

    const picker = document.getElementById('diagramPicker');
    picker.addEventListener('change', function () {
        const selected = picker.options[picker.selectedIndex];
        flipOverride = null;  // reset flip when switching diagrams
        vscode.postMessage({ command: 'loadDiagramFile', file: selected.dataset.file });
    });

    let flipOverride = null;  // null = use diagram default, 'horizontal' or 'vertical' = override
    let lastDiagram  = null;  // store last loaded diagram for re-render on flip

    const flipBtn = document.getElementById('flipBtn');
    flipBtn.addEventListener('click', function () {
        if (!lastDiagram) { return; }
        const current = flipOverride !== null ? flipOverride : (lastDiagram.layout || 'vertical');
        flipOverride  = current === 'horizontal' ? 'vertical' : 'horizontal';
        flipBtn.textContent = flipOverride === 'horizontal' ? '↕ Vertical' : '↔ Horizontal';
        clearSvg();
        renderDiagram(Object.assign({}, lastDiagram, { layout: flipOverride }));
    });

    // ── Message handler ───────────────────────────────────────────────────────

    window.addEventListener('message', function(event) {
        const message = event.data;
        if (message.command === 'loadManifest') { populatePicker(message.data); }
        if (message.command === 'loadDiagram')  {
            lastDiagram = message.data;
            flipOverride = null;
            flipBtn.textContent = (message.data.layout === 'horizontal') ? '↕ Vertical' : '↔ Horizontal';
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
        'position:fixed','background:#252526','border:1px solid #4a9eff',
        'border-radius:6px','padding:8px 12px','font-size:12px','color:#ccc',
        'max-width:280px','line-height:1.5','pointer-events:none','opacity:0',
        'transition:opacity 0.15s','z-index:999','box-shadow:0 4px 12px rgba(0,0,0,0.4)',
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
    function hideTooltip() { tooltip.style.opacity = '0'; }
    function escHtml(str) {
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Layout ────────────────────────────────────────────────────────────────
    // Assigns {x, y, col} to each node via BFS from root(s).
    // Decision nodes fan their children into separate columns.

    function computeLayout(data, NODE_W, ROW_H) {
        const COL_GAP = NODE_W + 40;
        const CENTRE_X = 300;

        // Build adjacency
        const children = {};  // id -> [{id, label}]
        const parents  = {};  // id -> count
        data.nodes.forEach(function(n) { children[n.id] = []; parents[n.id] = 0; });
        data.edges.forEach(function(e) {
            children[e.from].push({ id: e.to, label: e.label || '' });
            parents[e.to]++;
        });

        // Find roots (no parents)
        const roots = data.nodes.filter(function(n) { return parents[n.id] === 0; }).map(function(n){ return n.id; });

        const nodeMap = {};
        data.nodes.forEach(function(n) { nodeMap[n.id] = n; });

        const pos   = {};  // id -> {x, y}
        const depth = {};  // id -> row index
        const col   = {};  // id -> column offset (integer, 0 = centre)

        // BFS to assign depth and column
        const queue = [];
        roots.forEach(function(id) {
            depth[id] = 0;
            col[id]   = 0;
            queue.push(id);
        });

        const visited = new Set();
        while (queue.length) {
            const id = queue.shift();
            if (visited.has(id)) { continue; }
            visited.add(id);

            const ch = children[id];
            const node = nodeMap[id];

            if (ch.length >= 2) {
                // Fan children symmetrically around parent column
                const parentCol = col[id] || 0;
                const half = (ch.length - 1) / 2;
                ch.forEach(function(c, i) {
                    if (col[c.id] === undefined) {
                        col[c.id] = parentCol + (i - half);
                    }
                    if (depth[c.id] === undefined) {
                        depth[c.id] = (depth[id] || 0) + 1;
                    }
                    queue.push(c.id);
                });
            } else {
                ch.forEach(function(c) {
                    if (depth[c.id] === undefined) {
                        col[c.id]   = col[id] || 0;
                        depth[c.id] = (depth[id] || 0) + 1;
                    }
                    queue.push(c.id);
                });
            }
        }

        // Any unvisited nodes (disconnected) get stacked at the bottom
        let maxDepth = 0;
        data.nodes.forEach(function(n) {
            if (depth[n.id] !== undefined) { maxDepth = Math.max(maxDepth, depth[n.id]); }
        });
        data.nodes.forEach(function(n) {
            if (depth[n.id] === undefined) { depth[n.id] = ++maxDepth; col[n.id] = 0; }
        });

        // Convert depth+col to pixel positions
        const horizontal = data.layout === 'horizontal';
        const HORIZ_START_X = 100;  // left margin for horizontal diagrams
        const HORIZ_CENTRE_Y = 300; // vertical centre for horizontal diagrams
        data.nodes.forEach(function(n) {
            if (horizontal) {
                pos[n.id] = {
                    x: HORIZ_START_X + depth[n.id] * ROW_H,
                    y: HORIZ_CENTRE_Y + (col[n.id] || 0) * COL_GAP,
                };
            } else {
                pos[n.id] = {
                    x: CENTRE_X + (col[n.id] || 0) * COL_GAP,
                    y: 40 + depth[n.id] * ROW_H,
                };
            }
        });

        // Canvas size
        const allX = Object.values(pos).map(function(p){ return p.x; });
        const allY = Object.values(pos).map(function(p){ return p.y; });
        const minX = Math.min.apply(null, allX);
        const minY = Math.min.apply(null, allY);
        const maxX = Math.max.apply(null, allX);
        const maxY = Math.max.apply(null, allY);

        return {
            pos:        pos,
            horizontal: horizontal,
            width:      horizontal ? maxX + ROW_H        : Math.max(600, maxX - minX + NODE_W + 80),
            height:     horizontal ? Math.max(600, maxY - minY + NODE_W + 80) : maxY + ROW_H,
            minX:       minX,
            minY:       minY,
        };
    }

    // ── Renderer ──────────────────────────────────────────────────────────────

    function renderDiagram(data) {
        const SVG_NS    = 'http://www.w3.org/2000/svg';
        const horizontal = data.layout === 'horizontal';
        const NODE_W    = horizontal ? 160 : 180;
        const NODE_H    = horizontal ? 36  : 44;
        const ROW_H     = horizontal ? 180 : 100;
        const TRACE_RING = '#9b6dff';

        const COLOURS = {
            event:    { fill: '#1a3a5c', stroke: '#4a9eff' },
            function: { fill: '#2d5a2d', stroke: '#4aff6f' },
            decision: { fill: '#5a3a1a', stroke: '#ffaa4a' }
        };

        const layout = computeLayout(data, NODE_W, ROW_H);
        const positions = layout.pos;

        // Shift so nothing is clipped
        const shiftX = layout.minX < NODE_W / 2 + 20 ? (NODE_W / 2 + 20 - layout.minX) : 0;
        const shiftY = layout.horizontal && layout.minY < NODE_W / 2 + 20 ? (NODE_W / 2 + 20 - layout.minY) : 0;
        Object.keys(positions).forEach(function(id) {
            positions[id].x += shiftX;
            positions[id].y += shiftY;
        });

        const svgEl = document.getElementById('diagram');
        const totalW = layout.width  + shiftX;
        const totalH = layout.height + shiftY + (layout.horizontal ? 0 : 60);
        svgEl.setAttribute('viewBox', '0 0 ' + totalW + ' ' + totalH);
        svgEl.setAttribute('height', totalH);

        function el(tag, attrs) {
            attrs = attrs || {};
            const e = document.createElementNS(SVG_NS, tag);
            Object.keys(attrs).forEach(function(k) { e.setAttribute(k, attrs[k]); });
            return e;
        }

        // Arrow marker
        const defs = el('defs');
        const marker = el('marker', {
            id: 'arrow', markerWidth: '10', markerHeight: '7',
            refX: '10', refY: '3.5', orient: 'auto'
        });
        marker.appendChild(el('polygon', { points: '0 0, 10 3.5, 0 7', fill: '#888' }));
        defs.appendChild(marker);
        svgEl.appendChild(defs);

        // ── Edges ─────────────────────────────────────────────────────────────
        data.edges.forEach(function(edge) {
            const from = positions[edge.from];
            const to   = positions[edge.to];
            if (!from || !to) { return; }

            const x1 = horizontal ? from.x + NODE_W / 2 : from.x;
            const y1 = horizontal ? from.y               : from.y + NODE_H / 2;
            const x2 = horizontal ? to.x   - NODE_W / 2 : to.x;
            const y2 = horizontal ? to.y                 : to.y   - NODE_H / 2;

            let pathEl;
            if (x1 === x2) {
                // Straight vertical line
                pathEl = el('line', {
                    x1: x1, y1: y1, x2: x2, y2: y2,
                    stroke: '#555', 'stroke-width': '2', 'marker-end': 'url(#arrow)'
                });
            } else {
                // Bezier curve for diagonal connections
                const cy1 = y1 + (y2 - y1) * 0.4;
                const cy2 = y1 + (y2 - y1) * 0.6;
                pathEl = el('path', {
                    d: 'M'+x1+','+y1+' C'+x1+','+cy1+' '+x2+','+cy2+' '+x2+','+y2,
                    fill: 'none', stroke: '#555', 'stroke-width': '2', 'marker-end': 'url(#arrow)'
                });
            }
            svgEl.appendChild(pathEl);

            if (edge.label) {
                const mx = (x1 + x2) / 2;
                const my = (y1 + y2) / 2;
                const bg = el('rect', {
                    x: mx - 18, y: my - 10, width: 36, height: 18, rx: '3',
                    fill: '#1e1e1e', opacity: '0.85'
                });
                const t = el('text', {
                    x: mx, y: my + 1,
                    fill: '#ffaa4a', 'font-size': '11',
                    'text-anchor': 'middle', 'dominant-baseline': 'middle'
                });
                t.textContent = edge.label;
                svgEl.appendChild(bg);
                svgEl.appendChild(t);
            }
        });

        // ── Nodes ─────────────────────────────────────────────────────────────
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
                        x: cx-NODE_W/2-3, y: cy-NODE_H/2-3,
                        width: NODE_W+6, height: NODE_H+6,
                        rx: node.type === 'event' ? NODE_H/2+3 : '6',
                        fill: 'none', stroke: TRACE_RING, 'stroke-width': '1', opacity: '0.5'
                    }));
                }
            }

            // Node shape
            if (node.type === 'event') {
                g.appendChild(el('rect', {
                    x: cx-NODE_W/2, y: cy-NODE_H/2,
                    width: NODE_W, height: NODE_H, rx: NODE_H/2,
                    fill: col.fill, stroke: col.stroke, 'stroke-width': '2'
                }));
            } else if (node.type === 'decision') {
                const hw = NODE_W/2, hh = NODE_H/2+6;
                g.appendChild(el('polygon', {
                    points: cx+','+(cy-hh)+' '+(cx+hw)+','+cy+' '+cx+','+(cy+hh)+' '+(cx-hw)+','+cy,
                    fill: col.fill, stroke: col.stroke, 'stroke-width': '2'
                }));
            } else {
                g.appendChild(el('rect', {
                    x: cx-NODE_W/2, y: cy-NODE_H/2,
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
                    cx: cx+NODE_W/2-6, cy: cy-NODE_H/2+6,
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