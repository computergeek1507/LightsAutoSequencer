'use strict';

// "Make a sequence" tab: load the show, plan what lights up when, watch it
// in the preview, save the .xsq.
(() => {
    const $ = id => document.getElementById(id);
    const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

    const S = {
        show: null,
        plan: null,
        history: [],
        future: [],
        open: new Set(),
        nowId: null,
        gen: null,
        prep: null,
        dirty: true,
        lastT: -1,
        tabVisible: false,
        view: null,          // viewer geometry
    };

    // ---------- show folder ----------

    function setShowStatus(msg, isError) {
        $('showStatus').textContent = msg;
        $('showStatus').classList.toggle('error', !!isError);
    }

    async function useShow(loader) {
        try {
            setShowStatus('Reading your show…');
            const show = await loader();
            S.show = show;
            S.xsqSavedAt = 0;
            setTimeout(() => document.dispatchEvent(new CustomEvent('xl:show')), 0);
            loadPropTypes();
            const faces = [...show.models.values()].filter(m => m.faces.length).length;
            setShowStatus(`Show: "${show.folderName}" · ${show.models.size} models, ${show.groups.size} groups, ${show.nodeCount.toLocaleString()} lights${faces ? `, ${faces} singing face${faces > 1 ? 's' : ''}` : ''}${show.backgroundUrl ? '' : ' · no house photo found'}`);
            // once loaded the panel is one line; the folder can still be changed
            $('showPanel').classList.add('loaded');
            $('pickShow').textContent = 'Choose a different folder…';
            $('pickShow').classList.remove('primary');
            $('previewPanel').hidden = false;
            $('gridPanel').hidden = false;
            $('planPanel').hidden = false;
            $('xsqPanel').hidden = false;
            $('saveXsq').hidden = !show.folder;
            await setupViewer();
            loadPlan();
            regenerate();
        } catch (err) {
            if (err && err.name === 'AbortError') { setShowStatus(''); return; }
            console.error(err);
            setShowStatus(err.message || String(err), true);
        }
    }

    $('pickShow').addEventListener('click', () => {
        if (!Show.canPickFolder()) {
            setShowStatus('This browser cannot open folders. Use "Or pick the two files…" instead (Chrome or Edge can open the folder).', true);
            return;
        }
        useShow(async () => Show.loadFromFolder(await Show.pickFolder()));
    });
    $('reuseShow').addEventListener('click', async () => {
        const h = await Show.savedFolder();
        if (!h) return;
        useShow(async () => {
            if (!(await Show.permission(h, 'read'))) throw new Error('Permission to read the folder was not given.');
            return Show.loadFromFolder(h);
        });
    });
    $('pickShowFiles').addEventListener('click', () => $('showFiles').click());
    $('showFiles').addEventListener('change', e => {
        const files = e.target.files;
        if (files && files.length) useShow(() => Show.loadFromFiles(files));
    });
    (async () => {
        if (!Show.canPickFolder()) return;
        const h = await Show.savedFolder();
        if (h) { $('reuseShow').hidden = false; $('reuseShow').textContent = `Use "${h.name}" again`; }
    })();

    // Reconnect to the folder used last time without asking where it is.
    // Browsers drop the permission to read it between visits unless the user
    // chose "allow on every visit": if it is still granted, load quietly; if
    // not, ask for it on the click that opens this tab (asking needs a click).
    let autoTried = false;
    async function autoShow(mayAsk) {
        if (S.show || S.autoBusy || !Show.canPickFolder() || !XLWeb.song()) return;
        const h = await Show.savedFolder();
        if (!h) return;
        let ok = false;
        try {
            ok = (await h.queryPermission({ mode: 'read' })) === 'granted';
            if (!ok && mayAsk) ok = (await h.requestPermission({ mode: 'read' })) === 'granted';
        } catch (e) { ok = false; }
        if (!ok) {
            if (mayAsk) setShowStatus(`Press "Use "${h.name}" again" to open your show folder (the browser needs your OK).`);
            return;
        }
        S.autoBusy = true;
        try { await useShow(() => Show.loadFromFolder(h)); } finally { S.autoBusy = false; }
    }
    document.addEventListener('xl:song', () => { if (!autoTried) { autoTried = true; autoShow(false); } });
    document.addEventListener('xl:tab', e => { if (e.detail === 'seq') autoShow(true); });

    // ---------- preview ----------

    const canvas = $('viewer');
    let bgImg = null;

    async function setupViewer() {
        const show = S.show;
        bgImg = null;
        if (show.backgroundUrl) {
            bgImg = new Image();
            bgImg.src = show.backgroundUrl;
            await new Promise(r => { bgImg.onload = r; bgImg.onerror = r; });
            if (!bgImg.naturalWidth) bgImg = null;
        }
        // flatten all points: x, y, node index
        let offset = 0, n = 0;
        for (const m of show.models.values()) { m.offset = offset; offset += m.nodes.length; for (const nd of m.nodes) n += nd.pts.length; }
        const px = new Float32Array(n), py = new Float32Array(n), pn = new Int32Array(n), ps = new Float32Array(n), pm = new Int32Array(n);
        const models = [...show.models.values()];
        let k = 0;
        models.forEach((m, mi) => {
            m.nodes.forEach((nd, i) => {
                for (const p of nd.pts) { px[k] = p.x + (show.center0 ? show.previewW / 2 : 0); py[k] = show.previewH - p.y; pn[k] = m.offset + i; ps[k] = m.pixelSize; pm[k] = mi; k++; }
            });
        });
        S.view = { px, py, pn, ps, pm, models, total: offset };
        await loadPropPictures(show);
        S.modelGroups = null;
        S.hlCache = new Map();
        loadBgAdj();
        updateWindow();
        renderParts();
        S.dirty = true;
    }

    // The part of xLights' preview area the viewer shows (preview units, y down):
    // the house photo and every light, not the empty canvas beside them. While
    // the photo is being lined up it is the whole area, so it can move freely.
    function updateWindow() {
        const sh = S.show, V = S.view;
        if (!sh || !V) return;
        let win = { x: 0, y: 0, w: sh.previewW, h: sh.previewH };
        if (!S.bgAdjusting && V.px.length) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (let k = 0; k < V.px.length; k++) {
                const x = V.px[k], y = V.py[k];
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            for (const p of S.pictures || []) for (const c of p.model.image.corners) {
                const x = c.x + (sh.center0 ? sh.previewW / 2 : 0), y = sh.previewH - c.y;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            const m = 0.03 * Math.max(x1 - x0, y1 - y0, 1);
            x0 -= m; x1 += m; y0 -= m; y1 += m;
            if (bgImg) {
                const r = bgRect(), top = sh.previewH - r.y - r.h;
                x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.w);
                y0 = Math.min(y0, top); y1 = Math.max(y1, top + r.h);
            }
            x0 = Math.max(0, x0); y0 = Math.max(0, y0);
            x1 = Math.min(sh.previewW, x1); y1 = Math.min(sh.previewH, y1);
            if (x1 - x0 > 10 && y1 - y0 > 10) win = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
        S.win = win;
        S.viewW = 0;
        sizeViewer();
    }

    // Image props: the picture, plus a mask of how bright each pixel is, for
    // tinting it with the light's colour.
    async function loadPropPictures(show) {
        S.pictures = [];
        for (const m of show.models.values()) {
            const im = m.image;
            if (!im || !im.url) continue;
            const img = new Image();
            img.src = im.url;
            await new Promise(r => { img.onload = r; img.onerror = r; });
            if (!img.naturalWidth) continue;
            const w = Math.min(512, img.naturalWidth), h = Math.max(1, Math.round(img.naturalHeight * w / img.naturalWidth));
            const base = document.createElement('canvas'); base.width = w; base.height = h;
            const bg = base.getContext('2d');
            bg.drawImage(img, 0, 0, w, h);
            const data = bg.getImageData(0, 0, w, h), d = data.data;
            const mask = document.createElement('canvas'); mask.width = w; mask.height = h;
            const md = mask.getContext('2d').createImageData(w, h), mm = md.data;
            for (let i = 0; i < d.length; i += 4) {
                if (im.whiteAsAlpha && d[i] === d[i + 1] && d[i] === d[i + 2]) d[i + 3] = d[i];
                const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                mm[i] = mm[i + 1] = mm[i + 2] = 255; mm[i + 3] = Math.min(d[i + 3], l);
            }
            bg.putImageData(data, 0, 0);
            mask.getContext('2d').putImageData(md, 0, 0);
            const tint = document.createElement('canvas'); tint.width = w; tint.height = h;
            S.pictures.push({ model: m, base, mask, tint, off: im.off / 100 });
        }
    }

    // Where a picture sits on the viewer canvas.
    function pictureRect(p) {
        const sh = S.show, win = S.win, k = S.view.W / win.w;
        const xs = p.model.image.corners.map(c => c.x + (sh.center0 ? sh.previewW / 2 : 0));
        const ys = p.model.image.corners.map(c => sh.previewH - c.y);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        return { x: (x0 - win.x) * k, y: (y0 - win.y) * k, w: (x1 - x0) * k, h: (y1 - y0) * k };
    }

    function drawPictures(g, colors) {
        for (const p of S.pictures || []) {
            const r = pictureRect(p);
            if (r.w < 1 || r.h < 1) continue;
            const gi = 3 * p.model.offset;
            const R = colors ? colors[gi] : 0, G = colors ? colors[gi + 1] : 0, B = colors ? colors[gi + 2] : 0;
            const lit = Math.max(R, G, B) / 255;
            // dim when off, as xLights does (OffBrightness %)
            g.save();
            g.globalAlpha = 1;
            g.filter = `brightness(${(p.off * 0.6 + (1 - p.off) * 0.6 * lit).toFixed(3)})`;
            g.drawImage(p.base, r.x, r.y, r.w, r.h);
            g.restore();
            if (lit > 0.02) {
                const t = p.tint.getContext('2d');
                t.globalCompositeOperation = 'source-over';
                t.clearRect(0, 0, p.tint.width, p.tint.height);
                t.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
                t.fillRect(0, 0, p.tint.width, p.tint.height);
                t.globalCompositeOperation = 'destination-in';
                t.drawImage(p.mask, 0, 0);
                g.save();
                g.globalCompositeOperation = 'lighter';
                g.drawImage(p.tint, r.x, r.y, r.w, r.h);
                g.restore();
            }
        }
    }

    function sizeViewer() {
        if (!S.show || !S.view) return;
        const wrap = canvas.parentElement;
        const w = wrap.clientWidth || 800;
        if (w === S.viewW) return;
        S.viewW = w;
        const win = S.win || { x: 0, y: 0, w: S.show.previewW, h: S.show.previewH };
        const h = Math.round(w * win.h / win.w);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = Math.round(w * dpr), H = Math.round(h * dpr);
        canvas.width = W;
        canvas.height = H;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        const V = S.view;
        V.W = W; V.H = H;
        // Lights are drawn on a smaller layer and scaled up (which also softens
        // them into a glow): pushing a full high-DPI frame every tick is the
        // expensive part, not the effects.
        const LW = Math.min(W, 1000), LH = Math.round(LW * H / W);
        const sx = LW / win.w, sy = LH / win.h;
        V.pix = new Int32Array(V.px.length);
        for (let k = 0; k < V.px.length; k++) {
            const x = Math.round((V.px[k] - win.x) * sx), y = Math.round((V.py[k] - win.y) * sy);
            V.pix[k] = x < 1 || y < 1 || x >= LW - 1 || y >= LH - 1 ? -1 : y * LW + x;
        }
        V.LW = LW; V.LH = LH;
        V.glow = Math.max(1, Math.round(Math.min(sx, sy) * 1.2));
        V.light = document.createElement('canvas');
        V.light.width = LW; V.light.height = LH;
        V.img = V.light.getContext('2d').createImageData(LW, LH);
        V.u32 = new Uint32Array(V.img.data.buffer);
        V.touched = new Int32Array(V.px.length * (2 * V.glow + 1) ** 2);
        V.nTouched = 0;
        // The backdrop (photo + unlit bulbs) only changes with the options.
        V.backdrop = null;
        S.dirty = true;
    }
    new ResizeObserver(() => sizeViewer()).observe(canvas.parentElement);

    // ---------- the house photo: placed the way xLights places it, then the user's adjustments ----------

    const BG_DEFAULT = { dx: 0, dy: 0, scale: 1, sx: 1, sy: 1, alpha: 0.3 };
    const bgKey = () => 'xlweb-bg:' + (S.show ? S.show.folderName + '|' + S.show.backgroundName : '');

    function loadBgAdj() {
        let v = null;
        try { v = JSON.parse(localStorage.getItem(bgKey()) || 'null'); } catch (e) { v = null; }
        S.bgAdj = { ...BG_DEFAULT, ...(S.pendingBg || v || {}) };
        if (S.pendingBg) { S.pendingBg = null; try { localStorage.setItem(bgKey(), JSON.stringify(S.bgAdj)); } catch (e) { /* storage blocked */ } }
        syncBgInputs();
    }
    function saveBgAdj() {
        try { localStorage.setItem(bgKey(), JSON.stringify(S.bgAdj)); } catch (e) { /* storage blocked */ }
        document.dispatchEvent(new CustomEvent('xl:changed'));
    }

    // Photo rectangle in preview coordinates, y up: { x, y, w, h }.
    // xLights (ModelPreview): with "scale image" off it keeps the photo's
    // proportions, fills the preview's height or width, anchored bottom-left.
    function bgRect() {
        const sh = S.show, PW = sh.previewW, PH = sh.previewH;
        let w = PW, h = PH;
        if (!sh.backgroundScaled && bgImg) {
            const nh = bgImg.naturalHeight / PH || 1, nw = bgImg.naturalWidth / PW || 1;
            if (nw < nh) w = PW * nw / nh; else h = PH * nh / nw;
        }
        const a = S.bgAdj || BG_DEFAULT;
        const W2 = w * a.scale * a.sx, H2 = h * a.scale * a.sy;
        // grow from the centre of the default placement, then move
        return { x: w / 2 - W2 / 2 + a.dx, y: h / 2 - H2 / 2 + a.dy, w: W2, h: H2 };
    }

    function backdrop() {
        const V = S.view;
        const key = $('pvPhoto').checked + '|' + $('pvUnlit').checked + '|' + JSON.stringify(S.bgAdj) + '|' + !!S.bgAdjusting;
        if (V.backdrop && V.backdropKey === key) return V.backdrop;
        const c = document.createElement('canvas');
        c.width = V.W; c.height = V.H;
        const g = c.getContext('2d');
        g.fillStyle = '#05070b';
        g.fillRect(0, 0, V.W, V.H);
        if (bgImg && ($('pvPhoto').checked || S.bgAdjusting)) {
            const r = bgRect(), win = S.win, k = V.W / win.w;
            g.globalAlpha = S.bgAdjusting ? Math.max(0.65, S.bgAdj.alpha) : S.bgAdj.alpha;
            g.drawImage(bgImg, (r.x - win.x) * k, (S.show.previewH - r.y - r.h - win.y) * k, r.w * k, r.h * k);
            g.globalAlpha = 1;
        }
        if ($('pvUnlit').checked || S.bgAdjusting) {
            // while lining up, the bulbs are bright so they show against the photo
            g.fillStyle = S.bgAdjusting ? 'rgba(255,220,60,0.95)' : 'rgba(150,150,150,0.28)';
            const fx = V.W / V.LW, fy = V.H / V.LH, sz = Math.max(1, Math.round(fx));
            for (let k = 0; k < V.pix.length; k++) {
                const p = V.pix[k];
                if (p >= 0) g.fillRect(Math.round((p % V.LW) * fx), Math.round(Math.floor(p / V.LW) * fy), sz, sz);
            }
        }
        V.backdrop = c;
        V.backdropKey = key;
        return c;
    }

    function syncBgInputs() {
        const a = S.bgAdj || BG_DEFAULT;
        $('bgX').value = Math.round(a.dx);
        $('bgY').value = Math.round(a.dy);
        $('bgS').value = +(a.scale * 100).toFixed(1);
        $('bgW').value = +(a.sx * 100).toFixed(1);
        $('bgH').value = +(a.sy * 100).toFixed(1);
        $('bgA').value = Math.round(a.alpha * 100);
    }
    function bgChanged() { syncBgInputs(); S.dirty = true; clearTimeout(bgChanged.t); bgChanged.t = setTimeout(saveBgAdj, 300); }

    function setAdjusting(on) {
        S.bgAdjusting = on;
        $('bgAdjust').hidden = !on;
        $('bgAdjustBtn').classList.toggle('primary', on);
        canvas.classList.toggle('adjusting', on);
        canvas.tabIndex = on ? 0 : -1;
        updateWindow();
        if (on) { syncBgInputs(); canvas.focus({ preventScroll: true }); }
        S.dirty = true;
    }
    $('bgAdjustBtn').addEventListener('click', () => {
        if (!bgImg) { setShowStatus('There is no house photo to line up (xLights has no background image set, or it was not found in the show folder).', true); return; }
        setAdjusting(!S.bgAdjusting);
    });
    $('bgDone').addEventListener('click', () => setAdjusting(false));
    $('bgReset').addEventListener('click', () => { S.bgAdj = { ...BG_DEFAULT, alpha: S.bgAdj.alpha }; bgChanged(); });
    for (const [id, f] of [['bgX', v => { S.bgAdj.dx = v; }], ['bgY', v => { S.bgAdj.dy = v; }], ['bgS', v => { S.bgAdj.scale = Math.max(0.1, v / 100); }],
        ['bgW', v => { S.bgAdj.sx = Math.max(0.1, v / 100); }], ['bgH', v => { S.bgAdj.sy = Math.max(0.1, v / 100); }], ['bgA', v => { S.bgAdj.alpha = Math.max(0.05, Math.min(1, v / 100)); }]]) {
        $(id).addEventListener('input', e => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { f(v); S.dirty = true; clearTimeout(bgChanged.t); bgChanged.t = setTimeout(saveBgAdj, 300); } });
    }

    // drag to move (screen pixels -> preview units; y is up in the preview)
    let bgDrag = null;
    canvas.addEventListener('mousedown', e => {
        if (!S.bgAdjusting) return;
        e.preventDefault();
        bgDrag = { x: e.clientX, y: e.clientY, dx: S.bgAdj.dx, dy: S.bgAdj.dy, k: S.win.w / canvas.clientWidth };
        canvas.classList.add('dragging');
    });
    window.addEventListener('mousemove', e => {
        if (!bgDrag) return;
        S.bgAdj.dx = bgDrag.dx + (e.clientX - bgDrag.x) * bgDrag.k;
        S.bgAdj.dy = bgDrag.dy - (e.clientY - bgDrag.y) * bgDrag.k;
        syncBgInputs();
        S.dirty = true;
    });
    window.addEventListener('mouseup', () => { if (bgDrag) { bgDrag = null; canvas.classList.remove('dragging'); bgChanged(); } });
    canvas.addEventListener('wheel', e => {
        if (!S.bgAdjusting) return;
        e.preventDefault();
        const f = Math.exp(-e.deltaY * 0.0008);
        if (e.shiftKey) S.bgAdj.sx *= f;
        else if (e.altKey) S.bgAdj.sy *= f;
        else S.bgAdj.scale *= f;
        bgChanged();
    }, { passive: false });
    canvas.addEventListener('keydown', e => {
        if (!S.bgAdjusting) return;
        const step = e.shiftKey ? 10 : 1;
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (moves[e.key]) { e.preventDefault(); S.bgAdj.dx += moves[e.key][0]; S.bgAdj.dy += moves[e.key][1]; bgChanged(); }
        else if (e.key === 'Escape' || e.key === 'Enter') setAdjusting(false);
    });

    // Bulbs are blended by keeping the brightest value per pixel, not by adding:
    // a dense model (the matrix) would otherwise sum to white.
    function drawViewer(colors) {
        const show = S.show, V = S.view;
        if (!show || !V || !V.pix) return;
        const W = V.W, H = V.H;
        const g = canvas.getContext('2d');
        g.globalCompositeOperation = 'source-over';
        g.drawImage(backdrop(), 0, 0);
        drawPictures(g, colors);
        if (!colors) return;
        const d = V.img.data, u32 = V.u32, touched = V.touched;
        for (let i = 0; i < V.nTouched; i++) u32[touched[i]] = 0;
        let nt = 0;
        const R = V.glow, LW = V.LW, LH = V.LH;
        for (let k = 0; k < V.pix.length; k++) {
            const p = V.pix[k];
            if (p < 0) continue;
            const ni = 3 * V.pn[k];
            const r = colors[ni], gg = colors[ni + 1], b = colors[ni + 2];
            if (r + gg + b <= 6) continue;
            const x = p % LW, y = (p - x) / LW;
            for (let dy = -R; dy <= R; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= LH) continue;
                for (let dx = -R; dx <= R; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= LW) continue;
                    const f = dx === 0 && dy === 0 ? 1 : 0.6 / (dx * dx + dy * dy);
                    const px = yy * LW + xx, o = 4 * px;
                    if (!d[o + 3]) { touched[nt++] = px; d[o + 3] = 255; }
                    const rr = r * f, g2 = gg * f, bb = b * f;
                    if (rr > d[o]) d[o] = rr;
                    if (g2 > d[o + 1]) d[o + 1] = g2;
                    if (bb > d[o + 2]) d[o + 2] = bb;
                }
            }
        }
        V.nTouched = nt;
        V.light.getContext('2d').putImageData(V.img, 0, 0);
        g.globalCompositeOperation = 'lighter';
        g.imageSmoothingEnabled = true;
        g.drawImage(V.light, 0, 0, W, H);
        g.globalCompositeOperation = 'source-over';
        drawOverlays(g);
    }

    // Boxes round the props a hovered row controls, and the drag-selection box.
    function drawOverlays(g) {
        const V = S.view, win = S.win, k = V.W / win.w;
        if (S.hl && S.hl.length) {
            const rects = highlightRects(S.hl);
            g.save();
            g.lineWidth = Math.max(1.5, k * 1.6);
            g.setLineDash([6 * k, 4 * k]);
            g.strokeStyle = 'rgba(80, 220, 255, 0.95)';
            g.fillStyle = 'rgba(80, 220, 255, 0.10)';
            for (const r of rects) {
                const pad = 4;
                g.fillRect((r.x0 - pad - win.x) * k, (r.y0 - pad - win.y) * k, (r.x1 - r.x0 + 2 * pad) * k, (r.y1 - r.y0 + 2 * pad) * k);
                g.strokeRect((r.x0 - pad - win.x) * k, (r.y0 - pad - win.y) * k, (r.x1 - r.x0 + 2 * pad) * k, (r.y1 - r.y0 + 2 * pad) * k);
            }
            g.restore();
        }
        if (S.box) {
            const dpr = V.W / canvas.clientWidth;
            const b = S.box;
            g.save();
            g.strokeStyle = 'rgba(255, 210, 60, 0.95)';
            g.fillStyle = 'rgba(255, 210, 60, 0.12)';
            g.lineWidth = 1.5 * dpr;
            const x = Math.min(b.x0, b.x1) * dpr, y = Math.min(b.y0, b.y1) * dpr, w = Math.abs(b.x1 - b.x0) * dpr, h = Math.abs(b.y1 - b.y0) * dpr;
            g.fillRect(x, y, w, h);
            g.strokeRect(x, y, w, h);
            g.restore();
        }
    }

    // One rectangle (preview coords, y down) per model a list of targets touches.
    function highlightRects(targets) {
        const key = targets.join('\n');
        if (S.hlCache.has(key)) return S.hlCache.get(key);
        const byModel = new Map();
        for (const t of targets) {
            for (const n of Show.resolveTarget(S.show, t)) {
                const p = n.model.nodes[n.i].pts[0];
                const x = p.x + (S.show.center0 ? S.show.previewW / 2 : 0), y = S.show.previewH - p.y;
                let r = byModel.get(n.model.name);
                if (!r) byModel.set(n.model.name, r = { x0: x, y0: y, x1: x, y1: y });
                if (x < r.x0) r.x0 = x; if (x > r.x1) r.x1 = x; if (y < r.y0) r.y0 = y; if (y > r.y1) r.y1 = y;
            }
        }
        const rects = [...byModel.values()];
        if (S.hlCache.size > 200) S.hlCache.clear();
        S.hlCache.set(key, rects);
        return rects;
    }

    function setHighlight(targets) {
        S.hl = targets && targets.length ? targets : null;
        S.dirty = true;
    }

    // ---------- song-parts strip: click a part to jump there and open its lights ----------

    function renderParts() {
        const song = XLWeb.song();
        const box = $('scrubParts');
        if (!song) { box.innerHTML = ''; return; }
        const dur = song.model.duration;
        box.innerHTML = song.sections.map(s => `<span data-id="${s.id}" style="left:${s.s / dur * 100}%;width:${(s.e - s.s) / dur * 100}%" title="${esc(s.name)}: click to play from here, Ctrl+click to open its lights">${esc(s.name)}</span>`).join('');
        // plain click falls through to the strip (move the playhead); Ctrl/Cmd+click opens the section
        box.querySelectorAll('span').forEach(sp => sp.addEventListener('click', e => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.stopPropagation();
            goToSection(sp.dataset.id);
        }));
        S.nowId = null;
    }

    $('scrub').addEventListener('click', e => {
        const song = XLWeb.song();
        if (!song) return;
        const r = $('scrub').getBoundingClientRect();
        XLWeb.seek((e.clientX - r.left) / r.width * song.model.duration);
        S.dirty = true;
    });
    $('pvPhoto').addEventListener('change', () => { S.dirty = true; });
    $('pvUnlit').addEventListener('change', () => { S.dirty = true; });

    function goToSection(id) {
        const song = XLWeb.song();
        const sec = song && song.sections.find(s => s.id === id);
        if (!sec) return;
        if (S.loopId) S.loopId = id;    // keep looping, now this section
        XLWeb.seek(sec.s + 0.001);
        S.nowId = id;
        S.open.add(id);
        saveOpen();
        renderPlan();
        S.dirty = true;
        const card = document.querySelector(`.sec-card[data-id="${id}"]`);
        if (S.updatePvH) S.updatePvH();
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function setLoop(id) {
        S.loopId = id;
        document.querySelectorAll('.sec-card .loop').forEach(b => {
            const on = b.closest('.sec-card').dataset.id === id;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
        });
        S.dirty = true;
    }

    // Looping runs on its own timer, not the drawing loop, so it still wraps
    // when the page is busy or in the background. Moving the playhead well
    // outside the section ends the loop.
    setInterval(() => {
        if (!S.loopId || !XLWeb.playing()) return;
        const song = XLWeb.song();
        const ls = song && song.sections.find(s => s.id === S.loopId);
        if (!ls) { setLoop(null); return; }
        const t = XLWeb.time();
        if (t >= ls.e - 0.04 && t < ls.e + 2) { XLWeb.seek(ls.s + 0.001); S.dirty = true; }
        else if (t < ls.s - 0.5 || t >= ls.e + 2) setLoop(null);
    }, 30);

    function loopSection(sec) {
        setLoop(sec.id);
        XLWeb.seek(sec.s + 0.001);
        XLWeb.play();
    }

    // ---------- transport strip: sections, loop, speed, beat counter ----------

    function jumpTo(sec) {
        if (!sec) return;
        if (S.loopId) setLoop(sec.id);
        XLWeb.seek(sec.s + 0.001);
        S.dirty = true;
    }
    $('tPrev').addEventListener('click', () => {
        const song = XLWeb.song(), t = XLWeb.time();
        let i = song.sections.findIndex(s => t >= s.s && t < s.e);
        if (i < 0) i = song.sections.length;
        // like a music player: past the first second, "previous" restarts this section
        if (i < song.sections.length && t - song.sections[i].s > 1) jumpTo(song.sections[i]);
        else jumpTo(song.sections[Math.max(0, i - 1)]);
    });
    $('tNext').addEventListener('click', () => {
        const song = XLWeb.song(), t = XLWeb.time();
        const next = song.sections.find(s => s.s > t + 0.01);
        if (next) jumpTo(next);
    });
    $('tPlay').addEventListener('click', () => $('play').click());
    $('tLoop').addEventListener('click', () => {
        const song = XLWeb.song(), t = XLWeb.time();
        const cur = song.sections.find(s => t >= s.s && t < s.e);
        if (!cur) return;
        if (S.loopId === cur.id) setLoop(null); else loopSection(cur);
    });
    $('tSpeed').addEventListener('change', e => { XLWeb.setRate(parseFloat(e.target.value)); S.dirty = true; });

    let lastBeat = -1;
    function updateTransport(song, t, cur) {
        const playing = XLWeb.playing();
        $('tPlay').textContent = playing ? '⏸ Pause' : '▶ Play';
        $('tLoop').classList.toggle('on', !!S.loopId);
        $('tSec').textContent = cur ? cur.name : '';
        const beats = song.grid.beats;
        let lo = 0, hi = beats.length - 1, bi = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (beats[m].s <= t) { bi = m; lo = m + 1; } else hi = m - 1; }
        if (bi < 0) { $('tBeatText').textContent = 'Bar – · beat –'; return; }
        const bars = song.grid.bars;
        let bar = null;
        for (let k = bars.length - 1; k >= 0; k--) if (bars[k].s <= t + 0.0001) { bar = bars[k]; break; }
        $('tBeatText').textContent = `Bar ${bar ? bar.n : '–'} · beat ${beats[bi].n}`;
        if (bi !== lastBeat) {
            lastBeat = bi;
            if (playing) {
                const dot = $('tBeatDot');
                dot.className = beats[bi].n === 1 ? 'down' : 'on';
                clearTimeout(dot.t);
                dot.t = setTimeout(() => { dot.className = ''; }, 110);
            }
        }
    }

    // ---------- effect grid for the section that is playing ----------
    //
    // One row per prop or group (one band per layer), a block per effect over
    // time, bar lines, and the playhead: the whole section at a glance.

    const gcv = $('fxGrid');
    const G = { key: '', blocks: [], sec: null, LW: 140, x: null };

    function rowWhere(rowId) {
        if (S.plan.whole.rows.some(r => r.id === rowId)) return 'whole';
        for (const [id, c] of Object.entries(S.plan.sections)) if (c.rows.some(r => r.id === rowId)) return id;
        return null;
    }

    function buildGrid(song, sec) {
        const wrap = $('gridWrap');
        const W = Math.max(300, wrap.clientWidth);
        const rowH = 16, axisH = 20;
        const s0 = sec.s * 1000, e0 = sec.e * 1000;
        const rows = [];
        if (S.gen) {
            for (const [name, r] of S.gen.rows) {
                const layers = r.layers.map(l => l.filter(fx => fx.sMs < e0 && fx.eMs > s0)).filter(l => l.length);
                if (layers.length) rows.push({ name, layers });
            }
        }
        const nBands = rows.reduce((a, r) => a + r.layers.length, 0);
        const H = axisH + Math.max(1, nBands) * rowH + 6;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const c = document.createElement('canvas');
        c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
        const g = c.getContext('2d');
        g.scale(dpr, dpr);
        const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        const LW = G.LW;
        const x = t => LW + (t - sec.s) / (sec.e - sec.s) * (W - LW - 6);
        g.fillStyle = css('--surface'); g.fillRect(0, 0, W, H);
        g.font = '11px system-ui, sans-serif';
        g.textBaseline = 'middle';
        // beats and bars
        for (const b of song.grid.beats) {
            if (b.s < sec.s || b.s > sec.e) continue;
            const xx = Math.round(x(b.s)) + 0.5;
            g.strokeStyle = b.n === 1 ? css('--muted') : css('--line');
            g.globalAlpha = b.n === 1 ? 0.6 : 0.5;
            g.beginPath(); g.moveTo(xx, axisH - 4); g.lineTo(xx, H); g.stroke();
            g.globalAlpha = 1;
        }
        g.fillStyle = css('--muted');
        g.textAlign = 'left';
        for (const b of song.grid.bars) {
            if (b.s < sec.s - 0.001 || b.s > sec.e) continue;
            g.fillText(String(b.n), x(b.s) + 3, 8);
        }
        const blocks = [];
        let y = axisH;
        if (!rows.length) {
            g.fillStyle = css('--muted');
            g.fillText('No effects in this section yet.', LW + 8, axisH + 8);
        }
        for (const row of rows) {
            row.layers.forEach((layer, li) => {
                g.fillStyle = css('--lane');
                g.fillRect(LW, y + 1, W - LW - 6, rowH - 2);
                if (li === 0) {
                    g.fillStyle = css('--text');
                    g.textAlign = 'left';
                    g.save(); g.beginPath(); g.rect(0, y, LW - 6, rowH); g.clip();
                    g.fillText(row.name, 4, y + rowH / 2);
                    g.restore();
                }
                for (const fx of layer) {
                    const x0 = Math.max(LW, x(fx.sMs / 1000)), x1 = Math.min(W - 6, x(fx.eMs / 1000));
                    const w = Math.max(1.5, x1 - x0 - 1);
                    const col = fx.colors[0] || '#888888';
                    g.fillStyle = col;
                    g.globalAlpha = 0.85;
                    g.fillRect(x0, y + 2, w, rowH - 4);
                    g.globalAlpha = 1;
                    if (fx.colors.length > 1 && w > 10) {
                        const sw = Math.min(6, w / fx.colors.length);
                        fx.colors.slice(1, 4).forEach((cc, k) => { g.fillStyle = cc; g.fillRect(x0 + w - (k + 1) * sw, y + rowH - 6, sw, 3); });
                    }
                    if (w > 44) {
                        const [r, gg, b] = Effects.hexToRgb(col);
                        g.fillStyle = r * 0.3 + gg * 0.59 + b * 0.11 > 150 ? '#111' : '#fff';
                        g.textAlign = 'left';
                        g.save(); g.beginPath(); g.rect(x0, y, w - 2, rowH); g.clip();
                        g.fillText(fx.eff.label, x0 + 3, y + rowH / 2);
                        g.restore();
                    }
                    blocks.push({ x0, x1: x0 + w, y0: y, y1: y + rowH, fx, name: row.name });
                }
                y += rowH;
            });
        }
        gcv.width = c.width; gcv.height = c.height;
        gcv.style.width = W + 'px'; gcv.style.height = H + 'px';
        G.static = c; G.blocks = blocks; G.sec = sec; G.x = x; G.W = W; G.H = H; G.dpr = dpr;
    }

    // the grid is drawn from the theme's colours: redraw it when they change
    document.addEventListener('xl:theme', () => { G.key = null; S.dirty = true; });

    function drawGrid(song, t, cur) {
        if ($('gridPanel').hidden || !$('gridWrap').clientWidth) return;
        const sec = cur || (G.sec && song.sections.find(s => s.id === G.sec.id)) || song.sections[0];
        if (!sec) return;
        const key = [sec.id, sec.s, sec.e, S.genVer, $('gridWrap').clientWidth].join('|');
        if (key !== G.key) { G.key = key; buildGrid(song, sec); $('gridTitle').textContent = sec.name; }
        const g = gcv.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(G.static, 0, 0);
        if (t >= sec.s && t <= sec.e) {
            const xx = G.x(t) * G.dpr;
            g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--playhead').trim();
            g.fillRect(Math.round(xx) - 1, 0, 2 * G.dpr, gcv.height);
        }
    }

    function gridHit(e) {
        const r = gcv.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        return { px, py, b: G.blocks.find(b => px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1) };
    }

    gcv.addEventListener('mousemove', e => {
        const { px, py, b } = gridHit(e);
        const tip = $('gridTip');
        if (!b) { tip.hidden = true; if (S.gridHl) { S.gridHl = false; setHighlight(null); } gcv.style.cursor = px > G.LW ? 'pointer' : ''; return; }
        gcv.style.cursor = 'pointer';
        const fx = b.fx;
        const row = [S.plan.whole, ...Object.values(S.plan.sections)].flatMap(c => c.rows).find(r => r.id === fx.rowId);
        const trig = row && row.trigger && row.trigger !== 'span' ? ' · ' + ((Sequencer.TRIGGERS.find(x => x.id === row.trigger) || {}).label || '') : '';
        tip.innerHTML = `<b>${esc(fx.eff.label)}</b>${esc(trig)}<br>${esc(b.name)}<br><span class="muted">${fmt(fx.sMs / 1000)}–${fmt(fx.eMs / 1000)}</span>`;
        tip.hidden = false;
        tip.style.left = Math.min(px + 12, G.W - 190) + 'px';
        tip.style.top = (py + 14) + 'px';
        S.gridHl = true;
        setHighlight([b.name]);
    });
    gcv.addEventListener('mouseleave', () => { $('gridTip').hidden = true; if (S.gridHl) { S.gridHl = false; setHighlight(null); } });
    gcv.addEventListener('click', e => {
        const { px, b } = gridHit(e);
        if (b) {
            const where = rowWhere(b.fx.rowId);
            if (!where) return;
            S.open.add(where);
            S.rowOpen.add(b.fx.rowId);
            saveOpen();
            renderPlan();
            const el = document.querySelector(`.plan-row[data-row="${b.fx.rowId}"]`);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('flash');
                setTimeout(() => el.classList.remove('flash'), 1200);
            }
            return;
        }
        if (px > G.LW && G.sec) {
            const t = G.sec.s + (px - G.LW) / (G.W - G.LW - 6) * (G.sec.e - G.sec.s);
            XLWeb.seek(Math.max(G.sec.s, Math.min(G.sec.e - 0.01, t)));
            S.dirty = true;
        }
    });

    let frameTimes = [];
    function loop() {
        requestAnimationFrame(loop);
        if (!S.tabVisible || !S.show || !S.view) return;
        const song = XLWeb.song();
        if (!song) return;
        const t = XLWeb.time();
        if (!S.dirty && Math.abs(t - S.lastT) < 0.001) return;
        S.lastT = t;
        S.dirty = false;
        const t0 = performance.now();
        const colors = S.prep && !S.bgAdjusting ? Sequencer.renderFrame(S.prep, song, t) : null;
        const t1 = performance.now();
        drawViewer(colors);
        frameTimes.push([t1 - t0, performance.now() - t1]);
        if (frameTimes.length > 30) frameTimes.shift();
        $('scrubFill').style.width = (t / song.model.duration * 100) + '%';
        const avg = i => frameTimes.reduce((a, b) => a + b[i], 0) / frameTimes.length;
        const cur = song.sections.find(s => t >= s.s && t < s.e);
        const looping = S.loopId ? song.sections.find(s => s.id === S.loopId) : null;
        $('pvInfo').textContent = `${fmt(t)}${cur ? ' · ' + cur.name : ''}${looping ? ` · 🔁 looping ${looping.name}` : ''} · ${S.gen ? S.gen.count.toLocaleString() + ' effects' : 'no effects yet'} · effects ${avg(0).toFixed(0)} ms, drawing ${avg(1).toFixed(0)} ms per frame`;
        updateTransport(song, t, cur);
        drawGrid(song, t, cur);
        // highlight the part that is playing
        const nowId = cur ? cur.id : null;
        if (nowId !== S.nowId) {
            S.nowId = nowId;
            document.querySelectorAll('#scrubParts span, .sec-card').forEach(el => el.classList.toggle('now', el.dataset.id === nowId));
            if (S.onlyNow && nowId && nowId !== S.shownId) {
                if (planBusy()) S.planStale = true; else renderPlan();
            }
        }
    }
    requestAnimationFrame(loop);

    document.addEventListener('xl:tab', e => {
        S.tabVisible = e.detail === 'seq';
        if (S.tabVisible) { S.viewW = 0; sizeViewer(); renderParts(); renderPlan(); S.dirty = true; }
    });

    // ---------- the plan: storage, history ----------

    const planKey = () => 'xlweb-plan:' + (XLWeb.song() ? XLWeb.song().hash : '');
    const openKey = () => 'xlweb-open:' + (XLWeb.song() ? XLWeb.song().hash : '');

    function savePlan() {
        try { localStorage.setItem(planKey(), JSON.stringify(S.plan)); } catch (e) { /* storage blocked */ }
    }
    function loadPlan() {
        let p = null;
        try { p = JSON.parse(localStorage.getItem(planKey()) || 'null'); } catch (e) { p = null; }
        setPlan(p, true);
        S.planHash = XLWeb.song() ? XLWeb.song().hash : null;
        try { S.open = new Set(JSON.parse(localStorage.getItem(openKey()) || '[]')); } catch (e) { S.open = new Set(); }
    }
    function saveOpen() {
        try { localStorage.setItem(openKey(), JSON.stringify([...S.open])); } catch (e) { /* storage blocked */ }
    }

    // Replace the whole plan (from storage, a project file, or an idea).
    function setPlan(p, quiet) {
        S.plan = Sequencer.migrate(p, XLWeb.song());
        S.plan.whole = S.plan.whole || { rows: [] };
        S.plan.sections = S.plan.sections || {};
        // every row needs its own id (open/close, solo and mute go by it)
        const seen = new Set();
        for (const c of [S.plan.whole, ...Object.values(S.plan.sections)]) {
            for (const r of c.rows || []) {
                if (!r.id || seen.has(r.id)) r.id = Sequencer.newId();
                seen.add(r.id);
            }
        }
        // Props this show doesn't have are kept by name (left out of the preview and
        // the saved sequence) so the warning can offer to swap them; see showMissing.
        if (!quiet) { S.history = []; S.future = []; }
        renderPlan();
        regenerate();
    }

    function snapshot() { return JSON.stringify(S.plan); }

    // Every change to the plan goes through here, so it can be undone.
    function commit(change, { render = true } = {}) {
        S.history.push(snapshot());
        if (S.history.length > 100) S.history.shift();
        S.future = [];
        change();
        if (render) renderPlan();
        regenerate();
        document.dispatchEvent(new CustomEvent('xl:changed'));
    }

    // For live controls (colour pickers, number fields): one history step per edit.
    let pendingSnap = null;
    function beginEdit() { if (!pendingSnap) pendingSnap = snapshot(); }
    function endEdit() {
        if (!pendingSnap) return;
        S.history.push(pendingSnap);
        S.future = [];
        pendingSnap = null;
        document.dispatchEvent(new CustomEvent('xl:changed'));
    }

    function undo() {
        if (!S.history.length) return;
        S.future.push(snapshot());
        S.plan = JSON.parse(S.history.pop());
        renderPlan();
        regenerate();
        document.dispatchEvent(new CustomEvent('xl:changed'));
        setPlanStatus('Undone.');
    }
    function redo() {
        if (!S.future.length) return;
        S.history.push(snapshot());
        S.plan = JSON.parse(S.future.pop());
        renderPlan();
        regenerate();
        document.dispatchEvent(new CustomEvent('xl:changed'));
        setPlanStatus('Redone.');
    }
    $('planUndo').addEventListener('click', undo);
    $('planRedo').addEventListener('click', redo);
    document.addEventListener('keydown', e => {
        if (!S.tabVisible || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || dlg.open || copyDlg.open) return;
        const k = e.key.toLowerCase();
        if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    });

    function container(id) {
        if (id === 'whole') return S.plan.whole;
        if (!S.plan.sections[id]) S.plan.sections[id] = { rows: [], pool: [] };
        const c = S.plan.sections[id];
        c.pool = c.pool || [];
        return c;
    }

    let regenTimer = 0;
    function regenerate() {
        clearTimeout(regenTimer);
        regenTimer = setTimeout(() => {
            const song = XLWeb.song();
            if (!song || !S.show) return;
            S.gen = Sequencer.generate(previewPlan(), song, S.show);
            S.prep = Sequencer.prepare(S.show, S.gen, song);
            S.genVer = (S.genVer || 0) + 1;
            S.dirty = true;
            const probs = S.gen.problems.length ? ` "Singing face" only works on models with a face set up in xLights; skipped: ${S.gen.problems.join(', ')}.` : '';
            if (Date.now() - (S.statusAt || 0) > 400) setPlanStatus(S.gen.count ? `${S.gen.count.toLocaleString()} effects on ${S.gen.rows.size} rows${S.solo.size || S.mute.size ? ' in the preview' : ''}.${probs}` : 'Nothing planned yet. Open a section below and add lights, or press Suggest a plan.');
            updateSoloNote();
            showMissing();
            savePlan();
            $('planUndo').disabled = !S.history.length;
            $('planRedo').disabled = !S.future.length;
            scheduleFit();
        }, 60);
    }
    function setPlanStatus(m) { $('planStatus').textContent = m; S.statusAt = Date.now(); }

    // ---------- props the plan names but this show doesn't have ----------

    function planMissing() {
        const out = new Set();
        const check = rows => { for (const r of rows || []) for (const t of r.targets || []) if (!Show.hasTarget(S.show, t)) out.add(t); };
        check(S.plan.whole && S.plan.whole.rows);
        for (const c of Object.values(S.plan.sections || {})) check(c.rows);
        return [...out];
    }
    function showMissing() {
        const box = $('missingNote');
        const list = S.show && S.plan ? planMissing() : [];
        if (!list.length) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = `<span>⚠ <b>${list.length} prop${list.length > 1 ? 's' : ''} in this plan ${list.length > 1 ? "aren't" : "isn't"} in your show</b> (${list.slice(0, 4).map(esc).join(', ')}${list.length > 4 ? ', …' : ''}). ${list.length > 1 ? "They're" : "It's"} left out of the preview and the saved sequence, so xLights won't complain.</span> <button type="button" class="btn small primary">Fix…</button>`;
        box.querySelector('button').addEventListener('click', openMissing);
    }
    function openMissing() {
        const list = planMissing();
        const sh = S.show;
        const groups = [...sh.groups.keys()].sort((a, b) => a.localeCompare(b));
        const models = [...sh.models.keys()].sort((a, b) => a.localeCompare(b));
        // a likely match: same name ignoring case and spaces, else the same name after a number prefix
        const norm = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
        const guess = name => {
            const n = norm(name);
            return groups.concat(models).find(x => norm(x) === n) || groups.concat(models).find(x => n && (norm(x).endsWith(n) || n.endsWith(norm(x))) && norm(x).length > 3) || '';
        };
        const opts = sel => `<option value="">Leave it out</option><optgroup label="Groups">${groups.map(g => `<option ${g === sel ? 'selected' : ''}>${esc(g)}</option>`).join('')}</optgroup><optgroup label="Props">${models.map(m => `<option ${m === sel ? 'selected' : ''}>${esc(m)}</option>`).join('')}</optgroup>`;
        $('missingTable').innerHTML = '<tr><th>In the plan</th><th>Use instead</th></tr>' + list.map((n, i) => `<tr><td>${esc(n)}</td><td><select data-i="${i}">${opts(guess(n))}</select></td></tr>`).join('');
        $('missingCount').textContent = `${list.length} missing`;
        $('missingDlg')._list = list;
        $('missingDlg').showModal();
    }
    $('missingCancel').addEventListener('click', () => $('missingDlg').close());
    $('missingApply').addEventListener('click', () => {
        const list = $('missingDlg')._list || [];
        const map = new Map();
        $('missingTable').querySelectorAll('select').forEach(sel => map.set(list[+sel.dataset.i], sel.value));
        const fix = rows => rows
            .map(r => ({ ...r, targets: [...new Set(r.targets.map(t => (map.has(t) ? map.get(t) : t)).filter(Boolean))] }))
            .filter(r => r.targets.length);
        commit(() => {
            S.plan.whole.rows = fix(S.plan.whole.rows);
            for (const c of Object.values(S.plan.sections)) {
                c.rows = fix(c.rows);
                if (c.pool) c.pool = [...new Set(c.pool.map(t => (map.has(t) ? map.get(t) : t)).filter(Boolean))];
            }
        });
        $('missingDlg').close();
        const swapped = [...map.values()].filter(Boolean).length;
        setPlanStatus(`Fixed: ${swapped} swapped for props in your show, ${map.size - swapped} left out.`);
    });

    // ---------- fit with the music ----------
    //
    // Measured on the full plan (not solo/mute), a moment after the last change.

    let fitTimer = 0, fitSignal = null;
    function scheduleFit() {
        clearTimeout(fitTimer);
        if (fitSignal) fitSignal.cancelled = true;
        fitTimer = setTimeout(async () => {
            const song = XLWeb.song();
            if (!song || !S.show || !S.plan) return;
            const sig = fitSignal = {};
            const r = await Fit.measure(S.plan, song, S.show, sig);
            if (sig.cancelled) return;
            S.fit = r;
            renderFit();
        }, 700);
    }

    const fitMeter = (v, label, tip) => `<span class="fit-part" title="${esc(tip)}">${esc(label)} <span class="meter${v < 0.35 ? ' low' : ''}"><span style="width:${Math.round(v * 100)}%"></span></span></span>`;
    function renderFit() {
        const box = $('fitBox');
        const r = S.fit;
        if (!r) { box.hidden = true; return; }
        box.hidden = false;
        const weak = [];
        if (r.loud < 0.35) weak.push('the lights barely follow how loud the song is');
        if (r.beat < 0.35) weak.push('the beat hardly shows: give one or two props a hit on the beat over a steady base');
        if (r.lift < 0.35) weak.push('the loud parts are not brighter than the quiet ones: light more props, brighter, in choruses');
        const parts = r.raw.parts.map(p => `<tr><td>${esc(p.name)}</td><td><span class="meter"><span style="width:${Math.round(p.energy * 100)}%"></span></span></td><td><span class="meter"><span style="width:${Math.round(Math.min(1, p.bright * 2.5) * 100)}%"></span></span></td></tr>`).join('');
        box.innerHTML = `<span class="fit-score" title="How well the lights follow the music, 0-100">Fit with the music: ${r.score}</span>
            ${fitMeter(r.loud, 'Follows loudness', 'Does the house get brighter when the song gets louder?')}
            ${fitMeter(r.beat, 'On the beat', 'Do the lights change more on the beat than between beats?')}
            ${fitMeter(r.lift, 'Loud parts brighter', 'Are the loud parts (choruses) brighter than the quiet ones?')}
            ${weak.length ? `<span class="muted">Weakest: ${esc(weak[0])}.</span>` : ''}
            <details><summary>Per part: loudness vs brightness</summary><table><tr><th>Part</th><th>Loudness</th><th>Brightness</th></tr>${parts}</table></details>`;
    }

    // Solo / mute are for looking only: the preview leaves rows out, the saved
    // sequence never does.
    S.solo = new Set();
    S.mute = new Set();
    S.rowOpen = new Set();
    function previewPlan() {
        if (!S.solo.size && !S.mute.size) return S.plan;
        const keep = r => S.solo.size ? S.solo.has(r.id) : !S.mute.has(r.id);
        const p = { ...S.plan, whole: { ...S.plan.whole, rows: S.plan.whole.rows.filter(keep) }, sections: {} };
        for (const [id, c] of Object.entries(S.plan.sections)) p.sections[id] = { ...c, rows: c.rows.filter(keep) };
        return p;
    }
    function updateSoloNote() {
        const el = $('pvSolo');
        if (!S.solo.size && !S.mute.size) { el.hidden = true; return; }
        el.hidden = false;
        el.innerHTML = (S.solo.size ? `Showing only ${S.solo.size} soloed row${S.solo.size > 1 ? 's' : ''}` : `${S.mute.size} row${S.mute.size > 1 ? 's' : ''} muted`) +
            ' in the preview (the saved sequence has everything). <button type="button" class="link" id="soloClear">Show all</button>';
        $('soloClear').addEventListener('click', () => { S.solo.clear(); S.mute.clear(); renderPlan(); regenerate(); });
    }

    document.addEventListener('xl:song', () => {
        if (!S.show) return;
        const song = XLWeb.song();
        if (song && song.hash !== S.planHash) { S.history = []; S.future = []; S.ideaSel = undefined; loadPlan(); }
        renderParts(); renderPlan(); regenerate();
    });
    document.addEventListener('xl:lyrics', () => { if (S.show) { renderPlan(); regenerate(); } });

    // Sections were split / joined / reset on the first tab: carry the lights along.
    document.addEventListener('xl:sections', e => {
        const d = e.detail || {};
        if (!S.plan) return;
        if (d.op === 'split' && S.plan.sections[d.from]) {
            const src = S.plan.sections[d.from];
            S.plan.sections[d.to] = { rows: Sequencer.cloneRows(src.rows), pool: (src.pool || []).slice() };
            if (S.open.has(d.from)) S.open.add(d.to);
        } else if (d.op === 'merge') {
            delete S.plan.sections[d.removed];
        } else if (d.op === 'reset') {
            const song = XLWeb.song();
            const ids = new Set(song ? song.sections.map(s => s.id) : []);
            for (const k of Object.keys(S.plan.sections)) if (!ids.has(k)) delete S.plan.sections[k];
        }
        savePlan();
    });

    // ---------- the plan: drawing ----------

    const LABELS = {
        fadeIn: 'Fade in (s)', fadeOut: 'Fade out (s)', cycles: 'Cycles', direction: 'Direction', chases: 'Chases', rotations: 'Passes',
        size: 'Length %', bars: 'Bars', count: 'Count', rotation: 'Twist', thickness: 'Thickness', arms: 'Arms', speed: 'Speed',
        twist: 'Twist', steps: 'Speed (frames)', width: 'Width', band: 'Band', skip: 'Gap', face: 'Face',
        start: 'Start %', end: 'End %',
    };

    function effectsFor(trigger) {
        const t = Sequencer.TRIGGERS.find(x => x.id === trigger) || Sequencer.TRIGGERS[0];
        if (t.id === 'span') return Effects.LIST.filter(e => e.use.includes('part'));
        if (t.vocal) return Effects.LIST.filter(e => e.use.includes('vocal') || e.use.includes('hit'));
        return Effects.LIST.filter(e => e.use.includes('hit'));
    }

    function newRow() {
        const s = Effects.SCHEMES.find(x => x.id === (S.plan.ideaScheme || 'christmas')) || Effects.SCHEMES[0];
        return { id: Sequencer.newId(), trigger: 'span', targets: [], effect: 'chase', options: {}, colors: s.colors.slice(), scheme: s.id };
    }

    function summary(c) {
        if (!c.rows.length) return '<i>no lights yet</i>';
        const parts = c.rows.slice(0, 4).map(r => {
            const e = Effects.get(r.effect);
            const trig = r.trigger && r.trigger !== 'span' ? ` (${(Sequencer.TRIGGERS.find(t => t.id === r.trigger) || {}).label || r.trigger})` : '';
            const tg = r.targets.length ? r.targets.slice(0, 2).join(', ') + (r.targets.length > 2 ? ` +${r.targets.length - 2}` : '') : 'no lights chosen';
            return `<span class="chip"><b>${esc(e ? e.label : r.effect)}</b>${esc(trig)} · ${esc(tg)}</span>`;
        });
        return parts.join(' ') + (c.rows.length > 4 ? ` <span class="muted">+${c.rows.length - 4} more</span>` : '');
    }

    // someone is typing or choosing in the plan: don't redraw under them
    function planBusy() {
        const a = document.activeElement;
        return !!(a && $('plan').contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox');
    }

    function renderPlan() {
        const box = $('plan');
        const song = XLWeb.song();
        if (!S.show || !song || !S.plan) { box.innerHTML = ''; return; }
        // header controls
        if (S.hl) setHighlight(null);
        renderExclude();
        renderMixNote();
        const sel = $('ideaScheme');
        sel.innerHTML = Effects.SCHEMES.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
        sel.value = Effects.SCHEMES.some(s => s.id === S.plan.ideaScheme) ? S.plan.ideaScheme : Effects.SCHEMES[0].id;
        const fsel = $('ideaFeel');
        if (!fsel.options.length) fsel.innerHTML = Object.entries(Ideas.FEELS).map(([id, f]) => `<option value="${id}">${esc(f.label)}</option>`).join('');
        fsel.value = S.plan.ideaFeel || 'auto';
        const isel = $('ideaIntensity');
        if (!isel.options.length) isel.innerHTML = Ideas.INTENSITIES.map(x => `<option value="${x.id}">${esc(x.label)}</option>`).join('');
        isel.value = S.plan.ideaIntensity || 'auto';
        $('ideaMatrixWords').checked = !!S.plan.ideaMatrixWords;
        $('ideaPhrased').checked = S.plan.ideaPhrased !== false;
        $('ideaAlike').checked = !!S.plan.ideaAlike;
        $('onlyNow').checked = !!S.onlyNow;
        $('goSection').innerHTML = '<option value="">Go to a section…</option>' + song.sections.map(s => `<option value="${s.id}">${esc(s.name)} (${fmt(s.s)})</option>`).join('');
        $('planUndo').disabled = !S.history.length;
        $('planRedo').disabled = !S.future.length;
        renderIdeaFor();

        box.innerHTML = '';
        if (S.onlyNow) {
            const t = XLWeb.time();
            const cur = song.sections.find(s => s.id === S.nowId) || song.sections.find(s => t >= s.s && t < s.e) || song.sections[0];
            S.shownId = cur ? cur.id : null;
            const note = document.createElement('div');
            note.className = 'only-now-note';
            note.innerHTML = `<span>Showing only <b>${esc(cur ? cur.name : '')}</b>, the part that's playing. It follows the song; use ⏮ ⏭ under the preview or <i>Go to a section</i> to move.</span><button type="button" class="link">Show all parts</button>`;
            note.querySelector('button').addEventListener('click', () => { S.onlyNow = false; $('onlyNow').checked = false; try { localStorage.setItem('xlweb-onlynow', '0'); } catch (e) { /* storage blocked */ } renderPlan(); });
            box.appendChild(note);
            if (cur) { S.open.add(cur.id); box.appendChild(card(cur, false)); }
            return;
        }
        box.appendChild(card({ id: 'whole', name: 'Whole song', s: 0, e: song.model.duration }, true));
        for (const s of song.sections) box.appendChild(card(s, false));
    }

    function card(sec, isWhole) {
        const c = isWhole ? S.plan.whole : (S.plan.sections[sec.id] || { rows: [], pool: [] });
        const open = S.open.has(sec.id);
        const el = document.createElement('section');
        el.className = 'sec-card' + (open ? ' open' : '') + (S.nowId === sec.id ? ' now' : '') + (ideaPicked(isWhole ? 'whole' : sec.id) ? ' idea-on' : '');
        el.dataset.id = sec.id;
        const energy = sec.energy != null ? `<span class="meter" title="Energy"><span style="width:${Math.round(sec.energy * 100)}%"></span></span>` : '';
        el.innerHTML = `
            <div class="sec-head">
              <button type="button" class="tw" aria-expanded="${open}" title="${open ? 'Collapse' : 'Expand'}">${open ? '▾' : '▸'}</button>
              <label class="idea-pick" title="Ticked: 🎲 Another idea changes this part (rows you untick inside it are kept)"><input type="checkbox" class="ipick" ${ideaPicked(isWhole ? 'whole' : sec.id) ? 'checked' : ''}> 🎲</label>
              <div class="sec-title">
                <b>${esc(sec.name)}</b>
                ${!isWhole && c.transition && c.transition !== 'cut' ? `<span class="tr-chip" title="How this part comes in (change it inside the part)">↗ ${esc((Ideas.TRANSITIONS.find(t => t[0] === c.transition) || [, c.transition])[1].replace(/ \(.*\)$/, ''))}</span>` : ''}
                <span class="muted">${isWhole ? 'under every section' : `${fmt(sec.s)}–${fmt(sec.e)}${sec.bars ? ` · ${sec.bars} bars` : ''}`}</span>
                ${energy}
              </div>
              <div class="sec-btns">
                ${isWhole ? '' : '<button type="button" class="btn tiny jump" title="Jump the song to this section">▶ Jump</button>'}
                ${isWhole ? '' : `<button type="button" class="btn tiny loop${S.loopId === sec.id ? ' on' : ''}" aria-pressed="${S.loopId === sec.id}" title="Play this section over and over while you change it">🔁 Loop</button>`}
                ${isWhole ? '' : '<button type="button" class="btn tiny rnd" title="Give this section a random set of lights (from its chosen lights, if any). Press again for another idea; Undo goes back.">🎲 Randomize</button>'}
                ${isWhole ? '' : '<button type="button" class="btn tiny copy" title="Copy these lights to other sections">Copy to…</button>'}
                <button type="button" class="btn tiny recol" title="Change only the colours of these lights">🎨</button>
              </div>
            </div>
            <div class="sec-sum">${summary(c)}</div>
            <div class="sec-body" ${open ? '' : 'hidden'}></div>`;
        const tw = el.querySelector('.tw');
        const toggle = () => {
            if (S.open.has(sec.id)) S.open.delete(sec.id); else S.open.add(sec.id);
            saveOpen();
            renderPlan();
        };
        tw.addEventListener('click', toggle);
        el.querySelector('.ipick').addEventListener('change', e => setIdeaPicked(isWhole ? 'whole' : sec.id, e.target.checked));
        el.querySelector('.sec-title').addEventListener('click', toggle);
        el.querySelector('.recol').addEventListener('click', () => openRecolour([isWhole ? 'whole' : sec.id]));
        if (!isWhole) {
            el.querySelector('.jump').addEventListener('click', () => { if (S.loopId) setLoop(sec.id); XLWeb.seek(sec.s + 0.001); S.dirty = true; });
            el.querySelector('.loop').addEventListener('click', () => {
                if (S.loopId === sec.id) { setLoop(null); return; }
                loopSection(sec);
            });
            el.querySelector('.rnd').addEventListener('click', () => randomizeSection(sec));
            el.querySelector('.copy').addEventListener('click', () => openCopy(sec));
        }
        if (open) fillBody(el.querySelector('.sec-body'), sec, isWhole);
        return el;
    }

    function fillBody(body, sec, isWhole) {
        const id = isWhole ? 'whole' : sec.id;
        const c = isWhole ? S.plan.whole : container(id);
        if (!isWhole) {
            const pool = document.createElement('div');
            pool.className = 'pool';
            pool.innerHTML = `<span class="muted">Lights to use when randomizing:</span> <span class="tlist">${c.pool.length ? c.pool.map(esc).join(', ') : 'any of your props'}</span> <button type="button" class="btn tiny">Choose…</button>${c.pool.length ? ' <button type="button" class="btn tiny clr">Any</button>' : ''}`;
            pool.querySelector('.btn').addEventListener('click', () => openPicker(c, 'pool', `Lights to randomize in ${sec.name}`));
            const clr = pool.querySelector('.clr');
            if (clr) clr.addEventListener('click', () => commit(() => { c.pool = []; }));
            body.appendChild(pool);
        }
        for (const r of c.rows) body.appendChild(rowEditor(r, c));
        const foot = document.createElement('div');
        foot.className = 'btnrow tight';
        foot.innerHTML = `<button type="button" class="btn small add">+ Add lights</button>${!isWhole ? `<button type="button" class="btn small splitHere" title="Split this section where the song is now">Split at playhead</button><button type="button" class="btn small ren">Rename</button>` : ''}${c.rows.length ? '<button type="button" class="btn small clearSec">Clear</button>' : ''}${!isWhole ? `<label class="chk small" title="The lights of this part stop 1.5 beats before it ends, so the next part lands on a dark house"><input type="checkbox" class="dipChk" ${c.dip > 0 ? 'checked' : ''}> Hold a breath at the end</label>` : ''}`;
        const dip = foot.querySelector('.dipChk');
        if (dip) dip.addEventListener('change', () => commit(() => { if (dip.checked) c.dip = 1.5; else delete c.dip; }));
        // how this part comes in from the one before it
        const songNow = XLWeb.song();
        const idx = !isWhole && songNow ? songNow.sections.findIndex(x => x.id === sec.id) : -1;
        if (idx > 0) {
            const prevSec = songNow.sections[idx - 1];
            const cur = c.transition || 'cut';
            foot.insertAdjacentHTML('beforeend', `<label class="small tr-pick" title="How this part takes over from ${esc(prevSec.name)}">Comes in with <select class="trSel">${Ideas.TRANSITIONS.map(([id, label]) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`);
            foot.querySelector('.trSel').addEventListener('change', e => {
                const move = e.target.value;
                commit(() => {
                    container(prevSec.id); container(sec.id);
                    Ideas.applyTransition(S.plan, songNow, prevSec, sec, move, { props: Ideas.transitionProps(S.show), scheme: ideaScheme() });
                });
                setPlanStatus(`${sec.name} now comes in with: ${(Ideas.TRANSITIONS.find(t => t[0] === move) || [])[1]}.`);
            });
        }
        foot.querySelector('.add').addEventListener('click', () => {
            const r = newRow();
            S.rowOpen.add(r.id);
            commit(() => { (isWhole ? S.plan.whole : container(id)).rows.push(r); });
            const rr = (isWhole ? S.plan.whole : container(id)).rows.find(x => x.id === r.id);
            openPicker(rr, 'targets', 'Choose lights');
        });
        const sp = foot.querySelector('.splitHere');
        if (sp) sp.addEventListener('click', () => {
            const t = XLWeb.time();
            if (!(t > sec.s + 0.2 && t < sec.e - 0.2)) { setPlanStatus(`Move the song inside "${sec.name}" first (play or click the strip above), then split.`); return; }
            S.history.push(snapshot());
            const right = XLWeb.splitSection(sec.id, t);
            if (right) { S.open.add(right.id); saveOpen(); setPlanStatus(`Split "${sec.name}"; the new part "${right.name}" starts with the same lights. Change either one.`); }
        });
        const rn = foot.querySelector('.ren');
        if (rn) rn.addEventListener('click', () => {
            const name = prompt('Name for this section', sec.name);
            if (name && name.trim()) XLWeb.renameSection(sec.id, name.trim());
        });
        const cl = foot.querySelector('.clearSec');
        if (cl) cl.addEventListener('click', () => commit(() => { c.rows = []; }));
        body.appendChild(foot);
    }

    function rowEditor(r, c) {
        const el = document.createElement('div');
        el.className = 'plan-row';
        el.dataset.row = r.id;
        const song = XLWeb.song();
        const haveWords = !!(song && song.lyr);
        r.trigger = r.trigger || 'span';
        const effs = effectsFor(r.trigger);
        if (!effs.some(e => e.id === r.effect)) r.effect = effs[0].id;
        const eff = Effects.get(r.effect);
        const targetsTxt = r.targets.length ? r.targets.map(esc).join(', ') : '<i>no lights chosen</i>';
        const schemeOpts = Effects.SCHEMES.map(s => `<option value="${s.id}" ${r.scheme === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('') + `<option value="custom" ${r.scheme === 'custom' ? 'selected' : ''}>Custom</option>`;
        const trigOpts = Sequencer.TRIGGERS.map(t => `<option value="${t.id}" ${t.id === r.trigger ? 'selected' : ''} ${t.vocal && !haveWords ? 'disabled' : ''}>${esc(t.label)}${t.vocal && !haveWords ? ' (find words first)' : ''}</option>`).join('');
        const open = S.rowOpen.has(r.id);
        const soloed = S.solo.has(r.id), muted = S.mute.has(r.id);
        const hidden = muted || (S.solo.size && !soloed);
        const trigLabel = r.trigger !== 'span' ? (Sequencer.TRIGGERS.find(t => t.id === r.trigger) || {}).label : '';
        const tShort = r.targets.length ? r.targets.slice(0, 3).join(', ') + (r.targets.length > 3 ? ` +${r.targets.length - 3}` : '') : 'no lights chosen';
        el.classList.toggle('open', open);
        el.classList.toggle('dim', !!hidden);
        el.classList.toggle('kept', !!r.keep);
        el.innerHTML = `
            <div class="row-line">
              <input type="checkbox" class="rkeep" ${r.keep ? '' : 'checked'} title="Ticked: randomizing may replace this row. Untick to keep it as it is.">
              <button type="button" class="rtw" aria-expanded="${open}" title="${open ? 'Hide settings' : 'Show settings'}">${open ? '▾' : '▸'}</button>
              <span class="rl-text"><b>${esc(eff.label)}</b> · ${esc(tShort)}${trigLabel ? ` · <span class="muted">${esc(trigLabel)}</span>` : ''}${r.level != null && r.level !== 100 ? ` · <span class="muted" title="Brightness">${r.level}%</span>` : ''}${r.bars ? ` · <span class="muted" title="Only these bars of the part">bars ${r.bars[0] + 1}–${r.bars[1] >= 9999 ? 'end' : r.bars[1]}</span>` : ''}</span>
              <span class="rl-sw">${r.colors.map(col => `<i style="background:${col}"></i>`).join('')}</span>
              <button type="button" class="btn tiny solo${soloed ? ' on' : ''}" aria-pressed="${soloed}" title="Solo: show only this row in the preview">Solo</button>
              <button type="button" class="btn tiny mute${muted ? ' on' : ''}" aria-pressed="${muted}" title="Mute: hide this row in the preview (it is still saved)">Mute</button>
            </div>
            <div class="row-detail" ${open ? '' : 'hidden'}>
            <div class="pr-targets"><button type="button" class="btn small pick">Lights…</button> <span class="tlist">${targetsTxt}</span></div>
            <div class="pr-fx">
              <label>When <select class="trig">${trigOpts}</select></label>
              <label>Effect <select class="eff">${effs.map(e => `<option value="${e.id}" ${e.id === r.effect ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}</select></label>
              <label>Colours <select class="scheme">${schemeOpts}</select></label>
              <span class="swatches">${r.colors.map((col, i) => `<input type="color" value="${col}" data-i="${i}" aria-label="Colour ${i + 1}">`).join('')}${r.colors.length < 6 ? '<button type="button" class="btn tiny addc" title="Add a colour">+</button>' : ''}${r.colors.length > 1 ? '<button type="button" class="btn tiny delc" title="Remove the last colour">−</button>' : ''}</span>
              <span class="opts"></span>
              <label title="Only part of the section: from this bar to that bar (empty = the whole part)">Bars <span class="bars-in"><input type="number" class="bfrom" min="1" step="1" value="${r.bars ? r.bars[0] + 1 : ''}" placeholder="1"> to <input type="number" class="bto" min="1" step="1" value="${r.bars && r.bars[1] < 9999 ? r.bars[1] : ''}" placeholder="end"></span></label>
              ${eff.id !== 'faces' ? `<label title="How bright this row is (xLights' Brightness slider)">Brightness % <input type="number" class="lvl" min="0" max="100" step="5" value="${r.level ?? 100}"></label>` : ''}
              ${eff.id !== 'faces' && r.trigger === 'span' && eff.id !== 'on' ? `<label title="Fade out over the last seconds of the row (e.g. when the song fades)">Fade at end (s) <input type="number" class="efade" min="0" step="0.5" value="${r.endFade || 0}"></label>` : ''}
              ${r.targets.some(t => S.show.groups.has(t)) && !eff.use.includes('vocal') ? `<label class="chk permodel" title="On: each model in the group gets the effect separately. Off: the effect spans the whole group, across the yard."><input type="checkbox" class="pm" ${(r.perModel ?? eff.perModel) ? 'checked' : ''}> Each model on its own</label>` : ''}
              <span class="row-btns"><button type="button" class="btn small dup" title="Duplicate">Duplicate</button><button type="button" class="btn small del" title="Remove">Remove</button></span>
            </div>
            </div>`;

        // the one-line view: open/close, solo, mute; hovering shows its props on the house
        // Open/close in place: no full redraw, so it cannot be undone by anything else
        // the redraw does.
        const flip = () => {
            const nowOpen = !S.rowOpen.has(r.id);
            if (nowOpen) S.rowOpen.add(r.id); else S.rowOpen.delete(r.id);
            el.querySelector('.row-detail').hidden = !nowOpen;
            el.classList.toggle('open', nowOpen);
            const tw = el.querySelector('.rtw');
            tw.textContent = nowOpen ? '▾' : '▸';
            tw.setAttribute('aria-expanded', String(nowOpen));
            tw.title = nowOpen ? 'Hide settings' : 'Show settings';
        };
        el.querySelector('.rtw').addEventListener('click', flip);
        el.querySelector('.rkeep').addEventListener('change', e => {
            const keep = !e.target.checked;
            commit(() => { if (keep) r.keep = true; else delete r.keep; }, { render: false });
            el.classList.toggle('kept', keep);
        });
        el.querySelector('.rl-text').addEventListener('click', flip);
        el.querySelector('.solo').addEventListener('click', () => { if (soloed) S.solo.delete(r.id); else S.solo.add(r.id); renderPlan(); regenerate(); });
        el.querySelector('.mute').addEventListener('click', () => { if (muted) S.mute.delete(r.id); else S.mute.add(r.id); renderPlan(); regenerate(); });
        el.addEventListener('mouseenter', () => setHighlight(r.targets));
        el.addEventListener('mouseleave', () => setHighlight(null));

        const opts = el.querySelector('.opts');
        for (const [k, def] of Object.entries(eff.options)) {
            const val = r.options[k] ?? def;
            if (k === 'face') {
                const m = r.targets.map(t => S.show.models.get(t)).find(mm => mm && mm.faces.length);
                const faces = m ? m.faces.map(f => f.name) : [];
                if (!faces.length) continue;
                opts.insertAdjacentHTML('beforeend', `<label>${LABELS[k]} <select data-k="${k}">${faces.map(f => `<option ${f === val ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>`);
            } else if (eff.choices && eff.choices[k]) {
                opts.insertAdjacentHTML('beforeend', `<label>${LABELS[k] || k} <select data-k="${k}">${eff.choices[k].map(x => `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`);
            } else {
                const label = k === 'size' && eff.id === 'lyrictext' ? 'Text size' : (LABELS[k] || k);
                opts.insertAdjacentHTML('beforeend', `<label>${label} <input type="number" data-k="${k}" value="${val}" step="${typeof def === 'number' && def % 1 !== 0 ? 0.1 : 1}"></label>`);
            }
        }
        el.querySelector('.pick').addEventListener('click', () => openPicker(r, 'targets', 'Choose lights'));
        el.querySelector('.trig').addEventListener('change', e => commit(() => {
            r.trigger = e.target.value;
            const list = effectsFor(r.trigger);
            if (!list.some(x => x.id === r.effect)) { r.effect = list[0].id; r.options = {}; }
        }));
        el.querySelector('.eff').addEventListener('change', e => commit(() => { r.effect = e.target.value; r.options = {}; delete r.perModel; }));
        el.querySelector('.scheme').addEventListener('change', e => commit(() => {
            r.scheme = e.target.value;
            const s = Effects.SCHEMES.find(x => x.id === r.scheme);
            if (s) r.colors = s.colors.slice();
        }));
        el.querySelectorAll('input[type=color]').forEach(inp => {
            inp.addEventListener('input', e => {
                beginEdit();
                r.colors[+e.target.dataset.i] = e.target.value.toUpperCase();
                r.scheme = 'custom';
                el.querySelector('.scheme').value = 'custom';
                regenerate();
            });
            inp.addEventListener('change', () => { endEdit(); renderPlan(); });
        });
        const addc = el.querySelector('.addc');
        if (addc) addc.addEventListener('click', () => commit(() => { r.colors.push('#FFFFFF'); r.scheme = 'custom'; }));
        const delc = el.querySelector('.delc');
        if (delc) delc.addEventListener('click', () => commit(() => { r.colors.pop(); r.scheme = 'custom'; }));
        opts.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', e => commit(() => {
            const k = e.target.dataset.k;
            r.options[k] = e.target.tagName === 'SELECT' ? e.target.value : parseFloat(e.target.value);
        }, { render: false })));
        el.querySelector('.del').addEventListener('click', () => commit(() => { c.rows = c.rows.filter(x => x !== r); }));
        el.querySelector('.dup').addEventListener('click', () => commit(() => { c.rows.splice(c.rows.indexOf(r) + 1, 0, Sequencer.cloneRows([r])[0]); }));
        const lvl = el.querySelector('.lvl');
        if (lvl) lvl.addEventListener('change', () => commit(() => {
            const v = Math.max(0, Math.min(100, parseFloat(lvl.value) || 0));
            if (v === 100) delete r.level; else r.level = v;
        }));
        const setBars = () => commit(() => {
            const f = parseInt(el.querySelector('.bfrom').value, 10), t = parseInt(el.querySelector('.bto').value, 10);
            if (!(f > 1) && !(t > 0)) { delete r.bars; return; }
            const b0 = f > 1 ? f - 1 : 0, b1 = t > 0 ? Math.max(b0 + 1, t) : 9999;
            r.bars = [b0, b1];
        });
        el.querySelector('.bfrom').addEventListener('change', setBars);
        el.querySelector('.bto').addEventListener('change', setBars);
        const efade = el.querySelector('.efade');
        if (efade) efade.addEventListener('change', () => commit(() => {
            const v = Math.max(0, parseFloat(efade.value) || 0);
            if (v) r.endFade = v; else delete r.endFade;
        }, { render: false }));
        const pm = el.querySelector('.pm');
        if (pm) pm.addEventListener('change', () => commit(() => { r.perModel = pm.checked; }, { render: false }));
        return el;
    }

    $('expandAll').addEventListener('click', () => {
        const song = XLWeb.song();
        if (!song) return;
        S.open = new Set(['whole', ...song.sections.map(s => s.id)]);
        saveOpen();
        renderPlan();
    });
    $('collapseAll').addEventListener('click', () => { S.open = new Set(); saveOpen(); renderPlan(); });
    $('goSection').addEventListener('change', e => { if (e.target.value) goToSection(e.target.value); e.target.value = ''; });
    $('ideaScheme').addEventListener('change', e => { S.plan.ideaScheme = e.target.value; savePlan(); });
    $('ideaFeel').addEventListener('change', e => { S.plan.ideaFeel = e.target.value; savePlan(); });
    $('ideaIntensity').addEventListener('change', e => { S.plan.ideaIntensity = e.target.value; savePlan(); });
    const ideaMood = () => ({
        feel: S.plan.ideaFeel || 'auto',
        intensity: (Ideas.INTENSITIES.find(x => x.id === (S.plan.ideaIntensity || 'auto')) || {}).value ?? null,
        exclude: S.plan.ideaExclude || [],
        mix: S.plan.ideaMix || null,
        matrixWords: !!S.plan.ideaMatrixWords,
        phrased: S.plan.ideaPhrased !== false,
    });
    $('ideaMatrixWords').addEventListener('change', e => { S.plan.ideaMatrixWords = e.target.checked; savePlan(); });
    $('ideaPhrased').addEventListener('change', e => { S.plan.ideaPhrased = e.target.checked; savePlan(); });
    $('ideaAlike').addEventListener('change', e => { S.plan.ideaAlike = e.target.checked; savePlan(); });

    // Idea settings fold away to save room; remembered in this browser.
    try { $('ideaSettings').open = localStorage.getItem('xlweb-ideasettings') !== '0'; } catch (e) { $('ideaSettings').open = true; }
    $('ideaSettings').addEventListener('toggle', () => { try { localStorage.setItem('xlweb-ideasettings', $('ideaSettings').open ? '1' : '0'); } catch (e) { /* storage blocked */ } });

    // Only the part that's playing: the list shows just that part, opened, and
    // follows the song. A change made while typing waits until the field is left.
    try { S.onlyNow = localStorage.getItem('xlweb-onlynow') === '1'; } catch (e) { S.onlyNow = false; }
    $('onlyNow').addEventListener('change', e => {
        S.onlyNow = e.target.checked;
        try { localStorage.setItem('xlweb-onlynow', S.onlyNow ? '1' : '0'); } catch (err) { /* storage blocked */ }
        renderPlan();
    });
    $('plan').addEventListener('focusout', () => { if (S.planStale) setTimeout(() => { if (S.planStale && !planBusy()) { S.planStale = false; renderPlan(); } }, 0); });

    // ---------- prop mix ----------

    const mixDlg = $('mixDlg');
    const MIX_LABEL = { never: 'Never', less: 'Less', normal: 'Normal', more: 'More', always: 'Always' };

    function mixData() {
        S.plan.ideaMix = S.plan.ideaMix || { extras: [], levels: {} };
        S.plan.ideaMix.extras = S.plan.ideaMix.extras || [];
        S.plan.ideaMix.levels = S.plan.ideaMix.levels || {};
        return S.plan.ideaMix;
    }

    function drawMix() {
        const song = XLWeb.song();
        const mix = mixData();
        const kinds = [...new Set(song.sections.map(s => Sequencer.kindOf(s.name)))];
        const excluded = new Set();
        const entries = Ideas.mixEntries(S.show, excluded, mix);
        const cell = (key, col) => {
            const l = mix.levels[key] || {};
            const v = l[col] || (col === '*' ? 'normal' : '');
            const opts = (col === '*' ? [] : [['', '·']]).concat(Ideas.LEVELS.map(x => [x, MIX_LABEL[x]]));
            const shown = v || l['*'] || 'normal';
            return `<td><select class="mix-sel lv-${shown}${v ? '' : ' inherit'}" data-key="${esc(key)}" data-col="${esc(col)}" aria-label="${esc(col === '*' ? 'every part' : col)}">${opts.map(([val, lab]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${lab}</option>`).join('')}</select></td>`;
        };
        $('mixTable').innerHTML = `<thead><tr><th>Prop</th><th>Every part</th>${kinds.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>` +
            entries.map(e => `<tr><th class="mix-prop" title="${esc(e.targets.join(', '))}">${esc(e.label)}${e.extra ? ` <button type="button" class="link mix-del" data-t="${esc(e.targets[0])}" title="Take it out of the mix">✕</button>` : ''}<span class="muted small">${e.extra ? '' : esc(e.targets.length > 1 ? `${e.targets.length} models` : e.targets[0])}${e.hiddenByDefault ? ' · only if set' : ''}</span></th>${cell(e.key, '*')}${kinds.map(k => cell(e.key, k)).join('')}</tr>`).join('') + '</tbody>';
        $('mixTable').querySelectorAll('.mix-sel').forEach(sel => sel.addEventListener('change', () => {
            commit(() => {
                const m = mixData();
                const l = m.levels[sel.dataset.key] = m.levels[sel.dataset.key] || {};
                if (sel.value && !(sel.dataset.col === '*' && sel.value === 'normal')) l[sel.dataset.col] = sel.value;
                else delete l[sel.dataset.col];
                if (!Object.keys(l).length) delete m.levels[sel.dataset.key];
            }, { render: false });
            drawMix();
            renderMixNote();
        }));
        $('mixTable').querySelectorAll('.mix-del').forEach(b => b.addEventListener('click', () => {
            commit(() => {
                const m = mixData();
                m.extras = m.extras.filter(t => t !== b.dataset.t);
                delete m.levels['target:' + b.dataset.t];
            }, { render: false });
            drawMix();
            renderMixNote();
        }));
    }

    function renderMixNote() {
        const mix = S.plan && S.plan.ideaMix;
        const n = mix ? Object.keys(mix.levels || {}).length : 0;
        $('mixBtn').classList.toggle('on', n > 0);
        $('mixBtn').textContent = n ? `Prop mix (${n} set)…` : 'Prop mix…';
    }

    $('mixBtn').addEventListener('click', () => { drawMix(); mixDlg.showModal(); });

    // ---------- prop types: what a prop is, when its name doesn't say ----------

    const typesKey = () => 'xlweb-proptypes:' + (S.show ? S.show.folderName : '');
    function loadPropTypes() {
        let v = {};
        try { v = JSON.parse(localStorage.getItem(typesKey()) || '{}') || {}; } catch (e) { v = {}; }
        S.show.propTypes = v;
        markTypesBtn();
    }
    function savePropTypes() {
        try { localStorage.setItem(typesKey(), JSON.stringify(S.show.propTypes || {})); } catch (e) { /* storage blocked */ }
        markTypesBtn();
    }
    function markTypesBtn() {
        const n = Object.keys((S.show && S.show.propTypes) || {}).length;
        $('typesBtn').textContent = n ? `Prop types (${n} set)…` : 'Prop types…';
    }
    const TYPE_CHOICES = ['megatree', 'minitree', 'arch', 'cane', 'spinner', 'wreath', 'snowflake', 'star', 'matrix', 'cross', 'peace', 'window', 'flood', 'roof', 'generic', 'skip'];
    function drawTypes() {
        const sh = S.show;
        const find = $('typesFind').value.trim().toLowerCase();
        const onlyUnknown = $('typesUnknown').checked;
        const label = c => Ideas.CLASS_LABELS[c] || c;
        const row = (name, kind) => {
            const guess = Ideas.guessClass(sh, name);
            if (guess === 'face') return '';
            const set = sh.propTypes[name] || '';
            if (onlyUnknown && guess !== 'generic' && !set) return '';
            if (find && !name.toLowerCase().includes(find)) return '';
            return `<tr><td>${esc(name)}<div class="muted small">${esc(kind)}</div></td><td><select data-name="${esc(name)}">
                <option value="">Guess: ${esc(label(guess))}</option>
                ${TYPE_CHOICES.map(c => `<option value="${c}" ${set === c ? 'selected' : ''}>${esc(label(c))}</option>`).join('')}
            </select></td></tr>`;
        };
        const groups = [...sh.groups.keys()].map(g => row(g, `group of ${Show.resolveTarget(sh, g).length.toLocaleString()} lights`)).join('');
        const models = [...sh.models.values()].filter(m => m.attrs.Controller !== 'No Controller').map(m => row(m.name, `${m.type}, ${m.nodes.length.toLocaleString()} lights`)).join('');
        $('typesTable').innerHTML = (groups ? `<tr><th colspan="2">Groups</th></tr>${groups}` : '') + (models ? `<tr><th colspan="2">Props</th></tr>${models}` : '') ||
            '<tr><td class="muted">Nothing to show.</td></tr>';
        $('typesTable').querySelectorAll('select').forEach(sel => sel.addEventListener('change', () => {
            if (sel.value) sh.propTypes[sel.dataset.name] = sel.value; else delete sh.propTypes[sel.dataset.name];
            savePropTypes();
        }));
    }
    $('typesBtn').addEventListener('click', () => {
        if (!S.show) return;
        const unknown = [...S.show.models.values()].some(m => Ideas.guessClass(S.show, m.name) === 'generic');
        $('typesUnknown').checked = unknown && !Object.keys(S.show.propTypes || {}).length;
        drawTypes();
        $('typesDlg').showModal();
    });
    $('typesFind').addEventListener('input', drawTypes);
    $('typesUnknown').addEventListener('change', drawTypes);
    $('typesReset').addEventListener('click', () => { S.show.propTypes = {}; savePropTypes(); drawTypes(); });
    $('typesDlg').addEventListener('close', () => renderMixNote());
    $('mixReset').addEventListener('click', () => {
        commit(() => { mixData().levels = {}; }, { render: false });
        drawMix();
        renderMixNote();
    });
    // "+ Add a model or group": the picker fills the mix's extra rows
    $('mixAdd').addEventListener('click', () => {
        mixDlg.close();
        openPicker(mixData(), 'extras', 'Add props or groups to the prop mix');
        S.reopenMix = true;
    });
    $('ideaExcludeBtn').addEventListener('click', () => openPicker(S.plan, 'ideaExclude', 'Leave these out of ideas'));
    function renderExclude() {
        const ex = (S.plan && S.plan.ideaExclude) || [];
        $('ideaExcludeTxt').textContent = ex.length ? `Leaving out: ${ex.slice(0, 3).join(', ')}${ex.length > 3 ? ` +${ex.length - 3}` : ''}` : '';
        $('ideaExcludeBtn').classList.toggle('on', ex.length > 0);
    }

    // ---------- choosing lights ----------

    let pick = null;       // { obj, key }
    const dlg = $('picker');

    function openPicker(obj, key, title) {
        obj[key] = obj[key] || [];
        pick = { obj, key, before: snapshot(), effect: key === 'targets' ? obj.effect : null };
        dlg.querySelector('h2').textContent = title || 'Choose lights';
        $('pickSearch').value = '';
        fillPicker();
        dlg.showModal();
        $('pickSearch').focus();
    }

    function nodeCount(name) {
        const m = S.show.models.get(name);
        return m ? m.nodes.length : Show.resolveTarget(S.show, name).length;
    }

    function fillPicker() {
        const q = $('pickSearch').value.trim().toLowerCase();
        const list = pick.obj[pick.key];
        const sel = new Set(list);
        const match = n => !q || n.toLowerCase().includes(q);
        const item = (name, label, count, extra = '') => `<label class="pick-item${extra}"><input type="checkbox" value="${esc(name)}" ${sel.has(name) ? 'checked' : ''}> <span>${esc(label)}</span> <em>${count}</em></label>`;
        const groups = [...S.show.groups.keys()].filter(match).sort((a, b) => a.localeCompare(b));
        $('pickGroups').innerHTML = groups.map(g => item(g, g, S.show.groups.get(g).members.length + ' items')).join('') || '<p class="muted">None</p>';
        const needFace = pick.effect && Effects.get(pick.effect)?.needsFace;
        const models = [...S.show.models.values()].filter(m => match(m.name) || m.submodels.some(s => match(s.name))).filter(m => !needFace || m.faces.length).sort((a, b) => a.name.localeCompare(b.name));
        $('pickModels').innerHTML = models.map(m => {
            const subs = m.submodels.filter(s => s.nodes.length && (match(m.name) || match(s.name)));
            const open = (q && subs.some(s => match(s.name))) || subs.some(s => sel.has(m.name + '/' + s.name));
            return `<div class="pick-model">${subs.length ? `<button type="button" class="tw" aria-expanded="${open}">${open ? '▾' : '▸'}</button>` : '<span class="tw"></span>'}${item(m.name, m.name, m.nodes.length + ' lights' + (m.faces.length ? ' · face' : ''))}
                ${subs.length ? `<div class="pick-subs" ${open ? '' : 'hidden'}>${subs.map(s => item(m.name + '/' + s.name, s.name, s.nodes.length + ' lights', ' sub')).join('')}</div>` : ''}</div>`;
        }).join('') || '<p class="muted">None</p>';
        dlg.querySelectorAll('.tw[aria-expanded]').forEach(b => b.addEventListener('click', () => {
            const subs = b.parentElement.querySelector('.pick-subs');
            subs.hidden = !subs.hidden;
            b.textContent = subs.hidden ? '▸' : '▾';
            b.setAttribute('aria-expanded', String(!subs.hidden));
        }));
        dlg.querySelectorAll('.pick-item input').forEach(cb => cb.addEventListener('change', () => {
            const arr = pick.obj[pick.key];
            if (cb.checked) { if (!arr.includes(cb.value)) arr.push(cb.value); }
            else pick.obj[pick.key] = arr.filter(t => t !== cb.value);
            updatePickCount();
            if (pick.key === 'ideaExclude') renderExclude();
            regenerate();
        }));
        updatePickCount();
    }

    function updatePickCount() {
        const arr = pick.obj[pick.key];
        const n = arr.length;
        $('pickCount').textContent = n ? `${n} chosen: ${arr.slice(0, 4).join(', ')}${n > 4 ? '…' : ''}` : 'Nothing chosen yet';
    }

    $('pickSearch').addEventListener('input', fillPicker);
    dlg.addEventListener('close', () => {
        if (pick && pick.before !== snapshot()) { S.history.push(pick.before); S.future = []; document.dispatchEvent(new CustomEvent('xl:changed')); }
        pick = null;
        renderPlan();
        regenerate();
        if (S.reopenMix) { S.reopenMix = false; drawMix(); mixDlg.showModal(); }
    });

    // ---------- copying a section's lights to others ----------

    const copyDlg = $('copyDlg');
    let copyFrom = null;

    function openCopy(sec) {
        copyFrom = sec;
        const song = XLWeb.song();
        const others = song.sections.filter(s => s.id !== sec.id);
        const kinds = [...new Set(others.map(s => Sequencer.kindOf(s.name)))];
        $('copyTitle').textContent = `Copy the lights of "${sec.name}" to…`;
        $('copyQuick').innerHTML = kinds.map(k => `<button type="button" class="btn tiny" data-k="${esc(k)}">All ${esc(k)}</button>`).join('') + '<button type="button" class="btn tiny" data-k="*">Every section</button><button type="button" class="btn tiny" data-k="">None</button>';
        $('copyList').innerHTML = others.map(s => {
            const n = (S.plan.sections[s.id] || { rows: [] }).rows.length;
            return `<label class="pick-item"><input type="checkbox" value="${s.id}" data-k="${esc(Sequencer.kindOf(s.name))}"> <span>${esc(s.name)}</span> <em>${fmt(s.s)} · ${n ? n + ' light rows now' : 'empty'}</em></label>`;
        }).join('');
        $('copyQuick').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            copyDlg.querySelectorAll('#copyList input').forEach(cb => { cb.checked = b.dataset.k === '*' || (b.dataset.k !== '' && cb.dataset.k === b.dataset.k); });
        }));
        copyDlg.showModal();
    }

    $('copyGo').addEventListener('click', () => {
        const ids = [...copyDlg.querySelectorAll('#copyList input:checked')].map(cb => cb.value);
        const mode = copyDlg.querySelector('input[name=copyMode]:checked').value;
        copyDlg.close();
        if (!ids.length || !copyFrom) return;
        const src = container(copyFrom.id);
        commit(() => {
            for (const id of ids) {
                const dst = container(id);
                const rows = Sequencer.cloneRows(src.rows);
                dst.rows = mode === 'add' ? dst.rows.concat(rows) : rows;
                if (mode !== 'add') dst.pool = src.pool.slice();
            }
        });
        const song = XLWeb.song();
        setPlanStatus(`Copied "${copyFrom.name}" to ${ids.map(id => song.sections.find(s => s.id === id).name).join(', ')}. Each copy can now be changed on its own.`);
    });
    $('copyCancel').addEventListener('click', () => copyDlg.close());

    // ---------- ideas ----------

    const ideaScheme = () => Effects.SCHEMES.find(x => x.id === (S.plan.ideaScheme || 'christmas')) || Effects.SCHEMES[0];

    function randomizeSection(sec) {
        const song = XLWeb.song();
        const c = container(sec.id);
        const rows = Ideas.partIdea(sec, song, S.show, { pool: c.pool, seed: Math.floor(Math.random() * 2 ** 31), scheme: ideaScheme(), ...ideaMood() });
        commit(() => { const cc = container(sec.id); cc.rows = withKept(cc.rows, rows); S.open.add(sec.id); });
        saveOpen();
        // loop it, so each new idea can be judged straight away
        if (S.loopId !== sec.id || !XLWeb.playing()) loopSection(sec);
        else setLoop(sec.id);
        setPlanStatus(`New idea for "${sec.name}"${c.pool.length ? ' from its chosen lights' : ''}, looping now. Press 🎲 again for another, or Undo to go back.`);
    }

    // Which parts "Suggest a plan" works on: 'whole' plus section ids. null = everything.
    const ideaSelKey = () => 'xlweb-ideasel:' + (XLWeb.song() ? XLWeb.song().hash : '');
    function ideaSelection() {
        if (S.ideaSel === undefined) {
            try { const v = JSON.parse(localStorage.getItem(ideaSelKey()) || 'null'); S.ideaSel = Array.isArray(v) ? new Set(v) : null; } catch (e) { S.ideaSel = null; }
        }
        return S.ideaSel;
    }
    function saveIdeaSel() {
        try { localStorage.setItem(ideaSelKey(), JSON.stringify(S.ideaSel ? [...S.ideaSel] : null)); } catch (e) { /* storage blocked */ }
    }
    const ideaPicked = id => { const sel = ideaSelection(); return !sel || sel.has(id); };
    function setIdeaPicked(id, on) {
        const song = XLWeb.song();
        if (!song) return;
        const all = ['whole', ...song.sections.map(s => s.id)];
        const sel = new Set(ideaSelection() || all);
        if (on) sel.add(id); else sel.delete(id);
        S.ideaSel = sel.size === all.length ? null : sel;
        saveIdeaSel();
        renderIdeaFor();
        markIdeaCards();
    }
    function markIdeaCards() {
        document.querySelectorAll('#plan .sec-card').forEach(c => {
            const on = ideaPicked(c.dataset.id);
            c.classList.toggle('idea-on', on);
            const cb = c.querySelector('.ipick');
            if (cb) cb.checked = on;
        });
    }
    // Rows the user unticked are kept when an idea replaces the part; new rows
    // drop any prop a kept row already covers (same kind of row, overlapping bars).
    function withKept(oldRows, newRows) {
        const kept = (oldRows || []).filter(r => r.keep);
        if (!kept.length) return newRows;
        const isSpan = r => (r.trigger || 'span') === 'span';
        const range = r => r.bars ? r.bars : [0, Infinity];
        const models = new Map();
        const modelsOf = t => { if (!models.has(t)) models.set(t, new Set(Show.resolveTarget(S.show, t).map(n => n.model.name))); return models.get(t); };
        const out = [];
        for (const r of newRows) {
            const blockers = kept.filter(k => isSpan(k) === isSpan(r) && range(k)[0] < range(r)[1] && range(r)[0] < range(k)[1]);
            const taken = new Set();
            for (const k of blockers) for (const t of k.targets) for (const m of modelsOf(t)) taken.add(m);
            const targets = r.targets.filter(t => ![...modelsOf(t)].some(m => taken.has(m)));
            if (targets.length) out.push({ ...r, targets });
        }
        return kept.concat(out);
    }

    function renderIdeaFor() {
        const song = XLWeb.song();
        if (!song) return;
        const kinds = [...new Set(song.sections.map(s => Sequencer.kindOf(s.name)))];
        $('ideaQuick').innerHTML = '<button type="button" class="btn tiny" data-k="*">Everything</button>' + kinds.map(k => `<button type="button" class="btn tiny" data-k="${esc(k)}">Only ${esc(k)}</button>`).join('') + '<button type="button" class="btn tiny" data-k="">None</button>';
        $('ideaList').innerHTML = [{ id: 'whole', name: 'Whole song layer (floods, faces)' }, ...song.sections].map(s =>
            `<label class="pick-item"><input type="checkbox" value="${s.id}" ${ideaPicked(s.id) ? 'checked' : ''}> <span>${esc(s.name)}</span>${s.s != null ? ` <em>${fmt(s.s)}</em>` : ''}</label>`).join('');
        const set = ids => {
            S.ideaSel = ids === null ? null : new Set(ids);
            saveIdeaSel();
            renderIdeaFor();
            markIdeaCards();
        };
        $('ideaQuick').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.k;
            if (k === '*') set(null);
            else if (k === '') set([]);
            else set(song.sections.filter(s => Sequencer.kindOf(s.name) === k).map(s => s.id));
        }));
        $('ideaList').querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
            const ids = [...$('ideaList').querySelectorAll('input:checked')].map(x => x.value);
            set(ids.length === song.sections.length + 1 ? null : ids);
        }));
        const sel = ideaSelection();
        const n = sel ? song.sections.filter(s => sel.has(s.id)).length : song.sections.length;
        $('ideaForLabel').textContent = !sel ? 'every section'
            : n === 0 ? (sel.has('whole') ? 'whole-song layer only' : 'nothing chosen')
            : n === 1 ? song.sections.find(s => sel.has(s.id)).name + (sel.has('whole') ? ' + whole song' : '')
            : `${n} sections${sel.has('whole') ? ' + whole song' : ''}`;
    }

    const TRIES = 4;
    let suggesting = false;
    async function suggestPlan() {
        const song = XLWeb.song();
        if (!song || !S.show || suggesting) return;
        const sections = song.sections.filter(s => ideaPicked(s.id));
        const whole = ideaPicked('whole');
        if (!sections.length && !whole) { setPlanStatus('Choose at least one section under "For:" first.'); return; }
        const pools = {};
        for (const [id, c] of Object.entries(S.plan.sections)) if (c.pool && c.pool.length) pools[id] = c.pool;
        const make = () => Ideas.planIdea(song, S.show, { seed: Math.floor(Math.random() * 2 ** 31), scheme: ideaScheme(), alike: $('ideaAlike').checked, pools, sections, whole, ...ideaMood() });
        // only the chosen parts change; everything else keeps its lights
        const merged = idea => {
            const p = { ...S.plan, whole: whole ? { ...idea.whole, rows: withKept(S.plan.whole.rows, idea.whole.rows) } : S.plan.whole, sections: { ...S.plan.sections } };
            for (const s of sections) p.sections[s.id] = { ...idea.sections[s.id], rows: withKept((S.plan.sections[s.id] || {}).rows, idea.sections[s.id].rows) };
            return p;
        };
        let idea = make(), best = null;
        if ($('ideaBest').checked) {
            suggesting = true;
            const btn = $('suggestPlan');
            btn.disabled = true;
            try {
                for (let i = 0; i < TRIES; i++) {
                    setPlanStatus(`Trying idea ${i + 1} of ${TRIES} against the music…`);
                    const cand = i ? make() : idea;
                    const r = await Fit.measure(merged(cand), song, S.show);
                    if (r && (!best || r.score > best.r.score)) best = { idea: cand, r };
                }
            } finally {
                suggesting = false;
                btn.disabled = false;
            }
            if (best) idea = best.idea;
        }
        const next = merged(idea);
        commit(() => {
            if (whole) S.plan.whole = next.whole;
            for (const s of sections) S.plan.sections[s.id] = next.sections[s.id];
        });
        $('suggestPlan').textContent = '🎲 Another idea';
        const what = sections.length === song.sections.length ? 'the whole song' : sections.length ? sections.map(s => s.name).join(', ') : 'the whole-song layer';
        setPlanStatus(`New idea for ${what}${best ? ` (best fit of ${TRIES} tried: ${best.r.score})` : ''}. Press 🎲 Another idea to keep trying, Undo to go back, or change any section by hand.`);
    }
    $('suggestPlan').addEventListener('click', suggestPlan);
    // close the chooser on a click elsewhere (composedPath: the list re-renders under the click)
    document.addEventListener('click', e => { const d = $('ideaFor'); if (d.open && !e.composedPath().includes(d)) d.open = false; });

    // ---------- change only the colours ----------
    //
    // Pick a scheme and where it goes; the preview shows it straight away
    // (applied to a copy of the plan), Apply keeps it as one undo step,
    // Cancel puts the old colours back.

    const rcDlg = $('recolourDlg');
    let rc = null;    // { before: snapshot, scheme, ids: Set }

    // ---------- words on the matrix ----------
    //
    // Adds a Text row (each sung line) on a matrix to the chosen parts, without
    // touching anything else; the matrix's other rows there can be dimmed so the
    // words read.

    const LIFT_NAME = /chorus|refrain|drop|hook/i;
    const wd = { ids: new Set() };
    function matrixChoices() {
        const sh = S.show;
        return [...sh.models.values()]
            .filter(m => m.attrs.Controller !== 'No Controller' && (Ideas.classify(sh, m.name) === 'matrix' || /Matrix$/.test(m.type)))
            .sort((a, b) => b.nodes.length - a.nodes.length);
    }
    function wordsRowsIn(c, target) { return c.rows.filter(r => r.effect === 'lyrictext' && r.targets.includes(target)); }
    function openWords() {
        const song = XLWeb.song();
        if (!song || !S.show || !S.plan) return;
        const mats = matrixChoices();
        $('wdMatrix').innerHTML = mats.length ? mats.map(m => `<option value="${esc(m.name)}">${esc(m.name)} (${m.bufW}×${m.bufH})</option>`).join('')
            : '<option value="">No matrix found in your show</option>';
        const lifts = song.sections.filter(s => LIFT_NAME.test(s.name));
        wd.ids = new Set(lifts.length ? lifts.map(s => s.id) : []);
        // parts that already show the words stay ticked
        if (mats.length) for (const s of song.sections) if (wordsRowsIn(S.plan.sections[s.id] || { rows: [] }, mats[0].name).length) wd.ids.add(s.id);
        setWordsSize();
        $('wdNoWords').hidden = !!song.lyr;
        drawWords();
        $('wordsDlg').showModal();
    }
    function setWordsSize() {
        const m = S.show.models.get($('wdMatrix').value);
        $('wdSize').value = m ? Math.max(8, Math.round((m.bufH || 20) * 0.6)) : 20;
    }
    function drawWords() {
        const song = XLWeb.song();
        const kinds = [...new Set(song.sections.map(s => Sequencer.kindOf(s.name)))];
        $('wdQuick').innerHTML = kinds.map(k => `<button type="button" class="btn tiny" data-k="${esc(k)}">All ${esc(k)}</button>`).join('') + '<button type="button" class="btn tiny" data-k="*">Every part</button><button type="button" class="btn tiny" data-k="">None</button>';
        const target = $('wdMatrix').value;
        $('wdList').innerHTML = song.sections.map(s => {
            const has = target && wordsRowsIn(S.plan.sections[s.id] || { rows: [] }, target).length;
            const sung = song.lyr ? song.lyr.lines.filter(l => l.s < s.e && l.e > s.s).length : 0;
            return `<label class="pick-item"><input type="checkbox" value="${s.id}" ${wd.ids.has(s.id) ? 'checked' : ''}> <span>${esc(s.name)}</span> <em>${song.lyr ? `${sung} sung line${sung === 1 ? '' : 's'}` : ''}${has ? ' · words on' : ''}</em></label>`;
        }).join('');
        $('wdQuick').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.k;
            wd.ids = new Set(k === '*' ? song.sections.map(s => s.id) : k === '' ? [] : song.sections.filter(s => Sequencer.kindOf(s.name) === k).map(s => s.id));
            drawWords();
        }));
        $('wdList').querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => { if (cb.checked) wd.ids.add(cb.value); else wd.ids.delete(cb.value); countWords(); }));
        countWords();
    }
    function countWords() {
        const n = wd.ids.size;
        $('wdCount').textContent = n ? `${n} part${n > 1 ? 's' : ''}` : 'no parts ticked';
        $('wdApply').disabled = !n || !$('wdMatrix').value || !XLWeb.song().lyr;
        $('wdRemove').disabled = !n || !$('wdMatrix').value;
    }
    $('wdMatrix').addEventListener('change', () => { setWordsSize(); drawWords(); });
    $('wordsBtn').addEventListener('click', openWords);
    $('wdCancel').addEventListener('click', () => $('wordsDlg').close());
    $('wdApply').addEventListener('click', () => {
        const target = $('wdMatrix').value, size = Math.max(4, parseInt($('wdSize').value, 10) || 20);
        const color = $('wdColor').value.toUpperCase(), dim = $('wdDim').checked;
        const song = XLWeb.song();
        const ids = song.sections.filter(s => wd.ids.has(s.id)).map(s => s.id);
        commit(() => {
            for (const id of ids) {
                const c = container(id);
                c.rows = c.rows.filter(r => !(r.effect === 'lyrictext' && r.targets.includes(target)));
                if (dim) for (const r of c.rows) if (r.trigger === 'span' && r.targets.includes(target) && r.effect !== 'faces') r.level = Math.min(r.level ?? 100, 25);
                c.rows.push({ id: Sequencer.newId(), trigger: 'lines', targets: [target], effect: 'lyrictext', options: { size }, colors: [color], scheme: 'custom' });
            }
        });
        $('wordsDlg').close();
        setPlanStatus(`Words on ${target} in ${ids.map(id => song.sections.find(s => s.id === id).name).join(', ')}. Undo takes it back.`);
    });
    $('wdRemove').addEventListener('click', () => {
        const target = $('wdMatrix').value;
        let n = 0;
        commit(() => {
            for (const id of wd.ids) {
                const c = S.plan.sections[id];
                if (!c) continue;
                const before = c.rows.length;
                c.rows = c.rows.filter(r => !(r.effect === 'lyrictext' && r.targets.includes(target)));
                n += before - c.rows.length;
            }
        });
        $('wordsDlg').close();
        setPlanStatus(n ? `Took the words off ${target} in ${n} part${n > 1 ? 's' : ''}.` : `There were no words on ${target} in those parts.`);
    });

    function openRecolour(ids) {
        const song = XLWeb.song();
        if (!song || !S.plan) return;
        rc = {
            before: snapshot(),
            scheme: (Effects.SCHEMES.find(s => s.id === S.plan.ideaScheme) || Effects.SCHEMES[0]).id,
            ids: new Set(ids || ['whole', ...song.sections.map(s => s.id)]),
            applied: false,
        };
        drawRecolour();
        rcDlg.showModal();
        previewRecolour();
    }

    function drawRecolour() {
        const song = XLWeb.song();
        $('rcSchemes').innerHTML = Effects.SCHEMES.map(s => `<label class="rc-scheme${s.id === rc.scheme ? ' on' : ''}"><input type="radio" name="rcScheme" value="${s.id}" ${s.id === rc.scheme ? 'checked' : ''}> <span>${esc(s.label)}</span> <span class="rl-sw">${s.colors.map(c => `<i style="background:${c}"></i>`).join('')}</span></label>`).join('');
        const kinds = [...new Set(song.sections.map(s => Sequencer.kindOf(s.name)))];
        $('rcQuick').innerHTML = '<button type="button" class="btn tiny" data-k="*">Everything</button>' + kinds.map(k => `<button type="button" class="btn tiny" data-k="${esc(k)}">Only ${esc(k)}</button>`).join('') + '<button type="button" class="btn tiny" data-k="">None</button>';
        const count = id => ((id === 'whole' ? S.plan.whole : S.plan.sections[id]) || { rows: [] }).rows.length;
        $('rcList').innerHTML = [{ id: 'whole', name: 'Whole song layer' }, ...song.sections].map(s =>
            `<label class="pick-item"><input type="checkbox" value="${s.id}" ${rc.ids.has(s.id) ? 'checked' : ''}> <span>${esc(s.name)}</span> <em>${count(s.id)} light rows</em></label>`).join('');
        $('rcSchemes').querySelectorAll('input').forEach(i => i.addEventListener('change', () => { rc.scheme = i.value; drawRecolour(); previewRecolour(); }));
        $('rcQuick').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.k;
            rc.ids = new Set(k === '*' ? ['whole', ...song.sections.map(s => s.id)] : k === '' ? [] : song.sections.filter(s => Sequencer.kindOf(s.name) === k).map(s => s.id));
            drawRecolour(); previewRecolour();
        }));
        $('rcList').querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
            if (cb.checked) rc.ids.add(cb.value); else rc.ids.delete(cb.value);
            previewRecolour();
        }));
    }

    // Colours for row number i: either the whole scheme, or as many colours as
    // the row had, starting at a different place so rows don't all match.
    function recolourRow(r, i, scheme, mode) {
        const cols = scheme.colors;
        if (mode === 'full' || cols.length === 1) { r.colors = cols.slice(); r.scheme = scheme.id; return; }
        const n = Math.max(1, Math.min(r.colors.length || cols.length, cols.length));
        r.colors = Array.from({ length: n }, (_, k) => cols[(i + k) % cols.length]);
        r.scheme = n === cols.length && i % cols.length === 0 ? scheme.id : 'custom';
    }

    function previewRecolour() {
        if (!rc) return;
        const scheme = Effects.SCHEMES.find(s => s.id === rc.scheme) || Effects.SCHEMES[0];
        const mode = rcDlg.querySelector('input[name=rcMode]:checked').value;
        const faces = $('rcFaces').checked;
        S.plan = JSON.parse(rc.before);
        let n = 0;
        for (const id of rc.ids) {
            const c = id === 'whole' ? S.plan.whole : S.plan.sections[id];
            if (!c) continue;
            let i = 0;
            for (const r of c.rows) {
                if (r.effect === 'faces' && !faces) continue;
                recolourRow(r, i++, scheme, mode);
                n++;
            }
        }
        $('rcCount').textContent = n ? `${n} light row${n > 1 ? 's' : ''} get ${scheme.label}` : 'Nothing chosen';
        regenerate();
    }

    rcDlg.querySelectorAll('input[name=rcMode]').forEach(i => i.addEventListener('change', previewRecolour));
    $('rcFaces').addEventListener('change', previewRecolour);
    $('rcApply').addEventListener('click', () => {
        if (!rc) return;
        S.history.push(rc.before);
        S.future = [];
        rc = null;
        rcDlg.close();
        renderPlan();
        regenerate();
        setPlanStatus('Colours changed. Undo puts the old ones back.');
        document.dispatchEvent(new CustomEvent('xl:changed'));
    });
    // Cancel / Esc put the old colours back right away. (The dialog's own
    // "close" event can arrive late, after the dialog was opened again, so it
    // must not be what restores them.)
    function cancelRecolour() {
        if (!rc || rc.applied) return;
        S.plan = JSON.parse(rc.before);
        rc = null;
        renderPlan();
        regenerate();
    }
    $('rcCancel').addEventListener('click', () => { cancelRecolour(); rcDlg.close(); });
    rcDlg.addEventListener('cancel', cancelRecolour);
    $('recolourBtn').addEventListener('click', () => openRecolour(null));

    // ---------- colour schemes: add / edit / remove / random / defaults ----------

    const schemeDlg = $('schemeDlg');
    let schemeWork = null;     // working copy while the dialog is open

    function openSchemes() {
        schemeWork = Effects.SCHEMES.map(s => ({ ...s, colors: s.colors.slice() }));
        drawSchemes();
        schemeDlg.showModal();
    }
    function applySchemes() { Effects.setSchemes(schemeWork); }

    function drawSchemes() {
        const box = $('schemeList');
        box.innerHTML = schemeWork.map((s, i) => `
            <div class="scheme-row" data-i="${i}">
              <input type="text" class="sname" value="${esc(s.label)}" aria-label="Scheme name">
              <span class="swatches">${s.colors.map((c, j) => `<input type="color" value="${c}" data-j="${j}" aria-label="Colour ${j + 1}">`).join('')}
                ${s.colors.length < 8 ? '<button type="button" class="btn tiny addc" title="Add a colour">+</button>' : ''}${s.colors.length > 1 ? '<button type="button" class="btn tiny delc" title="Remove the last colour">−</button>' : ''}</span>
              <button type="button" class="btn tiny reroll" title="New random colours for this scheme">🎲</button>
              <button type="button" class="btn tiny del" title="Delete this scheme" ${schemeWork.length < 2 ? 'disabled' : ''}>Delete</button>
            </div>`).join('');
        box.querySelectorAll('.scheme-row').forEach(rowEl => {
            const s = schemeWork[+rowEl.dataset.i];
            rowEl.querySelector('.sname').addEventListener('change', e => { s.label = e.target.value.trim() || s.label; applySchemes(); });
            rowEl.querySelectorAll('input[type=color]').forEach(inp => inp.addEventListener('change', e => { s.colors[+e.target.dataset.j] = e.target.value.toUpperCase(); applySchemes(); }));
            const add = rowEl.querySelector('.addc');
            if (add) add.addEventListener('click', () => { s.colors.push('#FFFFFF'); applySchemes(); drawSchemes(); });
            const del = rowEl.querySelector('.delc');
            if (del) del.addEventListener('click', () => { s.colors.pop(); applySchemes(); drawSchemes(); });
            rowEl.querySelector('.reroll').addEventListener('click', () => { const r = Effects.randomScheme(); s.colors = r.colors; applySchemes(); drawSchemes(); });
            rowEl.querySelector('.del').addEventListener('click', () => { schemeWork.splice(schemeWork.indexOf(s), 1); applySchemes(); drawSchemes(); });
        });
    }

    $('editSchemes').addEventListener('click', openSchemes);
    $('schemeAdd').addEventListener('click', () => {
        schemeWork.push({ id: 'u' + Math.random().toString(36).slice(2, 8), label: 'My colours', colors: ['#FFFFFF', '#FF0000'] });
        applySchemes(); drawSchemes();
        const rows = $('schemeList').querySelectorAll('.sname');
        rows[rows.length - 1].focus(); rows[rows.length - 1].select();
    });
    $('schemeRandom').addEventListener('click', () => { schemeWork.push(Effects.randomScheme()); applySchemes(); drawSchemes(); $('schemeList').lastElementChild.scrollIntoView({ block: 'nearest' }); });
    $('schemeReset').addEventListener('click', () => {
        if (!confirm('Replace your colour schemes with the default ones? Lights you already planned keep their colours.')) return;
        Effects.resetSchemes();
        schemeWork = Effects.SCHEMES.map(s => ({ ...s, colors: s.colors.slice() }));
        drawSchemes();
    });
    // every colour list follows the schemes as they change
    document.addEventListener('xl:schemes', () => {
        clearTimeout(schemeDlg.t);
        schemeDlg.t = setTimeout(renderPlan, 50);
        document.dispatchEvent(new CustomEvent('xl:changed'));
    });

    // ---------- picking lights on the house ----------
    //
    // Click a prop: what lights it right now, and add lights for it. Drag a box:
    // pick every prop inside it.

    function previewPoint(e) {
        const r = canvas.getBoundingClientRect();
        const win = S.win;
        return { cx: e.clientX - r.left, cy: e.clientY - r.top, x: win.x + (e.clientX - r.left) * win.w / r.width, y: win.y + (e.clientY - r.top) * win.h / r.height };
    }

    function modelAt(p) {
        const V = S.view, tol = 14 * S.win.w / canvas.clientWidth;
        let best = -1, bd = tol * tol;
        for (let k = 0; k < V.px.length; k++) {
            const dx = V.px[k] - p.x, dy = V.py[k] - p.y, d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = k; }
        }
        return best < 0 ? null : V.models[V.pm[best]];
    }

    function modelsInBox(a, b) {
        const V = S.view, x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        const hit = new Set();
        for (let k = 0; k < V.px.length; k++) if (V.px[k] >= x0 && V.px[k] <= x1 && V.py[k] >= y0 && V.py[k] <= y1) hit.add(V.pm[k]);
        return [...hit].map(i => V.models[i]);
    }

    // model name -> groups that contain it (directly or through other groups)
    function groupsOf() {
        if (S.modelGroups) return S.modelGroups;
        const map = new Map();
        for (const g of S.show.groups.keys()) {
            const names = new Set(Show.resolveTarget(S.show, g).map(n => n.model.name));
            for (const n of names) { if (!map.has(n)) map.set(n, []); map.get(n).push({ name: g, size: names.size }); }
        }
        for (const list of map.values()) list.sort((a, b) => a.size - b.size);
        S.modelGroups = map;
        return map;
    }

    // Rows in the playing section (and the whole-song layer) that touch a model.
    function rowsTouching(modelName, sec) {
        const out = [];
        const touch = r => r.targets.some(t => t === modelName || t.startsWith(modelName + '/') || (S.show.groups.has(t) && (groupsOf().get(modelName) || []).some(g => g.name === t)));
        for (const r of S.plan.whole.rows) if (touch(r)) out.push({ r, where: 'whole', label: 'Whole song' });
        if (sec) for (const r of (S.plan.sections[sec.id] || { rows: [] }).rows) if (touch(r)) out.push({ r, where: sec.id, label: sec.name });
        return out;
    }

    const pop = $('pvPop');
    function closePop() { pop.hidden = true; S.box = null; setHighlight(null); }

    function showPop(at, html, wire) {
        pop.innerHTML = `<button type="button" class="pop-x" aria-label="Close">×</button>${html}`;
        pop.hidden = false;
        const wrap = canvas.parentElement.getBoundingClientRect();
        const w = Math.min(320, wrap.width - 16);
        pop.style.width = w + 'px';
        pop.style.left = Math.max(8, Math.min(at.cx + 12, wrap.width - w - 8)) + 'px';
        pop.style.top = Math.max(8, Math.min(at.cy + 12, wrap.height - 40)) + 'px';
        pop.querySelector('.pop-x').addEventListener('click', closePop);
        wire(pop);
    }

    // add a row for these targets to the playing section (or the first one)
    function addRowFor(targets, sec) {
        const r = newRow();
        r.targets = targets.slice();
        S.rowOpen.add(r.id);
        commit(() => { container(sec.id).rows.push(r); S.open.add(sec.id); });
        saveOpen();
        closePop();
        setPlanStatus(`Added ${targets.join(', ')} to "${sec.name}". Pick its effect in the section card.`);
        const card = document.querySelector(`.sec-card[data-id="${sec.id}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function playingSection() {
        const song = XLWeb.song(), t = XLWeb.time();
        return song.sections.find(s => t >= s.s && t < s.e) || song.sections[0];
    }

    function popForModels(at, models) {
        const sec = playingSection();
        const names = models.map(m => m.name);
        setHighlight(names);
        // groups that hold all of them, smallest first
        const gm = groupsOf();
        let common = null;
        for (const m of models) {
            const gs = new Set((gm.get(m.name) || []).map(g => g.name));
            common = common ? new Set([...common].filter(g => gs.has(g))) : gs;
        }
        const groups = [...(common || [])].map(n => ({ n, size: Show.resolveTarget(S.show, n).length })).sort((a, b) => a.size - b.size).slice(0, 4);
        let html = '';
        if (models.length === 1) {
            const m = models[0];
            const rows = rowsTouching(m.name, sec);
            html += `<h4>${esc(m.name)}</h4><p class="muted small">${m.nodes.length} lights${m.faces.length ? ' · singing face' : ''}</p>`;
            html += rows.length ? `<p class="small">Lit in <b>${esc(sec.name)}</b> by:</p><ul class="pop-rows">${rows.map((x, i) => `<li><button type="button" class="link" data-i="${i}">${esc(Effects.get(x.r.effect).label)} · ${esc(x.r.targets.join(', '))}</button> <span class="muted">(${esc(x.label)})</span></li>`).join('')}</ul>`
                : `<p class="small">Nothing lights it in <b>${esc(sec.name)}</b>.</p>`;
        } else {
            html += `<h4>${models.length} props</h4><p class="small muted">${esc(names.slice(0, 8).join(', '))}${names.length > 8 ? '…' : ''}</p>`;
        }
        html += `<p class="small">Add lights to <b>${esc(sec.name)}</b> for:</p><div class="pop-btns">
            <button type="button" class="btn tiny" data-t="models">${models.length === 1 ? esc(models[0].name) : `these ${models.length} props`}</button>
            ${groups.map(g => `<button type="button" class="btn tiny" data-t="g:${esc(g.n)}">group ${esc(g.n)}</button>`).join('')}</div>
            <p class="small"><button type="button" class="link" data-t="pool">Use ${models.length === 1 ? 'it' : 'them'} as the lights to randomize in ${esc(sec.name)}</button></p>
            <p class="small"><button type="button" class="link" data-t="exclude">${names.every(n => (S.plan.ideaExclude || []).includes(n)) ? `Let ideas use ${models.length === 1 ? 'it' : 'them'} again` : `Leave ${models.length === 1 ? 'it' : 'them'} out of ideas`}</button></p>`;
        const rows = models.length === 1 ? rowsTouching(models[0].name, sec) : [];
        showPop(at, html, el => {
            el.querySelectorAll('.pop-rows button').forEach(b => b.addEventListener('click', () => {
                const x = rows[+b.dataset.i];
                S.rowOpen.add(x.r.id);
                S.open.add(x.where);
                saveOpen();
                renderPlan();
                closePop();
                const rowCard = document.querySelector(`.sec-card[data-id="${x.where}"]`);
                if (rowCard) rowCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }));
            el.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
                const t = b.dataset.t;
                if (t === 'models') addRowFor(names, sec);
                else if (t === 'exclude') {
                    const ex = S.plan.ideaExclude || [];
                    const allIn = names.every(n => ex.includes(n));
                    commit(() => { S.plan.ideaExclude = allIn ? ex.filter(n => !names.includes(n)) : [...new Set([...ex, ...names])]; });
                    closePop();
                    setPlanStatus(allIn ? `Ideas can use ${names.join(', ')} again.` : `Ideas will leave out ${names.join(', ')}. Lights you already planned are not changed.`);
                }
                else if (t === 'pool') {
                    commit(() => { const c = container(sec.id); c.pool = [...new Set([...(c.pool || []), ...names])]; S.open.add(sec.id); });
                    saveOpen();
                    closePop();
                    setPlanStatus(`"${sec.name}" will randomize with ${names.join(', ')}. Press 🎲 Randomize on its card.`);
                } else addRowFor([t.slice(2)], sec);
            }));
        });
    }

    let pickDrag = null;
    canvas.addEventListener('mousedown', e => {
        if (S.bgAdjusting || !S.show || e.button !== 0) return;
        pickDrag = { a: previewPoint(e), moved: false };
    });
    window.addEventListener('mousemove', e => {
        if (!pickDrag) return;
        const p = previewPoint(e);
        if (!pickDrag.moved && Math.hypot(p.cx - pickDrag.a.cx, p.cy - pickDrag.a.cy) < 5) return;
        pickDrag.moved = true;
        pickDrag.b = p;
        S.box = { x0: pickDrag.a.cx, y0: pickDrag.a.cy, x1: p.cx, y1: p.cy };
        S.dirty = true;
    });
    window.addEventListener('mouseup', e => {
        if (!pickDrag) return;
        const d = pickDrag;
        pickDrag = null;
        if (d.moved) {
            const models = modelsInBox(d.a, d.b);
            S.box = null;
            S.dirty = true;
            if (models.length) popForModels(d.b, models);
            else closePop();
        } else {
            const m = modelAt(d.a);
            if (m) popForModels(d.a, [m]); else closePop();
        }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) closePop(); });

    // keep the pinned preview just under the pinned song bar
    const songbar = document.querySelector('.songbar');
    new ResizeObserver(() => document.documentElement.style.setProperty('--stick-top', (songbar.offsetHeight + 8) + 'px')).observe(songbar);
    // stacked layout: the pinned preview covers the top of the plan, so scrolling
    // to a section must land below it
    const seqLeft = document.querySelector('.seq-left');
    function updatePvH() {
        const stacked = getComputedStyle(document.querySelector('.seq-split')).display !== 'grid';
        document.documentElement.style.setProperty('--pv-h', (stacked ? seqLeft.offsetHeight + 8 : 0) + 'px');
    }
    new ResizeObserver(updatePvH).observe(seqLeft);
    S.updatePvH = updatePvH;

    // ---------- saving ----------

    const songDirKey = 'xlweb-songdir';
    document.addEventListener('xl:song', () => fillMediaPath());
    function fillMediaPath() {
        const song = XLWeb.song();
        if (!song) return;
        let dir = '';
        try { dir = localStorage.getItem(songDirKey) || ''; } catch (e) { /* none */ }
        $('mediaPath').value = dir ? dir.replace(/[\\/]+$/, '') + '\\' + (song.fileFull || song.fileName) : (song.fileFull || song.fileName);
    }
    $('mediaPath').addEventListener('change', e => {
        const v = e.target.value.trim();
        const m = v.match(/^(.*)[\\/][^\\/]+$/);
        if (m) try { localStorage.setItem(songDirKey, m[1]); } catch (err) { /* none */ }
    });

    function buildXsq() {
        const song = XLWeb.song();
        if (!song || !S.show || !S.plan) return null;
        // always the full plan, whatever is soloed or muted in the preview
        const gen = Sequencer.generate(S.plan, song, S.show);
        if (!gen.count) { $('xsqStatus').textContent = 'The plan has no effects yet.'; return null; }
        const ver = '2025.09';
        return Sequencer.toXsq(gen, song, S.show, { song: song.fileName, mediaFile: $('mediaPath').value.trim(), version: ver });
    }

    $('downloadXsq').addEventListener('click', () => {
        const xml = buildXsq();
        if (!xml) return;
        const song = XLWeb.song();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
        a.download = song.fileName + '.xsq';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        $('xsqStatus').textContent = `Downloaded ${song.fileName}.xsq. Move it into your show folder and open it in xLights.`;
        S.xsqSavedAt = Date.now();
        document.dispatchEvent(new CustomEvent('xl:xsq'));
    });

    $('saveXsq').addEventListener('click', async () => {
        const xml = buildXsq();
        if (!xml || !S.show.folder) return;
        const song = XLWeb.song();
        const name = song.fileName + '.xsq';
        try {
            if (!(await Show.permission(S.show.folder, 'readwrite'))) { $('xsqStatus').textContent = 'Saving needs permission to write to the show folder.'; return; }
            let exists = false;
            try { await S.show.folder.getFileHandle(name); exists = true; } catch (e) { exists = false; }
            if (exists && !confirm(`${name} already exists in your show folder. Replace it?`)) return;
            const fh = await S.show.folder.getFileHandle(name, { create: true });
            const w = await fh.createWritable();
            await w.write(xml);
            await w.close();
            $('xsqStatus').textContent = `Saved ${name} in "${S.show.folderName}". Open it in xLights and render.`;
            S.xsqSavedAt = Date.now();
            document.dispatchEvent(new CustomEvent('xl:xsq'));
        } catch (err) {
            console.error(err);
            $('xsqStatus').textContent = 'Could not save: ' + (err.message || err);
        }
    });

    function fmt(t) {
        const m = Math.floor(t / 60), s = t - m * 60;
        return `${m}:${s.toFixed(1).padStart(4, '0')}`;
    }

    window.XLSeq = {
        S, regenerate, useShow,
        // project files
        getPlan: () => S.plan ? JSON.parse(JSON.stringify(S.plan)) : null,
        setPlan: p => { S.plan = p; savePlan(); if (S.show) setPlan(p); },
        mediaPath: () => $('mediaPath').value.trim(),
        getBgAdj: () => S.bgAdj ? { ...S.bgAdj } : null,
        setBgAdj: a => { if (!a) return; S.bgAdj = { ...BG_DEFAULT, ...a }; if (S.show) { saveBgAdj(); syncBgInputs(); if (!S.bgAdjusting) updateWindow(); S.dirty = true; } else S.pendingBg = S.bgAdj; },
        setMediaPath: v => { if (v) $('mediaPath').value = v; },
        loadShowFromUrl: async (base) => useShow(async () => {
        const rgb = await (await fetch(base + 'xlights_rgbeffects.xml')).text();
        const show = Show.parse(rgb, '');
        show.folderName = 'test';
        show.backgroundUrl = base + show.backgroundName;
        for (const m of show.models.values()) if (m.image && m.image.path && !/^[a-z]:|^[\\/]/i.test(m.image.path)) m.image.url = base + m.image.path.replace(/\\/g, '/');
        return show;
    }) };
})();
