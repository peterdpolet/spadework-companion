(function () {
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ command: 'ready' });

    // ── State ─────────────────────────────────────────────────────────────────
    let allDiagrams = {};   // id -> diagram data
    let manifest    = null;
    let view        = 'home';   // 'home' | 'diagram' | 'class'
    let currentDiagram = null;
    let currentClass   = null;

    // ── Message handler ───────────────────────────────────────────────────────
    window.addEventListener('message', function(event) {
        const msg = event.data;
        if (msg.command === 'loadManifest') {
            manifest = msg.data;
            renderHome();
        }
        if (msg.command === 'loadDiagram') {
            allDiagrams[msg.data.id] = msg.data;
            if (view === 'home') { renderHome(); }
        }
        if (msg.command === 'loadAllDiagrams') {
            msg.data.forEach(function(d) { allDiagrams[d.id] = d; });
            renderHome();
        }
    });

    // ── Router ────────────────────────────────────────────────────────────────
    function navigate(newView, diagram, cls) {
        view           = newView;
        currentDiagram = diagram || null;
        currentClass   = cls    || null;
        render();
    }

    function render() {
        if (view === 'home')    { renderHome(); }
        if (view === 'diagram') { renderDiagram(); }
        if (view === 'class')   { renderClass(); }
    }

    // ── Home — diagram cards ──────────────────────────────────────────────────
    function renderHome() {
        if (!manifest) { return; }
        const app = document.getElementById('app');
        app.innerHTML = '';

        const search = el('input', { type:'text', placeholder:'Search diagrams...', id:'search' });
        search.addEventListener('input', function() { renderHome(); });
        app.appendChild(search);

        const grid = el('div', {}, 'grid');
        const q = (document.getElementById('search') || search).value.toLowerCase();

        manifest.diagrams.forEach(function(entry) {
            const data = allDiagrams[entry.id];
            if (q && !entry.title.toLowerCase().includes(q)) { return; }

            const card = el('div', {}, 'card');
            card.innerHTML =
                '<div class="card-title">' + esc(entry.title) + '</div>' +
                '<div class="card-meta">' + (data ? data.nodes.length + ' nodes' : 'loading…') + '</div>';

            if (data) {
                // Show class list for auto diagrams
                const isAuto = data.id && data.id.startsWith('auto-');
                if (isAuto) {
                    const classes = data.nodes.filter(function(n) { return n.type === 'event'; });
                    classes.forEach(function(cls) {
                        const chip = el('div', {}, 'chip');
                        chip.textContent = cls.label;
                        chip.addEventListener('click', function(e) {
                            e.stopPropagation();
                            navigate('class', data, cls);
                        });
                        card.appendChild(chip);
                    });
                }
            }

            card.addEventListener('click', function() {
                if (data) { navigate('diagram', data, null); }
                else {
                    vscode.postMessage({ command: 'loadDiagramFile', file: entry.file });
                    // Wait for loadDiagram message, then navigate
                    const waiter = function(event) {
                        if (event.data.command === 'loadDiagram' && event.data.data.id === entry.id) {
                            window.removeEventListener('message', waiter);
                            navigate('diagram', event.data.data, null);
                        }
                    };
                    window.addEventListener('message', waiter);
                }
            });
            grid.appendChild(card);
        });

        app.appendChild(grid);
    }

    // ── Diagram view — class cards ────────────────────────────────────────────
    function renderDiagram() {
        const data   = currentDiagram;
        const isAuto = data.id && data.id.startsWith('auto-');
        const app    = document.getElementById('app');
        app.innerHTML = '';

        app.appendChild(breadcrumb([
            { label: 'Home', action: function() { navigate('home'); } },
            { label: data.title },
        ]));

        if (isAuto) {
            // Card per class
            const classes = data.nodes.filter(function(n) { return n.type === 'event'; });
            const grid = el('div', {}, 'grid');
            classes.forEach(function(cls) {
                const methods = getClassMethods(data, cls);
                const card = el('div', {}, 'card');
                card.innerHTML =
                    '<div class="card-title">' + esc(cls.label) + '</div>' +
                    '<div class="card-meta">' + cls.file + ':' + cls.line + '</div>' +
                    '<div class="card-meta">' + methods.length + ' methods</div>';

                methods.forEach(function(m) {
                    const chip = el('div', {}, 'chip method-chip');
                    chip.textContent = m.label.split('.').pop();
                    if (m.trace) { chip.title = m.trace; chip.classList.add('has-trace'); }
                    chip.addEventListener('click', function(e) {
                        e.stopPropagation();
                        vscode.postMessage({ command: 'openFile', file: m.file, line: m.line });
                    });
                    card.appendChild(chip);
                });

                card.addEventListener('click', function() { navigate('class', data, cls); });
                grid.appendChild(card);
            });
            app.appendChild(grid);
        } else {
            // Hand-authored diagram — show SVG
            app.appendChild(renderSvg(data));
        }
    }

    // ── Class view — focused SVG + method list ────────────────────────────────
    function renderClass() {
        const data    = currentDiagram;
        const cls     = currentClass;
        const methods = getClassMethods(data, cls);
        const app     = document.getElementById('app');
        app.innerHTML = '';

        app.appendChild(breadcrumb([
            { label: 'Home',      action: function() { navigate('home'); } },
            { label: data.title,  action: function() { navigate('diagram', data); } },
            { label: cls.label },
        ]));

        // Class header
        const header = el('div', {}, 'class-header');
        header.innerHTML =
            '<div class="class-name">' + esc(cls.label) + '</div>' +
            '<div class="class-file" data-file="' + esc(cls.file) + '" data-line="' + cls.line + '">' +
            esc(cls.file) + ':' + cls.line + '</div>';
        header.querySelector('.class-file').addEventListener('click', function() {
            vscode.postMessage({ command: 'openFile', file: cls.file, line: cls.line });
        });
        if (cls.trace) {
            const trace = el('div', {}, 'class-trace');
            trace.textContent = cls.trace;
            header.appendChild(trace);
        }
        app.appendChild(header);

        // Method list
        const list = el('div', {}, 'method-list');
        methods.forEach(function(m) {
            const row = el('div', {}, 'method-row');
            const nameEl = el('div', {}, 'method-name');
            nameEl.textContent = m.label.split('.').pop();
            const fileEl = el('div', {}, 'method-file');
            fileEl.textContent = m.file + ':' + m.line;
            const traceEl = el('div', {}, 'method-trace');
            traceEl.textContent = m.trace || '—';

            row.appendChild(nameEl);
            row.appendChild(fileEl);
            row.appendChild(traceEl);
            row.addEventListener('click', function() {
                vscode.postMessage({ command: 'openFile', file: m.file, line: m.line });
            });
            list.appendChild(row);
        });
        app.appendChild(list);

        // Mini SVG showing just this class + methods
        const miniData = {
            id: 'mini', title: cls.label, layout: 'vertical',
            nodes: [cls].concat(methods),
            edges: methods.map(function(m) { return { from: cls.id, to: m.id }; }),
        };
        const svgWrap = el('div', {}, 'svg-wrap');
        svgWrap.appendChild(renderSvg(miniData));
        app.appendChild(svgWrap);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function getClassMethods(data, cls) {
        const childIds = new Set(
            data.edges
                .filter(function(e) { return e.from === cls.id; })
                .map(function(e) { return e.to; })
        );
        return data.nodes.filter(function(n) { return childIds.has(n.id); });
    }

    function breadcrumb(items) {
        const bc = el('div', {}, 'breadcrumb');
        items.forEach(function(item, i) {
            if (i > 0) { const sep = el('span'); sep.textContent = ' › '; bc.appendChild(sep); }
            if (item.action) {
                const a = el('a', { href:'#' });
                a.textContent = item.label;
                a.addEventListener('click', function(e) { e.preventDefault(); item.action(); });
                bc.appendChild(a);
            } else {
                const span = el('span', {}, 'bc-current');
                span.textContent = item.label;
                bc.appendChild(span);
            }
        });
        return bc;
    }

    function el(tag, attrs, cls) {
        const e = document.createElement(tag);
        if (attrs) { Object.keys(attrs).forEach(function(k) { e.setAttribute(k, attrs[k]); }); }
        if (cls)   { e.className = cls; }
        return e;
    }

    function esc(str) {
        return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── SVG renderer (for hand-authored + mini class diagrams) ────────────────
    function renderSvg(data) {
        const SVG_NS = 'http://www.w3.org/2000/svg';
        const NODE_W = 200, NODE_H = 44, ROW_H = 100, COL_GAP = 240;
        const CENTRE_X = 300;
        const TRACE_RING = '#9b6dff';
        const COLOURS = {
            event:    { fill: '#1a3a5c', stroke: '#4a9eff' },
            function: { fill: '#2d5a2d', stroke: '#4aff6f' },
            decision: { fill: '#5a3a1a', stroke: '#ffaa4a' },
        };

        // BFS layout
        const children = {}, parents = {};
        data.nodes.forEach(function(n) { children[n.id] = []; parents[n.id] = 0; });
        data.edges.forEach(function(e) {
            if (children[e.from]) { children[e.from].push(e); }
            if (parents[e.to] !== undefined) { parents[e.to]++; }
        });
        const roots = data.nodes.filter(function(n) { return parents[n.id] === 0; });
        const depth = {}, col = {}, queue = [];
        const horizontal = data.layout === 'horizontal';
        roots.forEach(function(n, i) { depth[n.id] = 0; col[n.id] = i * 2; queue.push(n.id); });
        const visited = new Set();
        while (queue.length) {
            const id = queue.shift();
            if (visited.has(id)) { continue; }
            visited.add(id);
            const ch = children[id] || [];
            const half = (ch.length-1)/2;
            ch.forEach(function(e, i) {
                if (depth[e.to] === undefined) {
                    col[e.to]   = (col[id]||0) + (ch.length>1 ? i-half : 0);
                    depth[e.to] = (depth[id]||0) + 1;
                }
                queue.push(e.to);
            });
        }
        data.nodes.forEach(function(n) { if (depth[n.id]===undefined) { depth[n.id]=0; col[n.id]=0; } });

        const pos = {};
        const HORIZ_X = 60, HORIZ_Y = 300;
        data.nodes.forEach(function(n) {
            pos[n.id] = horizontal
                ? { x: HORIZ_X + (depth[n.id]||0)*ROW_H, y: HORIZ_Y + (col[n.id]||0)*COL_GAP }
                : { x: CENTRE_X + (col[n.id]||0)*COL_GAP, y: 40 + (depth[n.id]||0)*ROW_H };
        });

        const allX = data.nodes.map(function(n){return pos[n.id].x;});
        const allY = data.nodes.map(function(n){return pos[n.id].y;});
        const minX = Math.min.apply(null,allX), minY = Math.min.apply(null,allY);
        const maxX = Math.max.apply(null,allX), maxY = Math.max.apply(null,allY);
        const shiftX = minX < NODE_W/2+20 ? NODE_W/2+20-minX : 0;
        const shiftY = minY < NODE_H/2+20 ? NODE_H/2+20-minY : 0;
        data.nodes.forEach(function(n) { pos[n.id].x += shiftX; pos[n.id].y += shiftY; });

        const W = horizontal ? maxX+ROW_H+shiftX : Math.max(600, maxX-minX+NODE_W+80+shiftX);
        const H = horizontal ? Math.max(400, maxY-minY+NODE_W+80+shiftY) : maxY+ROW_H+shiftY+60;

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 '+W+' '+H);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', H);
        svg.style.maxHeight = '400px';

        function svgEl(tag, attrs) {
            const e = document.createElementNS(SVG_NS, tag);
            Object.keys(attrs||{}).forEach(function(k){e.setAttribute(k,attrs[k]);});
            return e;
        }

        const defs = svgEl('defs');
        const mk = svgEl('marker', {id:'arrow2',markerWidth:'10',markerHeight:'7',refX:'10',refY:'3.5',orient:'auto'});
        mk.appendChild(svgEl('polygon',{points:'0 0, 10 3.5, 0 7',fill:'#888'}));
        defs.appendChild(mk); svg.appendChild(defs);

        data.edges.forEach(function(edge) {
            const f = pos[edge.from], t = pos[edge.to];
            if (!f||!t) { return; }
            const x1=horizontal?f.x+NODE_W/2:f.x, y1=horizontal?f.y:f.y+NODE_H/2;
            const x2=horizontal?t.x-NODE_W/2:t.x, y2=horizontal?t.y:t.y-NODE_H/2;
            let pe;
            if (Math.abs(x1-x2)<2) {
                pe = svgEl('line',{x1:x1,y1:y1,x2:x2,y2:y2,stroke:'#555','stroke-width':'2','marker-end':'url(#arrow2)'});
            } else {
                const cy1=y1+(y2-y1)*0.4, cy2=y1+(y2-y1)*0.6;
                pe = svgEl('path',{d:'M'+x1+','+y1+' C'+x1+','+cy1+' '+x2+','+cy2+' '+x2+','+y2,fill:'none',stroke:'#555','stroke-width':'2','marker-end':'url(#arrow2)'});
            }
            svg.appendChild(pe);
            if (edge.label) {
                const mx=(x1+x2)/2, my=(y1+y2)/2;
                svg.appendChild(svgEl('rect',{x:mx-18,y:my-10,width:36,height:18,rx:'3',fill:'#1e1e1e',opacity:'0.85'}));
                const t2=svgEl('text',{x:mx,y:my+1,fill:'#ffaa4a','font-size':'11','text-anchor':'middle','dominant-baseline':'middle'});
                t2.textContent=edge.label; svg.appendChild(t2);
            }
        });

        data.nodes.forEach(function(node) {
            const p=pos[node.id]; if(!p){return;}
            const cx=p.x, cy=p.y;
            const c=COLOURS[node.type]||COLOURS.function;
            const g=svgEl('g'); g.style.cursor='pointer';
            g.addEventListener('click',function(){
                vscode.postMessage({command:'openFile',file:node.file,line:node.line});
            });
            const tooltip_text = (node.trace||'') + '\n' + node.file+':'+node.line;
            const title=svgEl('title'); title.textContent=tooltip_text; g.appendChild(title);

            if (node.trace) {
                g.appendChild(svgEl('rect',{x:cx-NODE_W/2-3,y:cy-NODE_H/2-3,width:NODE_W+6,height:NODE_H+6,rx:'6',fill:'none',stroke:TRACE_RING,'stroke-width':'1',opacity:'0.5'}));
            }
            if (node.type==='event') {
                g.appendChild(svgEl('rect',{x:cx-NODE_W/2,y:cy-NODE_H/2,width:NODE_W,height:NODE_H,rx:NODE_H/2,fill:c.fill,stroke:c.stroke,'stroke-width':'2'}));
            } else if (node.type==='decision') {
                const hw=NODE_W/2,hh=NODE_H/2+6;
                g.appendChild(svgEl('polygon',{points:cx+','+(cy-hh)+' '+(cx+hw)+','+cy+' '+cx+','+(cy+hh)+' '+(cx-hw)+','+cy,fill:c.fill,stroke:c.stroke,'stroke-width':'2'}));
            } else {
                g.appendChild(svgEl('rect',{x:cx-NODE_W/2,y:cy-NODE_H/2,width:NODE_W,height:NODE_H,rx:'4',fill:c.fill,stroke:c.stroke,'stroke-width':'2'}));
            }
            const MAX=Math.floor(NODE_W/7);
            const lbl=(node.label.length>MAX?node.label.slice(0,MAX-1)+'…':node.label).split('\n');
            const lh=14, sy=cy-((lbl.length-1)*lh)/2;
            lbl.forEach(function(lt,i){
                const t=svgEl('text',{x:cx,y:sy+i*lh,fill:'#fff','font-size':'11','text-anchor':'middle','dominant-baseline':'middle'});
                t.textContent=lt; g.appendChild(t);
            });
            if (node.trace) {
                g.appendChild(svgEl('circle',{cx:cx+NODE_W/2-6,cy:cy-NODE_H/2+6,r:'4',fill:TRACE_RING}));
            }
            svg.appendChild(g);
        });
        return svg;
    }

}());