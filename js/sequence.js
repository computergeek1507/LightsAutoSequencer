'use strict';

// Turns the user's plan ("chorus: arches + mega tree, chase, Christmas colours";
// "every beat: snowflakes flash") into rows of timed effects, renders preview
// frames from them, and writes an xLights .xsq.
const Sequencer = (() => {
    const FRAME_MS = 25;
    const MIN_MS = 50;             // xLights drops effects under 2 frames
    const LYRIC_TRACK = 'Lyrics';

    // "Chorus 2" -> "Chorus", "Chorus 1 b" -> "Chorus"
    const kindOf = name => String(name).replace(/(\s+(\d+|[a-z]))+$/i, '').trim();

    // What a row reacts to. 'span' = the whole section (or whole song).
    const TRIGGERS = [
        { id: 'span', label: 'The whole time' },
        { id: 'beats', label: 'Every beat' },
        { id: 'downbeats', label: 'First beat of each bar' },
        { id: 'kick', label: 'Kick drum hits' },
        { id: 'snare', label: 'Snare hits' },
        { id: 'singing', label: 'While someone sings', vocal: true },
        { id: 'lines', label: 'Each sung line', vocal: true },
        { id: 'words', label: 'Each sung word', vocal: true },
        { id: 'leadin', label: 'Build-up: last 2 bars of the part' },
        { id: 'first', label: 'First beat of the part' },
    ];
    // Triggers placed from the part itself rather than from song-wide marks.
    const PART_TRIGGERS = new Set(['leadin', 'first']);
    const EVENTS = TRIGGERS.filter(t => t.id !== 'span');

    function marksFor(id, song) {
        const g = song.grid, m = song.model, L = song.lyr;
        const T = g.T, dur = m.duration;
        const onsets = list => {
            const strong = list.filter(o => o.s >= 0.35);
            return strong.map((o, i) => ({ s: o.t, e: Math.min(o.t + T * 0.5, i + 1 < strong.length ? strong[i + 1].t : dur, dur) }));
        };
        switch (id) {
            case 'beats': return g.beats.map(b => ({ s: b.s, e: b.e }));
            case 'downbeats': return g.bars.map(b => ({ s: b.s, e: Math.min(b.e, b.s + T * 2) }));
            case 'kick': return onsets(m.onsets.kick);
            case 'snare': return onsets(m.onsets.snare);
            case 'singing': return L ? L.vseg.map(x => ({ s: x.s, e: x.e })) : [];
            case 'lines': return L ? L.lines.map(x => ({ s: x.s, e: x.e })) : [];
            case 'words': return L ? L.words.map(x => ({ s: x.s, e: x.e })) : [];
        }
        return [];
    }

    // ---------- the plan ----------
    //
    // { version: 2,
    //   whole:    { rows: [row] },                 // under everything, whole song
    //   sections: { [sectionId]: { rows: [row], pool: [targets], dip: beats } } }
    // dip: the part's lights stop that many beats before its end (a held breath
    // before the next part comes in).
    // row = { id, trigger, targets, effect, options, colors, scheme, perModel,
    //         level (brightness %, default 100), endFade (seconds of fade-out at the end),
    //         bars: [from, to) bar indexes within the part (a phrase of a long part; default all),
    //         colourBy: 'bar' (hits change colour each bar rather than each hit) }

    const emptyPlan = () => ({ version: 2, whole: { rows: [] }, sections: {} });
    const newId = () => Math.random().toString(36).slice(2, 9);

    // Plans made before sections had their own lights: rows applied to every
    // section of a kind, and events carried a list of kinds.
    function migrate(p, song) {
        if (p && p.version === 2) return p;
        const out = emptyPlan();
        if (!p || !Array.isArray(p.rows) || !song) return out;
        const secs = song.sections;
        const add = (sid, row) => { (out.sections[sid] = out.sections[sid] || { rows: [], pool: [] }).rows.push({ ...row, id: newId() }); };
        for (const r of p.rows) {
            const base = { targets: r.targets, effect: r.effect, options: r.options || {}, colors: r.colors, scheme: r.scheme, perModel: r.perModel };
            if (r.when === 'part:*') out.whole.rows.push({ ...base, id: newId(), trigger: 'span' });
            else if (r.when.startsWith('part:')) {
                const k = r.when.slice(5);
                for (const s of secs) if (kindOf(s.name) === k) add(s.id, { ...base, trigger: 'span' });
            } else if (r.when.startsWith('event:')) {
                const ev = r.when.slice(6);
                if (!r.during || !r.during.length) out.whole.rows.push({ ...base, id: newId(), trigger: ev });
                else for (const s of secs) if (r.during.includes(kindOf(s.name))) add(s.id, { ...base, trigger: ev });
            }
        }
        return out;
    }

    function cloneRows(rows) {
        return rows.map(r => ({ ...JSON.parse(JSON.stringify(r)), id: newId() }));
    }

    // ---------- generation ----------

    function generate(plan, song, show) {
        const rows = new Map();       // target -> { layers: [[fx]] }
        const snap = s => Math.round(s * 1000 / FRAME_MS) * FRAME_MS;
        let count = 0;
        const problems = [];
        const markCache = new Map();
        const marks = id => { if (!markCache.has(id)) markCache.set(id, marksFor(id, song)); return markCache.get(id); };

        const place = (target, fx, minLayer) => {
            let r = rows.get(target);
            if (!r) { r = { layers: [] }; rows.set(target, r); }
            for (let li = minLayer; ; li++) {
                if (!r.layers[li]) r.layers[li] = [];
                const layer = r.layers[li];
                let ok = true;
                for (let j = layer.length - 1; j >= 0; j--) {
                    const o = layer[j];
                    if (o.sMs < fx.eMs && fx.sMs < o.eMs) { ok = false; break; }
                }
                if (ok) { layer.push(fx); fx.layer = li; return; }
            }
        };

        // containers: the whole song first, then each section in order
        const containers = [{ s: 0, e: song.model.duration, rows: (plan.whole && plan.whole.rows) || [], whole: true }];
        for (const sec of song.sections) {
            const c = plan.sections && plan.sections[sec.id];
            if (c && c.rows.length) containers.push({ s: sec.s, e: Math.max(sec.s + 0.1, sec.e - (c.dip > 0 ? c.dip * song.grid.T : 0)), rows: c.rows, sectionId: sec.id, bars: song.grid.bars.filter(b => b.s >= sec.s - 0.05 && b.s < sec.e - 0.05) });
        }
        // span rows take the bottom layers; event rows stack above them
        const jobs = [];
        for (const c of containers) for (const row of c.rows) jobs.push({ c, row });
        jobs.sort((a, b) => ((a.row.trigger || 'span') === 'span' ? 0 : 1) - ((b.row.trigger || 'span') === 'span' ? 0 : 1));

        for (const { c, row } of jobs) {
            const eff = Effects.get(row.effect);
            if (!eff || !row.targets || !row.targets.length) continue;
            const colors = row.colors && row.colors.length ? row.colors : ['#FFFFFF'];
            const pal = colors.map(Effects.hexToRgb);
            const opts = { ...eff.options, ...(row.options || {}) };
            const trig = row.trigger || 'span';
            const isEvent = trig !== 'span';
            // a phrase of the part: only its bars
            let ws = c.s, we = c.e;
            if (row.bars && c.bars && c.bars.length) {
                const [b0, b1] = row.bars;
                ws = b0 > 0 && c.bars[b0] ? c.bars[b0].s : c.s;
                we = b1 != null && b1 < c.bars.length ? Math.min(c.e, c.bars[b1].s) : c.e;
                if (we - ws < 0.05) continue;
            }
            let spans;
            if (!isEvent) spans = [{ s: ws, e: we }];
            else if (PART_TRIGGERS.has(trig)) spans = partSpans(trig, c, song);
            else spans = marks(trig).filter(m => m.s >= ws - 0.001 && m.s < we).map(m => ({ s: m.s, e: Math.min(m.e, we) }));
            const barIndex = t => { const bs = song.grid.bars; let lo = 0, hi = bs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bs[mid].s <= t + 0.01) lo = mid; else hi = mid - 1; } return lo; };
            spans.forEach((sp, n) => {
                const index = row.colourBy === 'bar' ? barIndex(sp.s) : n;
                const sMs = snap(sp.s), eMs = snap(sp.e);
                if (eMs - sMs < MIN_MS) return;
                for (const target of row.targets) {
                    if (eff.needsFace) {
                        const m = show.models.get(target);
                        if (!m || !m.faces.length) { if (!problems.includes(target)) problems.push(target); continue; }
                    }
                    const o = eff.needsFace ? { ...opts, face: opts.face || show.models.get(target).faces[0].name } : opts;
                    const isGroup = show.groups.has(target);
                    const perModel = isGroup && (row.perModel ?? eff.perModel);
                    const level = row.level != null ? Math.max(0, Math.min(100, row.level)) : 100;
                    const endFade = row.endFade > 0 && n === spans.length - 1 ? Math.min(row.endFade, (eMs - sMs) / 1000) : 0;
                    place(target, { sMs, eMs, eff, o, colors, pal, index, rowId: row.id, isGroup, perModel, level, endFade }, isEvent ? 1 : 0);
                    count++;
                }
            });
        }
        for (const r of rows.values()) {
            for (let i = 0; i < r.layers.length; i++) if (!r.layers[i]) r.layers[i] = [];
            for (const l of r.layers) l.sort((a, b) => a.sMs - b.sMs);
        }
        return { rows, count, problems };
    }

    // The last two bars of a part (a build-up into the next one), or its first beat.
    function partSpans(trig, c, song) {
        const bars = song.grid.bars.filter(b => b.s >= c.s - 0.05 && b.s < c.e - 0.05);
        if (!bars.length) return [];
        if (trig === 'first') return [{ s: c.s, e: Math.min(c.e, c.s + song.grid.T * 2) }];
        const from = bars[Math.max(0, bars.length - 2)].s;
        return from > c.s + 0.05 || bars.length <= 2 ? [{ s: from, e: c.e }] : [];
    }

    // ---------- preview rendering ----------

    // stride > 1 keeps every stride-th light of each row: enough for measuring
    // the show (fit check), much cheaper than drawing it.
    function prepare(show, gen, song, stride = 1) {
        let offset = 0;
        for (const m of show.models.values()) { m.offset = offset; offset += m.nodes.length; }
        const targets = [];
        for (const [name, r] of gen.rows) {
            let list = Show.resolveTarget(show, name);
            if (stride > 1) list = list.filter((t, i) => i % stride === 0);
            if (!list.length) continue;
            const n = list.length;
            const N = { n, u: new Float32Array(n), v: new Float32Array(n), k: new Int32Array(n), seed: new Int32Array(n), g: new Int32Array(n), w: 96, h: 50 };
            // the same nodes seen through each model's own buffer
            const NM = { ...N, u: new Float32Array(n), v: new Float32Array(n), k: new Int32Array(n) };
            list.forEach((t, i) => {
                N.u[i] = t.u; N.v[i] = t.v; N.k[i] = i; N.g[i] = t.model.offset + t.i; N.seed[i] = N.g[i] * 2654435761 | 0;
                NM.u[i] = t.mu; NM.v[i] = t.mv; NM.k[i] = t.i;
            });
            const m = show.models.get(name);
            if (m) { N.w = NM.w = Math.max(8, m.bufW); N.h = NM.h = Math.max(8, m.bufH); }
            targets.push({ name, N, NM, model: m || null, layers: r.layers.filter(Boolean), tmp: new Float32Array(3 * n), acc: new Float32Array(3 * n) });
        }
        return { targets, total: offset, colors: new Float32Array(3 * offset) };
    }

    function activeAt(layer, ms) {
        let lo = 0, hi = layer.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const f = layer[mid];
            if (f.eMs <= ms) lo = mid + 1;
            else if (f.sMs > ms) hi = mid - 1;
            else return f;
        }
        return null;
    }

    function itemAt(list, t) {
        let lo = 0, hi = list.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].e <= t) lo = mid + 1;
            else if (list[mid].s > t) hi = mid - 1;
            else return list[mid];
        }
        return null;
    }

    function renderFaces(fx, tgt, song, out, t) {
        const m = tgt.model;
        if (!m) return;
        const face = m.faces.find(f => f.name === fx.o.face) || m.faces[0];
        if (!face) return;
        const ph = song.lyr ? itemAt(song.lyr.phonemes, t) : null;
        const mouth = 'Mouth-' + (ph ? ph.text : 'rest');
        const blink = (t % 4.3) < 0.15;
        const lit = (stateName, fallback) => {
            const idx = face.states[stateName];
            if (!idx) return;
            const col = face.colors[stateName] ? Effects.hexToRgb(face.colors[stateName]) : fallback;
            for (const i of idx) { out[3 * i] = col[0]; out[3 * i + 1] = col[1]; out[3 * i + 2] = col[2]; }
        };
        const c0 = fx.pal[0], c1 = fx.pal[1] || fx.pal[0];
        for (const k of Object.keys(face.states)) if (/^FaceOutline/.test(k)) lit(k, c0);
        for (const k of Object.keys(face.states)) if ((blink ? /^Eyes-Closed/ : /^Eyes-Open/).test(k)) lit(k, c1);
        lit(mouth, c1);
        lit(mouth + '2', c1);
    }

    // Colours for every node at time t (seconds) into prep.colors.
    function renderFrame(prep, song, t) {
        const out = prep.colors;
        out.fill(0);
        const ms = t * 1000;
        const word = song.lyr ? itemAt(song.lyr.words, t) : null;
        for (const tgt of prep.targets) {
            const N = tgt.N, acc = tgt.acc, tmp = tgt.tmp;
            let any = false;
            for (let li = 0; li < tgt.layers.length; li++) {
                const fx = activeAt(tgt.layers[li], ms);
                if (!fx) continue;
                const p = { t: (ms - fx.sMs) / (fx.eMs - fx.sMs), sec: (ms - fx.sMs) / 1000, dur: (fx.eMs - fx.sMs) / 1000, pal: fx.pal, o: fx.o, index: fx.index, word: word && word.text };
                if (fx.eff.id === 'faces') {
                    if (!any) acc.fill(0);
                    any = true;
                    const local = new Float32Array(3 * tgt.model.nodes.length);
                    renderFaces(fx, tgt, song, local, t);
                    // faces address model nodes directly
                    for (let k = 0; k < N.n; k++) {
                        const gi = N.g[k] - tgt.model.offset;
                        acc[3 * k] += local[3 * gi]; acc[3 * k + 1] += local[3 * gi + 1]; acc[3 * k + 2] += local[3 * gi + 2];
                    }
                    continue;
                }
                tmp.fill(0);
                fx.eff.render(p, fx.perModel ? tgt.NM : N, tmp);
                let gain = fx.level / 100;
                if (fx.endFade > 0) gain *= Math.max(0, Math.min(1, (p.dur - p.sec) / fx.endFade));
                if (gain !== 1) for (let i = 0; i < tmp.length; i++) tmp[i] *= gain;
                if (!any) { acc.set(tmp); any = true; }
                else for (let i = 0; i < tmp.length; i++) acc[i] += tmp[i];
            }
            if (!any) continue;
            for (let k = 0; k < N.n; k++) {
                const g = 3 * N.g[k];
                // layers add, but a bulb saturates
                const r = Math.min(255, acc[3 * k]), gg = Math.min(255, acc[3 * k + 1]), b = Math.min(255, acc[3 * k + 2]);
                if (r > out[g]) out[g] = r;
                if (gg > out[g + 1]) out[g + 1] = gg;
                if (b > out[g + 2]) out[g + 2] = b;
            }
        }
        return out;
    }

    // ---------- .xsq ----------

    const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

    function toXsq(gen, song, show, meta) {
        const pals = [], palIdx = new Map();
        const db = [], dbIdx = new Map();
        const ctx = { lyricTrack: LYRIC_TRACK };
        const refOf = fx => {
            let s = fx.eff.settings(fx.o, ctx);
            // A group row's buffer has to be stated, or xLights uses the group's
            // default layout and the effect lands somewhere else than the preview shows.
            if (fx.isGroup) s = (fx.perModel ? 'B_CHOICE_BufferStyle=Per Model Default,' : 'B_CHOICE_BufferStyle=Per Preview,') + s;
            if (fx.level !== 100) s += `,C_SLIDER_Brightness=${Math.round(fx.level)}`;
            if (fx.endFade > 0 && !/T_TEXTCTRL_Fadeout=/.test(s)) s += `,T_TEXTCTRL_Fadeout=${fx.endFade.toFixed(2)}`;
            if (fx.above) s += Effects.ADD;
            if (!dbIdx.has(s)) { dbIdx.set(s, db.length); db.push(s); }
            return dbIdx.get(s);
        };
        const palOf = fx => {
            const s = Effects.paletteString(fx.eff.hitColour && fx.colors.length > 1 ? [fx.colors[fx.index % fx.colors.length]] : fx.colors);
            if (!palIdx.has(s)) { palIdx.set(s, pals.length); pals.push(s); }
            return palIdx.get(s);
        };

        // Rows: a submodel target lives under its parent model's element.
        const elements = new Map();    // model/group name -> { layers, subs: Map(sub -> layers) }
        for (const [name, r] of gen.rows) {
            let parent = name, sub = null;
            if (!show.models.has(name) && !show.groups.has(name) && name.includes('/')) {
                parent = name.slice(0, name.indexOf('/'));
                sub = name.slice(name.indexOf('/') + 1);
            }
            if (!elements.has(parent)) elements.set(parent, { layers: null, subs: new Map() });
            const el = elements.get(parent);
            // xLights blends from its last layer up to layer 0, and a lit pixel on a
            // Normal layer hides what is under it. Steady rows go at the bottom and
            // hits above them, adding on top, as the preview shows them.
            const layers = r.layers.filter(Boolean).reverse();
            layers.forEach((l, i) => { for (const fx of l) fx.above = i < layers.length - 1; });
            if (sub) el.subs.set(sub, layers); else el.layers = layers;
        }

        const L = [];
        L.push('<?xml version="1.0" encoding="UTF-8"?>');
        L.push('<xsequence BaseChannel="0" ChanCtrlBasic="0" ChanCtrlColor="0" FixedPointTiming="1" ModelBlending="true">');
        L.push('  <head>');
        const head = [['version', meta.version || '2025.09'], ['author', ''], ['author-email', ''], ['author-website', ''],
            ['song', meta.song || ''], ['artist', meta.artist || ''], ['album', ''], ['MusicURL', ''], ['comment', 'Made with the xLights web sequencer'],
            ['sequenceTiming', FRAME_MS + ' ms'], ['sequenceType', 'Media'], ['mediaFile', meta.mediaFile || ''],
            ['sequenceDuration', song.model.duration.toFixed(3)], ['imageDir', '']];
        for (const [k, v] of head) L.push(`    <${k}>${esc(v)}</${k}>`);
        L.push('  </head>');
        L.push('  <nextid>1</nextid>');
        L.push('  <Jukebox/>');

        // effects (collect refs first so the DB is complete)
        const body = [];
        const layerXml = (fxs, indent, tag = 'EffectLayer', attrs = '') => {
            if (!fxs.length) { body.push(`${indent}<${tag}${attrs}/>`); return; }
            body.push(`${indent}<${tag}${attrs}>`);
            for (const fx of fxs) body.push(`${indent}  <Effect ref="${refOf(fx)}" name="${esc(fx.eff.xl)}" startTime="${fx.sMs}" endTime="${fx.eMs}" palette="${palOf(fx)}"/>`);
            body.push(`${indent}</${tag}>`);
        };
        for (const [name, el] of elements) {
            body.push(`    <Element type="model" name="${esc(name)}">`);
            const layers = el.layers && el.layers.length ? el.layers : [[]];
            for (const l of layers) layerXml(l, '      ');
            for (const [sub, sl] of el.subs) for (const l of sl) layerXml(l, '      ', 'SubModelEffectLayer', ` name="${esc(sub)}"`);
            body.push('    </Element>');
        }
        const timing = (name, layers) => {
            body.push(`    <Element type="timing" name="${esc(name)}">`);
            for (const marks of layers) {
                body.push('      <EffectLayer>');
                let prevE = -1;
                for (const mk of marks) {
                    let s = Math.round(mk.s * 1000 / FRAME_MS) * FRAME_MS, e = Math.round(mk.e * 1000 / FRAME_MS) * FRAME_MS;
                    if (s < prevE) s = prevE;
                    if (e <= s) continue;
                    body.push(`        <Effect label="${esc(mk.label)}" startTime="${s}" endTime="${e}"/>`);
                    prevE = e;
                }
                body.push('      </EffectLayer>');
            }
            body.push('    </Element>');
        };
        const g = song.grid;
        const timings = [
            ['Song Parts', [song.sections.map(s => ({ s: s.s, e: s.e, label: s.name }))]],
            ['Beats', [g.beats.map(b => ({ s: b.s, e: b.e, label: String(b.n) }))]],
            ['Bars', [g.bars.map(b => ({ s: b.s, e: b.e, label: String(b.n) }))]],
        ];
        if (song.lyr) {
            timings.push([LYRIC_TRACK, [
                song.lyr.lines.map(x => ({ s: x.s, e: x.e, label: x.text })),
                song.lyr.words.map(x => ({ s: x.s, e: x.e, label: x.text })),
                song.lyr.phonemes.map(x => ({ s: x.s, e: x.e, label: x.text })),
            ]]);
        }
        for (const [name, layers] of timings) timing(name, layers);

        L.push('  <ColorPalettes>');
        for (const p of pals) L.push(`    <ColorPalette>${p}</ColorPalette>`);
        L.push('  </ColorPalettes>');
        L.push('  <EffectDB>');
        for (const s of db) L.push(`    <Effect>${esc(s)}</Effect>`);
        L.push('  </EffectDB>');
        L.push('  <DataLayers>');
        L.push('    <DataLayer lor_params="0" channel_offset="0" num_channels="0" num_frames="0" data="&lt;rendered: erase-mode&gt;" source="&lt;auto-generated&gt;" name="Nutcracker"/>');
        L.push('  </DataLayers>');
        L.push('  <DisplayElements>');
        for (const name of elements.keys()) L.push(`    <Element collapsed="0" type="model" name="${esc(name)}" visible="1"/>`);
        timings.forEach(([name], i) => L.push(`    <Element collapsed="0" type="timing" name="${esc(name)}" visible="1" views="" active="${i === 0 ? 1 : 0}"/>`));
        L.push('  </DisplayElements>');
        L.push('  <ElementEffects>');
        L.push(...body);
        L.push('  </ElementEffects>');
        L.push('  <lastView>0</lastView>');
        L.push('  <TimingTags>');
        for (let i = 0; i < 10; i++) L.push(`    <Tag number="${i}" position="-1"/>`);
        L.push('  </TimingTags>');
        L.push('</xsequence>');
        return L.join('\n') + '\n';
    }

    return { TRIGGERS, EVENTS, kindOf, emptyPlan, migrate, cloneRows, newId, generate, prepare, renderFrame, toXsq, LYRIC_TRACK };
})();
