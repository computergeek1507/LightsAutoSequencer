'use strict';

// The user's xLights show: reads xlights_rgbeffects.xml (and networks), and
// works out where every light sits on the house so the page can draw it.
//
// Geometry is a port of xLights' own model code (src-core/models): each model
// type lays its nodes out in "screen" units, then the model's screen location
// scales, rotates and places them in the 2D preview (y up). Every node also
// gets its render-buffer cell (bx, by), which is what effects draw into.
const Show = (() => {
    const HANDLE_DB = 'xlweb-show';

    // ---------- folder access (File System Access API) ----------

    function idb() {
        return new Promise((res, rej) => {
            const r = indexedDB.open(HANDLE_DB, 1);
            r.onupgradeneeded = () => r.result.createObjectStore('kv');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async function kvGet(k) {
        try {
            const db = await idb();
            return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); });
        } catch (e) { return undefined; }
    }
    async function kvPut(k, v) {
        try {
            const db = await idb();
            await new Promise(res => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; });
        } catch (e) { /* no persistence */ }
    }

    const canPickFolder = () => typeof window.showDirectoryPicker === 'function';

    async function pickFolder() {
        const h = await window.showDirectoryPicker({ id: 'xlights-show', mode: 'read' });
        await kvPut('folder', h);
        return h;
    }

    async function savedFolder() {
        return (await kvGet('folder')) || null;
    }

    async function permission(handle, mode = 'read') {
        const opts = { mode };
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        return (await handle.requestPermission(opts)) === 'granted';
    }

    async function fileIn(dir, name) {
        try { return await (await dir.getFileHandle(name)).getFile(); } catch (e) { return null; }
    }

    async function loadFromFolder(dir) {
        const rgb = await fileIn(dir, 'xlights_rgbeffects.xml');
        if (!rgb) throw new Error('This folder has no xlights_rgbeffects.xml. Pick the folder xLights uses as its show folder.');
        const net = await fileIn(dir, 'xlights_networks.xml');
        const show = parse(await rgb.text(), net ? await net.text() : '');
        show.folderName = dir.name;
        show.folder = dir;
        if (show.backgroundName) {
            const img = await fileIn(dir, show.backgroundName);
            if (img) show.backgroundUrl = URL.createObjectURL(img);
        }
        return show;
    }

    async function loadFromFiles(files) {
        const byName = n => [...files].find(f => f.name.toLowerCase() === n);
        const rgb = byName('xlights_rgbeffects.xml');
        if (!rgb) throw new Error('Include xlights_rgbeffects.xml from your show folder.');
        const net = byName('xlights_networks.xml');
        const show = parse(await rgb.text(), net ? await net.text() : '');
        show.folderName = 'selected files';
        const img = show.backgroundName && byName(show.backgroundName.toLowerCase());
        if (img) show.backgroundUrl = URL.createObjectURL(img);
        return show;
    }

    // ---------- parsing ----------

    const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
    const int = (v, d = 0) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; };
    const truthy = v => /^(1|true)$/i.test(String(v || ''));

    function parse(rgbText, netText) {
        const doc = new DOMParser().parseFromString(rgbText, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('xlights_rgbeffects.xml could not be read (is it a complete file?)');
        const setting = n => { const e = doc.querySelector(`settings > ${n}`); return e ? e.getAttribute('value') : null; };
        const previewW = int(setting('previewWidth'), 1280);
        const previewH = int(setting('previewHeight'), 720);
        const bg = setting('backgroundImage') || '';
        const show = {
            previewW, previewH,
            backgroundName: bg ? bg.split(/[\\/]/).pop() : '',
            // how xLights draws the photo: stretched to the preview, or kept in
            // proportion from the left edge (scaleImage=0, the default)
            backgroundScaled: int(setting('scaleImage'), 0) > 0,
            backgroundAlpha: Math.max(5, Math.min(100, int(setting('backgroundAlpha'), 100))),
            center0: int(setting('Display2DCenter0'), 0) > 0,
            models: new Map(),
            groups: new Map(),
            controllers: [],
            nodeCount: 0,
        };

        for (const el of doc.querySelectorAll('models > model')) {
            const a = {};
            for (const at of el.attributes) a[at.name] = at.value;
            let m;
            try { m = buildModel(a); } catch (e) { console.warn('model', a.name, e); continue; }
            if (!m) continue;
            m.submodels = [...el.querySelectorAll(':scope > subModel')].map(s => subModel(s, m)).filter(Boolean);
            m.faces = [...el.querySelectorAll(':scope > faceInfo')].map(f => faceInfo(f, m)).filter(Boolean);
            show.models.set(m.name, m);
            show.nodeCount += m.nodes.length;
        }
        for (const el of doc.querySelectorAll('modelGroups > modelGroup')) {
            const name = el.getAttribute('name');
            const members = (el.getAttribute('models') || '').split(',').map(s => s.trim()).filter(Boolean);
            show.groups.set(name, { name, members });
        }
        if (netText) {
            try {
                const nd = new DOMParser().parseFromString(netText, 'application/xml');
                show.controllers = [...nd.querySelectorAll('Controller')].map(c => c.getAttribute('Name')).filter(Boolean);
            } catch (e) { /* optional */ }
        }
        return show;
    }

    // "1-5,7,9-12" -> zero-based node indexes
    function ranges(str, max) {
        const out = [];
        for (const part of String(str || '').split(',')) {
            const p = part.trim();
            if (!p) continue;
            const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
            if (m) {
                let a = +m[1], b = +m[2];
                const step = a <= b ? 1 : -1;
                for (let i = a; step > 0 ? i <= b : i >= b; i += step) if (i >= 1 && i <= max) out.push(i - 1);
            } else if (/^\d+$/.test(p)) {
                const i = +p;
                if (i >= 1 && i <= max) out.push(i - 1);
            }
        }
        return out;
    }

    function subModel(el, m) {
        const name = el.getAttribute('name');
        if (!name || name.startsWith('*')) return null;
        const type = el.getAttribute('type') || 'ranges';
        if (type !== 'ranges') return { name, lines: [], nodes: [] };   // subbuffer submodels: skip
        const lines = [];
        for (let i = 0; ; i++) {
            const v = el.getAttribute('line' + i);
            if (v === null) break;
            lines.push(ranges(v, m.nodes.length));
        }
        const nodes = [...new Set(lines.flat())];
        return nodes.length ? { name, lines, nodes } : null;
    }

    function faceInfo(el, m) {
        const name = el.getAttribute('Name');
        if (!name || el.getAttribute('Type') !== 'NodeRange') return null;
        const states = {};
        for (const at of el.attributes) {
            if (/-Color$/.test(at.name) || ['Name', 'Type', 'CustomColors'].includes(at.name)) continue;
            const idx = ranges(at.value, m.nodes.length);
            if (idx.length) states[at.name] = idx;
        }
        const colors = {};
        for (const at of el.attributes) if (/-Color$/.test(at.name) && at.value) colors[at.name.replace(/-Color$/, '')] = at.value;
        return { name, states, colors };
    }

    // ---------- geometry ----------

    // Boxed screen location: scale, rotate (Z*Y*X), optional 2D perspective tilt, then place.
    function boxed(a, pts, perspective = 0) {
        const sx = num(a.ScaleX, 1), sy = num(a.ScaleY, 1), sz = num(a.ScaleZ, 1);
        const rx = num(a.RotateX) * Math.PI / 180, ry = num(a.RotateY) * Math.PI / 180, rz = num(a.RotateZ) * Math.PI / 180;
        const wx = num(a.WorldPosX), wy = num(a.WorldPosY);
        const cx = Math.cos(rx), snx = Math.sin(rx), cy = Math.cos(ry), sny = Math.sin(ry), cz = Math.cos(rz), snz = Math.sin(rz);
        const cp = Math.cos(perspective), sp = Math.sin(perspective);
        for (const p of pts) {
            let x = p.x * sx, y = p.y * sy, z = (p.z || 0) * sz;
            // Rx
            let y1 = y * cx - z * snx, z1 = y * snx + z * cx; y = y1; z = z1;
            // Ry
            let x1 = x * cy + z * sny; z1 = -x * sny + z * cy; x = x1; z = z1;
            // Rz
            x1 = x * cz - y * snz; y1 = x * snz + y * cz; x = x1; y = y1;
            if (perspective) { y1 = y * cp - z * sp; y = y1; }
            p.x = x + wx;
            p.y = y + wy;
            delete p.z;
        }
        return pts;
    }

    // Two-point location: model x runs 0..renderWi along the line from point 1 to point 2.
    function twoPoint(a, pts, renderWi) {
        const x0 = num(a.WorldPosX), y0 = num(a.WorldPosY);
        const dx = num(a.X2), dy = num(a.Y2);
        const len = Math.hypot(dx, dy) || 0.001;
        const ux = dx / len, uy = dy / len;
        const s = len / (renderWi || 1);
        for (const p of pts) {
            const px = p.x * s, py = p.y * s;
            p.x = x0 + px * ux - py * uy;
            p.y = y0 + px * uy + py * ux;
        }
        return pts;
    }

    // Three-point location (arches, candy canes, icicles): like two-point, but the
    // model always stands upright (a line drawn right to left is mirrored, not
    // flipped), and some models stretch by their Height and lean by their Shear.
    // ThreePointScreenLocation::PrepareToDraw.
    function threePoint(a, pts, renderWi, { height = false, defHeight = 1, shear = false } = {}) {
        const x0 = num(a.WorldPosX), y0 = num(a.WorldPosY);
        let dx = num(a.X2), dy = num(a.Y2);
        if (dx === 0 && dy === 0) dx = 0.001;
        const swapped = dx < 0;
        const ax = swapped ? -dx : dx, ay = swapped ? -dy : dy;
        const len = Math.hypot(ax, ay) || 0.001;
        const ux = ax / len, uy = ay / len;
        const sc = len / (renderWi || 1);
        const h = height ? num(a.Height, defHeight) : 1;
        const sh = shear ? num(a.Shear, 0) : 0;
        for (const p of pts) {
            let x = p.x * sc, y = p.y * sc * h;
            // glm::shearY: x moves with y (drops lean so they hang straight on a slope)
            x += sh * y;
            if (swapped) x = -x;
            p.x = x0 + x * ux - y * uy;
            p.y = y0 + x * uy + y * ux;
        }
        return pts;
    }

    function buildModel(a) {
        const type = a.DisplayAs;
        if (!type || type === 'ModelGroup') return null;
        let g;
        switch (type) {
            case 'Custom': g = customGeom(a); break;
            case 'Matrix': g = matrixGeom(a, false); break;
            case 'Tree': g = treeGeom(a); break;
            case 'Single Line': g = singleLineGeom(a); break;
            case 'Poly Line': g = polyLineGeom(a); break;
            case 'Arches': g = archesGeom(a); break;
            case 'Window Frame': g = windowGeom(a); break;
            case 'Cube': g = cubeGeom(a); break;
            case 'Star': g = starGeom(a); break;
            case 'Circle': g = circleGeom(a); break;
            case 'Icicles': g = iciclesGeom(a); break;
            case 'Candy Canes': g = caneGeom(a); break;
            case 'Spinner': g = spinnerGeom(a); break;
            case 'Wreath': g = wreathGeom(a); break;
            case 'Sphere': g = sphereGeom(a); break;
            case 'MultiPoint': g = multiPointGeom(a); break;
            case 'Channel Block': g = channelBlockGeom(a); break;
            default:
                // Vert/Horiz Matrix and "Tree 360" are older names for the same models
                if (/^(Vert|Horiz) Matrix$/.test(type)) g = matrixGeom({ ...a, Vertical: type.startsWith('Vert') ? 'true' : 'false' });
                else if (/^Tree /.test(type)) {
                    const d = type.match(/^Tree (\d+)/);
                    g = treeGeom({ ...a, TreeType: /Flat/.test(type) ? '1' : /Ribbon/.test(type) ? '2' : '0', TreeDegrees: d ? d[1] : a.TreeDegrees });
                }
                else g = pointGeom(a);
        }
        return {
            name: a.name, type, attrs: a,
            pixelSize: Math.max(1, num(a.PixelSize, 2)),
            nodes: g.nodes, bufW: Math.max(1, g.bufW), bufH: Math.max(1, g.bufH),
        };
    }

    function customGeom(a) {
        const W = Math.max(1, parm(a, 'CustomWidth', 'parm1', 1)), H = Math.max(1, parm(a, 'CustomHeight', 'parm2', 1)), D = Math.max(1, int(a.Depth, 1));
        const cells = [];   // [value, row, col, layer]
        if (a.CustomModelCompressed) {
            for (const part of a.CustomModelCompressed.split(';')) {
                const v = part.split(',').map(x => parseInt(x, 10));
                if (v.length >= 3 && v[0] > 0) cells.push([v[0], v[1], v[2], v[3] || 0]);
            }
        } else if (a.CustomModel) {
            a.CustomModel.split('|').forEach((layer, l) => layer.split(';').forEach((row, r) => row.split(',').forEach((c, col) => {
                const v = parseInt(c, 10);
                if (v > 0) cells.push([v, r, col, l]);
            })));
        }
        let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity, minL = Infinity, maxL = -Infinity;
        for (const [, r, c, l] of cells) {
            minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c); minL = Math.min(minL, l); maxL = Math.max(maxL, l);
        }
        if (!cells.length) { minR = 0; maxR = H - 1; minC = 0; maxC = W - 1; minL = maxL = 0; }
        const cR = (minR + maxR) / 2, cC = (minC + maxC) / 2, cL = (minL + maxL) / 2;
        // nodes are numbered by their value; xLights sorts by it
        const values = [...new Set(cells.map(c => c[0]))].sort((p, q) => p - q);
        const index = new Map(values.map((v, i) => [v, i]));
        const nodes = values.map(() => ({ pts: [], bx: 0, by: 0 }));
        for (const [v, r, c, l] of cells) {
            const n = nodes[index.get(v)];
            if (!n.pts.length) { n.bx = l * W + c; n.by = H - r - 1; }
            n.pts.push({ x: c - cC, y: cR - r, z: cL - l });
        }
        const all = nodes.flatMap(n => n.pts);
        boxed(a, all, D > 1 ? 0.1 : 0);
        return { nodes, bufW: W * D, bufH: H };
    }

    // Vertical matrix wiring: strands zig-zag from the start corner.
    function matrixWiring(a) {
        const strings = Math.max(1, int(a.NumStrings, int(a.parm1, 1)));
        const nps = Math.max(1, int(a.NodesPerString, int(a.parm2, 50)));
        let sps = Math.max(1, int(a.StrandsPerString, int(a.parm3, 1)));
        if (sps > nps) sps = nps;
        const strands = strings * sps, pps = Math.floor(nps / sps);
        const ltor = (a.Dir || 'L') !== 'R';
        const botToTop = (a.StartSide || 'B') !== 'T';
        const noZig = truthy(a.NoZig);
        const nodes = [];
        for (let x = 0; x < strands; x++) {
            const seg = x % sps;
            for (let y = 0; y < pps; y++) {
                const by = noZig ? (botToTop ? y : pps - y - 1) : (botToTop === (seg % 2 === 0) ? y : pps - y - 1);
                nodes.push({ bx: ltor ? x : strands - x - 1, by, pts: [] });
            }
        }
        return { nodes, strands, pps };
    }

    function matrixGeom(a) {
        const vertical = a.Vertical === undefined ? true : truthy(a.Vertical);
        const { nodes, strands, pps } = matrixWiring(a);
        const W = vertical ? strands : pps, H = vertical ? pps : strands;
        for (const n of nodes) {
            if (!vertical) { const t = n.bx; n.bx = n.by; n.by = H - 1 - t; }
            n.pts.push({ x: n.bx - (W - 1) / 2, y: n.by - (H - 1) / 2 });
        }
        boxed(a, nodes.flatMap(n => n.pts));
        return { nodes, bufW: W, bufH: H };
    }

    function treeGeom(a) {
        const { nodes, strands, pps } = matrixWiring(a);
        const W = strands, H = pps;
        const type = int(a.TreeType, 0);
        const degrees = type === 1 ? 0 : type === 2 ? -1 : num(a.TreeDegrees, 360);
        const ratio = num(a.TreeBottomTopRatio, 6);
        const rotation = num(a.TreeRotation, 3);
        const spiral = num(a.TreeSpiralRotations, 0);
        const perspective = num(a.TreePerspective, 0.2);
        if (degrees > 0) {
            const RH = H * 3, RW = RH / 1.8;
            const rad = degrees * Math.PI / 180;
            let radius = RW / 2, top = ratio !== 0 ? radius / Math.abs(ratio) : radius;
            if (ratio < 0) [top, radius] = [radius, top];
            let start = -rad / 2 + rotation * Math.PI / 180;
            const inc = degrees < 350 && W > 1 ? rad / (W - 1) : rad / W;
            for (const n of nodes) {
                const ang = start + n.bx * inc + spiral * 2 * Math.PI * (n.by / Math.max(1, H - 1));
                const pos = H > 1 ? n.by / (H - 1) : 0.5;
                const xb = radius * Math.sin(ang), xt = top * Math.sin(ang);
                const zb = radius * Math.cos(ang), zt = top * Math.cos(ang);
                n.pts.push({ x: xb + (xt - xb) * pos, y: RH * pos - RH / 2, z: zb + (zt - zb) * pos });
            }
        } else {
            const scale = degrees === -1 ? 5 : 4, RH = H * 2;
            for (const n of nodes) {
                const xt = (n.bx + 0.5 - W / 2) * 0.9, xb = (n.bx + 0.5 - W / 2) * scale;
                const pos = H > 1 ? n.by / (H - 1) : 0.5;
                n.pts.push({ x: xb + (xt - xb) * pos, y: RH * pos - RH / 2 });
            }
        }
        boxed(a, nodes.flatMap(n => n.pts), perspective);
        return { nodes, bufW: W, bufH: H };
    }

    function lineCount(a) {
        return Math.max(1, parm(a, 'NumStrings', 'parm1', 1)) * Math.max(1, parm(a, 'NodesPerString', 'parm2', 50));
    }

    function singleLineGeom(a) {
        const n = lineCount(a);
        const rev = a.Dir === 'R';
        const nodes = [];
        for (let i = 0; i < n; i++) {
            const bx = rev ? n - 1 - i : i;
            nodes.push({ bx, by: 0, pts: [{ x: bx + 0.5, y: 0 }] });
        }
        twoPoint(a, nodes.flatMap(p => p.pts), n);
        return { nodes, bufW: n, bufH: 1 };
    }

    function polyLineGeom(a) {
        const n = Math.max(1, parm(a, 'NodesPerString', 'parm2', 50)) * Math.max(1, int(a.PolyStrings, 1));
        const raw = (a.PointData || '').split(',').map(Number).filter(Number.isFinite);
        const sx = num(a.ScaleX, 1), sy = num(a.ScaleY, 1), wx = num(a.WorldPosX), wy = num(a.WorldPosY);
        const P = [];
        for (let i = 0; i + 1 < raw.length; i += 3) P.push([wx + raw[i] * sx, wy + raw[i + 1] * sy]);
        if (P.length < 2) return pointGeom(a);
        const seg = [];
        let total = 0;
        for (let i = 0; i + 1 < P.length; i++) { const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); seg.push(L); total += L; }
        const rev = a.Dir === 'R';
        const nodes = [];
        for (let i = 0; i < n; i++) {
            let d = (i + 0.5) / n * total, k = 0;
            while (k < seg.length - 1 && d > seg[k]) { d -= seg[k]; k++; }
            const f = seg[k] ? d / seg[k] : 0;
            const bx = rev ? n - 1 - i : i;
            nodes.push({ bx, by: 0, pts: [{ x: P[k][0] + (P[k + 1][0] - P[k][0]) * f, y: P[k][1] + (P[k + 1][1] - P[k][1]) * f }] });
        }
        return { nodes, bufW: n, bufH: 1 };
    }

    function archesGeom(a) {
        const arches = Math.max(1, parm(a, 'NumArches', 'parm1', 1)), per = Math.max(1, parm(a, 'NodesPerArch', 'parm2', 25));
        const arc = num(a.Arc, 180), height = num(a.Height, 1);
        const rev = a.Dir === 'R';
        const span = arches * per;
        const nodes = [];
        for (let k = 0; k < arches; k++) {
            for (let j = 0; j < per; j++) {
                const t = (j + 0.5) / per;
                const ang = (arc * (t - 0.5)) * Math.PI / 180;
                const half = per / 2;
                const x = k * per + half + half * Math.sin(ang) / Math.max(0.0001, Math.sin(arc / 2 * Math.PI / 180));
                const y = half * height * (Math.cos(ang) - Math.cos(arc / 2 * Math.PI / 180)) * 2;
                const bx = rev ? per - 1 - j : j;
                nodes.push({ bx, by: k, pts: [{ x, y }] });
            }
        }
        threePoint(a, nodes.flatMap(n => n.pts), span);
        return { nodes, bufW: per, bufH: arches };
    }

    function windowGeom(a) {
        const top = parm(a, 'TopNodes', 'parm1', 0), side = parm(a, 'SideNodes', 'parm2', 0), bottom = parm(a, 'BottomNodes', 'parm3', 0);
        const w = Math.max(top, bottom) + 2, h = Math.max(1, side);
        const nodes = [];
        const push = (bx, by, x, y) => nodes.push({ bx, by, pts: [{ x, y }] });
        // clockwise from the bottom of the left side
        for (let i = 0; i < side; i++) push(0, i, -w / 2, -h / 2 + (i + 0.5) * h / side);
        for (let i = 0; i < top; i++) push(1 + Math.round(i * (w - 2) / Math.max(1, top)), h - 1, -w / 2 + (i + 1) * w / (top + 1), h / 2);
        for (let i = 0; i < side; i++) push(w - 1, h - 1 - i, w / 2, h / 2 - (i + 0.5) * h / side);
        for (let i = 0; i < bottom; i++) push(w - 2 - Math.round(i * (w - 2) / Math.max(1, bottom)), 0, w / 2 - (i + 1) * w / (bottom + 1), -h / 2);
        if (a.Rotation === 'Counter Clockwise' || a.Rotation === 'CCW') nodes.reverse();
        boxed(a, nodes.flatMap(n => n.pts));
        return { nodes, bufW: w, bufH: h };
    }

    function cubeGeom(a) {
        const w = Math.max(1, parm(a, 'CubeWidth', 'parm1', 5)), h = Math.max(1, parm(a, 'CubeHeight', 'parm2', 5)), d = Math.max(1, parm(a, 'CubeDepth', 'parm3', 5));
        const nodes = [];
        // CubeModel::InitModel: raw node units, halved with C++ integer division,
        // then scaled by the model's ScaleX/Y/Z like every boxed model. (A row of
        // peace stakes is 15 nodes x 35.5 = ~530 px wide; the owner confirmed
        // that spread matches xLights.)
        const hw = Math.floor(w / 2), hh = Math.floor(h / 2), hd = Math.floor(d / 2);
        for (let lz = 0; lz < d; lz++) for (let ly = 0; ly < h; ly++) for (let lx = 0; lx < w; lx++) {
            nodes.push({ bx: lx + lz * w, by: ly, pts: [{ x: lx - hw, y: ly - hh, z: d - lz - 1 - hd }] });
        }
        boxed(a, nodes.flatMap(n => n.pts), 0.1);
        return { nodes, bufW: w * d, bufH: h };
    }

    function starGeom(a) {
        const points = Math.max(2, parm(a, 'StarPoints', 'parm3', 5));
        const ratio = num(a.starRatio, 2.618);
        let layers = (a.LayerSizes || '').split(',').map(x => parseInt(x, 10)).filter(x => x > 0);
        if (!layers.length && a.starSizes) layers = a.starSizes.split(',').map(x => parseInt(x, 10)).filter(x => x > 0);
        if (!layers.length) layers = [Math.max(1, parm(a, 'NodesPerString', 'parm2', 50)) * Math.max(1, parm(a, 'NumStrings', 'parm1', 1))];
        const size = Math.max(...layers);
        const sorted = [...layers].sort((p, q) => p - q);
        const nodes = [];
        layers.forEach((count, li) => {
            const R = size / 2 * (sorted.indexOf(count) + 1) / sorted.length;
            const r = R / ratio;
            const verts = [];
            for (let k = 0; k < points * 2; k++) {
                const ang = -Math.PI / 2 + Math.PI / points / 2 + k * Math.PI / points;   // start below centre
                const rr = k % 2 === 0 ? r : R;
                verts.push([rr * Math.cos(ang), rr * Math.sin(ang)]);
            }
            verts.push(verts[0]);
            const lens = [];
            let tot = 0;
            for (let k = 0; k + 1 < verts.length; k++) { const L = Math.hypot(verts[k + 1][0] - verts[k][0], verts[k + 1][1] - verts[k][1]); lens.push(L); tot += L; }
            for (let i = 0; i < count; i++) {
                let dd = (i + 0.5) / count * tot, k = 0;
                while (k < lens.length - 1 && dd > lens[k]) { dd -= lens[k]; k++; }
                const f = dd / lens[k];
                const x = verts[k][0] + (verts[k + 1][0] - verts[k][0]) * f, y = verts[k][1] + (verts[k + 1][1] - verts[k][1]) * f;
                nodes.push({ bx: Math.round(x + size / 2), by: Math.round(y + size / 2), pts: [{ x, y }] });
            }
        });
        boxed(a, nodes.flatMap(n => n.pts));
        return { nodes, bufW: size + 1, bufH: size + 1 };
    }

    const parm = (a, key, parmKey, def) => int(a[key], int(a[parmKey], def));
    const isLtoR = a => a.Dir !== 'R';
    const isBotToTop = (a, def = true) => a.StartSide === undefined ? def : a.StartSide === 'B';
    function layerSizes(a, total) {
        let ls = (a.LayerSizes || '').split(',').map(x => parseInt(x, 10)).filter(x => x > 0);
        if (!ls.length && a.circleSizes) ls = a.circleSizes.split(',').map(x => parseInt(x, 10)).filter(x => x > 0).reverse();
        if (ls.length <= 1) return [total];
        // trim to the lights the model has (CircleModel::InitCircle)
        let cnt = 0;
        return ls.map(n => { const v = cnt + n > total ? Math.max(0, total - cnt) : n; cnt += n; return v; });
    }

    // CircleModel::InitCircle + SetCircleCoord: rings, largest layer first.
    function circleGeom(a) {
        const total = parm(a, 'NumStrings', 'parm1', 1) * parm(a, 'NodesPerString', 'parm2', 1);
        const layers = layerSizes(a, total);
        const maxL = Math.max(1, ...layers);
        const centre = parm(a, 'centerPercent', 'parm3', 0);
        const insideOut = a.InsideOut === '1';
        const ltor = isLtoR(a), b2t = isBotToTop(a, false);
        const nL = layers.length;
        const maxR = maxL / 2, minR = centre / 100 * maxR;
        const nodes = [];
        layers.forEach((count, circle) => {
            const fudge = -1 * Math.floor(maxL / Math.max(1, count)) + 1;
            const radius = nL === 1 ? maxR : insideOut ? minR + (maxR - minR) * (1 - (nL - circle - 1) / (nL - 1)) : minR + (maxR - minR) * (1 - circle / (nL - 1));
            for (let n = 0; n < count; n++) {
                const pct = count === 1 ? n : n / (count - 1);
                const bx = count === maxL ? n : Math.floor(pct * (maxL - 1 + fudge));
                let ang = (b2t ? -Math.PI : 0) + Math.PI * (count === 1 ? 0 : n / count) * 2;
                if (!ltor) ang = -ang;
                nodes.push({ bx: Math.max(0, bx), by: insideOut ? nL - circle - 1 : circle, pts: [{ x: Math.sin(ang) * radius, y: Math.cos(ang) * radius }] });
            }
        });
        boxed(a, nodes.flatMap(n => n.pts));
        return { nodes, bufW: maxL, bufH: nL };
    }

    // IciclesModel::InitModel: drops hang from the top line in a repeating pattern.
    function iciclesGeom(a) {
        const strings = parm(a, 'NumStrings', 'parm1', 1), per = parm(a, 'NodesPerString', 'parm2', 1);
        const drops = (a.DropPattern || '3,4,5,4').split(',').map(x => parseInt(x, 10)).filter(x => x > 0);
        if (!drops.length) drops.push(1);
        const maxH = Math.max(...drops);
        const alt = a.AlternateNodes === 'true';
        const nodes = [];
        let width = -1;
        for (let s = 0; s < strings; s++) {
            let lights = per, y = 0, d = 0;
            width++;
            while (lights > 0) {
                while (y >= drops[d]) { width++; y = 0; d = (d + 1) % drops.length; }
                const inDrop = drops[d];
                let sy, by;
                if (alt) {
                    sy = y + 1 <= (inDrop + 1) / 2 ? 2 * y : (inDrop - (y + 1)) * 2 + 1;
                } else sy = y;
                by = maxH - 1 - sy;
                nodes.push({ bx: width, by, pts: [{ x: width, y: sy }] });
                lights--; y++;
            }
        }
        if (!isLtoR(a)) for (const n of nodes) { n.bx = width - n.bx; n.pts[0].x = width - n.pts[0].x; }
        let renderW = width;
        if (width === 0) { for (const n of nodes) n.pts[0].x = 0.5; renderW = 1; }
        threePoint(a, nodes.flatMap(n => n.pts), renderW, { height: true, defHeight: -0.5, shear: true });
        return { nodes, bufW: width + 1, bufH: maxH };
    }

    // CandyCaneModel::SetCaneCoord (pixel canes, one light per node): an upright
    // then a hook, canes side by side with a gap of 2.
    function caneGeom(a) {
        const canes = parm(a, 'NumCanes', 'parm1', 1), seg = parm(a, 'NodesPerCane', 'parm2', 1);
        const lpn = Math.max(1, parm(a, 'LightsPerNode', 'parm3', 1));
        const mh = num(a.Height, 1), ch = num(a.CandyCaneHeight, 1);
        const reverse = a.CandyCaneReverse === 'true', sticks = a.CandyCaneSticks === 'true', alt = a.AlternateNodes === 'true';
        const angle = num(a.CandyCaneSkew, num(a.Angle, 0)) * Math.PI / 180;
        const perCane = seg * lpn;
        const upright = Math.floor(seg * 6 / 9) * lpn;
        const wpc = perCane * 3 / 9, gap = 2;
        const width = canes * wpc + (canes - 1) * gap;
        const rot = (cx, x, y) => { const c = Math.cos(angle), s = Math.sin(angle); const dx = x - cx; return { x: dx * c - y * s + cx, y: dx * s + y * c }; };
        // which node sits at light y of a cane (alternate nodes interleave)
        const nodeAt = (i, k) => {
            if (!alt) return i * seg + k;
            for (let x = 0; x < seg; x++) {
                const by = x + 1 <= (seg + 1) / 2 ? 2 * x : (seg - (x + 1)) * 2 + 1;
                if (by === k) return i * seg + x;
            }
            return i * seg + k;
        };
        const ltor = isLtoR(a);
        const nodes = [];
        for (let i = 0; i < canes; i++) for (let x = 0; x < seg; x++) {
            const by = alt ? (x + 1 <= (seg + 1) / 2 ? 2 * x : (seg - (x + 1)) * 2 + 1) : x;
            nodes.push({ bx: ltor ? i : canes - 1 - i, by, pts: [] });
        }
        for (let i = 0; i < canes; i++) {
            if (sticks) {
                const x = i * (wpc + gap) + wpc / 2;
                for (let y = 0; y < perCane; y++) nodes[nodeAt(i, Math.floor(y / lpn))].pts.push(rot(x, x, ch * y * mh));
                continue;
            }
            let x = i * (wpc + gap) + (reverse ? wpc : 0);
            const ox = x;
            const cx = x + (reverse ? -1 : 1) * wpc / 2 * mh;
            let y = 0, cur = 0;
            while (cur < upright) { nodes[nodeAt(i, Math.floor(y / lpn))].pts.push(rot(ox, x, ch * y * mh)); y++; cur++; }
            y--;
            const arc = perCane - upright;
            while (cur < perCane) {
                const aa = Math.PI - Math.PI * (cur - upright + 1) / arc;
                const y2 = Math.sin(aa) * wpc / 2 * mh, x2 = Math.cos(aa) * wpc / 2 * mh;
                nodes[nodeAt(i, Math.floor(cur / lpn))].pts.push(rot(ox, reverse ? cx - x2 : cx + x2, ch * (y * mh + y2)));
                cur++;
            }
        }
        for (const n of nodes) if (!n.pts.length) n.pts.push({ x: 0, y: 0 });
        threePoint(a, nodes.flatMap(n => n.pts), width);
        return { nodes, bufW: canes, bufH: seg };
    }

    // SpinnerModel::InitModel + SetSpinnerCoord: arms out from a hollow centre.
    function spinnerGeom(a) {
        const strings = parm(a, 'NumStrings', 'parm1', 1), per = parm(a, 'NodesPerArm', 'parm2', 1), armsPer = parm(a, 'ArmsPerString', 'parm3', 1);
        const hollow = int(a.Hollow, 20), startAngle = int(a.StartAngle, 0), arc = int(a.Arc, 360);
        const zig = a.ZigZag === 'true', alt = a.Alternate === 'true';
        const ltor = isLtoR(a), fromCentre = !isBotToTop(a);
        const arms = strings * armsPer;
        let ang = Math.PI * 2 * (270 + startAngle) / 360;
        let inc = Math.PI * 2 * arc / (arms * 360);
        if (arc < 360 && arms > 1) inc = Math.PI * 2 * arc / ((arms - 1) * 360);
        const b2t = isBotToTop(a);
        const nodes = [];
        for (let x = 0; x < arms; x++) {
            for (let y = 0; y < per; y++) {
                let by;
                if (alt) { by = y + 1 <= (per + 1) / 2 ? 2 * y : (per - (y + 1)) * 2 + 1; by = per - by - 1; }
                else if (!zig || x % 2 === 0) by = b2t ? y : per - y - 1;
                else by = b2t ? per - y - 1 : y;
                let n1;
                if (alt) n1 = y + 1 <= (per + 1) / 2 ? 2 * y : (per - (y + 1)) * 2 + 1;
                else {
                    n1 = fromCentre ? y : per - y - 1;
                    if (zig && x % 2 > 0) n1 = fromCentre ? per - y - 1 : y;
                }
                const r = 0.5 + n1 + hollow * 2 * per / 100;
                nodes.push({ bx: ltor ? x : arms - x - 1, by, pts: [{ x: r * Math.cos(ang), y: r * Math.sin(ang) }] });
            }
            ang += ltor ? inc : -inc;
        }
        boxed(a, nodes.flatMap(n => n.pts));
        return { nodes, bufW: arms, bufH: per };
    }

    // WreathModel::InitWreath: a ring drawn in buffer cells, centred.
    function wreathGeom(a) {
        const total = Math.max(1, parm(a, 'NumStrings', 'parm1', 1) * parm(a, 'NodesPerString', 'parm2', 50));
        const off = Math.floor(total / 2), r = off;
        const b2t = isBotToTop(a), ltor = isLtoR(a);
        let pct = b2t ? 0.5 : 0, incr = 1 / total;
        if (ltor !== b2t) incr = -incr;
        const W = total + 1, nodes = [];
        for (let n = 0; n < total; n++) {
            const bx = Math.trunc(r * Math.sin(pct * 2 * Math.PI) + off + 0.5), by = Math.trunc(r * Math.cos(pct * 2 * Math.PI) + off + 0.5);
            nodes.push({ bx, by, pts: [{ x: bx - Math.floor(W / 2), y: by - Math.floor(W / 2) }] });
            pct += incr; if (pct >= 1) pct -= 1; if (pct < 0) pct += 1;
        }
        boxed(a, nodes.flatMap(n => n.pts));
        return { nodes, bufW: W, bufH: W };
    }

    // SphereModel::SetSphereCoord: a vertical matrix wrapped round a globe.
    function sphereGeom(a) {
        const { nodes, strands, pps } = matrixWiring(a);
        const W = strands, H = pps;
        const R = Math.max(W, H) / 1.8 / 2;
        const deg = num(a.Degrees, 360), lat0 = num(a.StartLatitude, -86), lat1 = num(a.EndLatitude, 86);
        const rad = d => d * Math.PI / 180;
        const remove = rad(360 - deg), fudge = rad((360 - deg) / W);
        const h0 = rad(360) / 4 + 0.003 - remove / 2, hInc = (-rad(360) + remove - fudge) / W;
        const v0 = rad(lat0 - 90), vInc = (rad(-lat0) + rad(lat1)) / Math.max(1, H - 1);
        for (const n of nodes) {
            const h = h0 + n.bx * hInc, v = v0 + n.by * vInc, sv = Math.sin(v);
            n.pts.push({ x: R * Math.cos(h) * sv, y: R * Math.cos(v), z: R * Math.sin(h) * sv });
        }
        // Spheres saved before version 8 were drawn squashed; xLights rescales
        // them on load to keep their size (DeserializeSphere).
        let at = a;
        if (!(int(a.versionNumber, 0) >= 8)) {
            const k = H / Math.max(H, W);
            at = { ...a, ScaleX: String(num(a.ScaleX, 1) * k / 1.8), ScaleZ: String(num(a.ScaleZ, 1) * k / 1.8), ScaleY: String(num(a.ScaleY, 1) * k) };
        }
        boxed(at, nodes.flatMap(n => n.pts), 0.1);
        return { nodes, bufW: W, bufH: H };
    }

    // MultiPoint: one light at each placed point, in order.
    function multiPointGeom(a) {
        const raw = (a.PointData || '').split(',').map(Number).filter(Number.isFinite);
        const sx = num(a.ScaleX, 1), sy = num(a.ScaleY, 1), wx = num(a.WorldPosX), wy = num(a.WorldPosY);
        const nodes = [];
        for (let i = 0; i + 1 < raw.length; i += 3) nodes.push({ bx: nodes.length, by: 0, pts: [{ x: wx + raw[i] * sx, y: wy + raw[i + 1] * sy }] });
        if (!nodes.length) return pointGeom(a);
        return { nodes, bufW: nodes.length, bufH: 1 };
    }

    // ChannelBlock: single channels in a row along its line.
    function channelBlockGeom(a) {
        const n = Math.max(1, parm(a, 'NumChannels', 'parm1', 1));
        const nodes = [];
        for (let i = 0; i < n; i++) nodes.push({ bx: i, by: 0, pts: [{ x: i + 0.5, y: 0 }] });
        twoPoint(a, nodes.flatMap(p => p.pts), n);
        return { nodes, bufW: n, bufH: 1 };
    }

    function pointGeom(a) {
        return { nodes: [{ bx: 0, by: 0, pts: [{ x: num(a.WorldPosX), y: num(a.WorldPosY) }] }], bufW: 1, bufH: 1 };
    }

    // ---------- targets: what a sequence row addresses ----------

    // Resolve a row name (group, model or "Model/SubModel") to its nodes, each
    // with buffer coordinates u,v in 0..1 for that row's default buffer.
    function resolveTarget(show, name, seen = new Set()) {
        if (seen.has(name)) return [];
        seen.add(name);
        // u,v: the row's own buffer. mu,mv: the node's own model buffer, used
        // when a group's effect runs "per model".
        const m = show.models.get(name);
        if (m) {
            return m.nodes.map((n, i) => {
                const u = m.bufW > 1 ? n.bx / (m.bufW - 1) : 0.5, v = m.bufH > 1 ? n.by / (m.bufH - 1) : 0.5;
                return { model: m, i, u, v, mu: u, mv: v };
            });
        }
        const slash = name.indexOf('/');
        if (slash > 0) {
            const mm = show.models.get(name.slice(0, slash));
            const sm = mm && mm.submodels.find(s => s.name === name.slice(slash + 1));
            if (sm) {
                const out = [];
                const rows = sm.lines.filter(l => l.length);
                rows.forEach((line, r) => line.forEach((i, k) => {
                    const u = line.length > 1 ? k / (line.length - 1) : 0.5, v = rows.length > 1 ? r / (rows.length - 1) : 0.5;
                    out.push({ model: mm, i, u, v, mu: u, mv: v });
                }));
                return out;
            }
        }
        const g = show.groups.get(name);
        if (g) {
            // Group buffer: the members' positions on the house, normalised
            // (what xLights calls a per-preview buffer).
            const all = [];
            for (const mem of g.members) for (const t of resolveTarget(show, mem, seen)) all.push(t);
            const uniq = new Map();
            for (const t of all) uniq.set(t.model.name + '#' + t.i, t);
            const list = [...uniq.values()];
            let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (const t of list) { const p = t.model.nodes[t.i].pts[0]; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
            return list.map(t => {
                const p = t.model.nodes[t.i].pts[0];
                return { model: t.model, i: t.i, u: x1 > x0 ? (p.x - x0) / (x1 - x0) : 0.5, v: y1 > y0 ? (p.y - y0) / (y1 - y0) : 0.5, mu: t.mu, mv: t.mv };
            });
        }
        return [];
    }

    return { canPickFolder, pickFolder, savedFolder, permission, loadFromFolder, loadFromFiles, parse, resolveTarget, kvGet, kvPut };
})();
