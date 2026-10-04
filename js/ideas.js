'use strict';

// Random-but-sensible light ideas for a section or a whole song.
//
// Which effect a prop gets is weighted by what the owner's own 44 sequences
// actually use on that kind of prop (arches: SingleStrand 51% / Color Wash 38%,
// snowflakes: Shockwave 44%, windows: Marquee 41%, floods: On 56%, ...), then
// nudged by the section's energy: quiet parts lean to washes and twinkles,
// loud parts to chases, pinwheels and hits on the beat.
const Ideas = (() => {
    function rngFrom(seed) {
        let a = seed >>> 0;
        return () => {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
    const between = (rng, a, b) => a + rng() * (b - a);
    const ibetween = (rng, a, b) => Math.floor(between(rng, a, b + 1));
    function weighted(rng, w) {
        const entries = Object.entries(w).filter(([, v]) => v > 0);
        let tot = 0;
        for (const [, v] of entries) tot += v;
        let x = rng() * tot;
        for (const [k, v] of entries) { x -= v; if (x <= 0) return k; }
        return entries[entries.length - 1][0];
    }

    // ---------- what kind of prop is this ----------

    const CLASSES = [
        ['face', /sing|face/i],
        ['star', /star/i],
        ['megatree', /mega ?tree/i],
        ['minitree', /mini ?tree/i],
        ['arch', /arch/i],
        ['cane', /cane/i],
        ['spinner', /spinner/i],
        ['snowflake', /snow ?flake|flake/i],
        ['matrix', /matrix|pebble|tune ?to/i],
        ['cross', /cross/i],
        ['peace', /peace/i],
        ['window', /window/i],
        ['flood', /flood/i],
        ['wreath', /wreath|circle|ring/i],
        ['roof', /roof|outline|house|vertical|horizontal|eave|gutter|icicle/i],
    ];

    function nameClass(name) {
        for (const [c, re] of CLASSES) if (re.test(name)) return c === 'face' ? null : c;
        return null;
    }

    // show.propTypes: what the user said a prop is (name -> class, or 'skip').
    function classify(show, name) {
        const set = show.propTypes && show.propTypes[name];
        if (set) return set;
        return guessClass(show, name);
    }
    function guessClass(show, name, seen = new Set()) {
        const g = show.groups.get(name);
        if (g && !seen.has(name)) {
            // A group is what most of its members are; its name only breaks a tie
            // ("EVERYTHING BUT STARBURST" is not a group of stars).
            seen.add(name);
            const counts = new Map();
            for (const mem of g.members) {
                const c = show.propTypes && show.propTypes[mem] ? show.propTypes[mem] : guessClass(show, mem, seen);
                counts.set(c, (counts.get(c) || 0) + 1);
            }
            const total = g.members.length;
            const byName = nameClass(name);
            let best = null, bestN = 0;
            for (const [c, n] of counts) if (c !== 'generic' && n > bestN) { best = c; bestN = n; }
            if (byName && (counts.get(byName) || 0) >= total * 0.5) return byName;
            if (best && bestN >= total * 0.6) return best;
            if (byName && !counts.size) return byName;
            return 'generic';
        }
        const m = show.models.get(name);
        if (m && m.mh) return 'movinghead';
        if (m && m.faces.length) return 'face';
        // "Model/SubModel": a part named for a shape ("MiniTree1/Star") is that
        // shape; an outline or segment of a prop is still that prop.
        if (!m && name.includes('/')) {
            const sub = nameClass(name.slice(name.indexOf('/') + 1));
            if (sub && sub !== 'roof') return sub;
            return guessClass(show, name.slice(0, name.indexOf('/')), seen);
        }
        const nc = nameClass(name);
        if (nc) return nc;
        if (m) {
            if (/Matrix$/.test(m.type)) return 'matrix';
            if (/^Tree/.test(m.type)) return m.nodes.length < 400 ? 'minitree' : 'megatree';
            if (m.type === 'Icicles') return 'roof';
            if (m.type === 'Candy Canes') return 'cane';
            if (m.type === 'Spinner') return 'spinner';
            if (m.type === 'Circle' || m.type === 'Wreath') return 'wreath';
            if (m.type === 'Sphere') return 'star';
            // a custom prop packed with pixels (a snow globe, a sign) works like a matrix
            if (m.type === 'Custom' && m.nodes.length >= 150 && m.bufW >= 10 && m.bufH >= 10 && m.nodes.length / (m.bufW * m.bufH) >= 0.45) return 'matrix';
            if (m.type === 'Arches') return 'arch';
            if (m.type === 'Window Frame') return 'window';
            if (m.type === 'Star') return 'star';
            if (m.type === 'Single Line' || m.type === 'Poly Line') return 'roof';
        }
        return 'generic';
    }

    // Effect shares per prop class, from his sequences (survey of 44 songs).
    const WEIGHTS = {
        arch: { chase: 51, wash: 38, bars: 5, shockwave: 6 },
        roof: { chase: 63, shockwave: 10, wash: 10, twinkle: 8, on: 9 },
        cane: { chase: 46, on: 15, shockwave: 9, wash: 7, bars: 5, spirals: 4 },
        minitree: { shockwave: 28, chase: 21, on: 21, twinkle: 10, spirals: 5 },
        megatree: { shockwave: 18, chase: 17, spirals: 10, pinwheel: 9, butterfly: 8, bars: 8, twinkle: 8 },
        spinner: { chase: 28, shockwave: 22, pinwheel: 17, spirals: 8, twinkle: 5, wash: 5 },
        snowflake: { shockwave: 44, on: 20, twinkle: 15, pinwheel: 12, spirals: 6, wash: 8 },
        matrix: { shockwave: 30, pinwheel: 16, butterfly: 15, chase: 11, bars: 10 },
        cross: { shockwave: 30, chase: 20, pinwheel: 11, on: 10 },
        peace: { chase: 49, shockwave: 14, on: 10 },
        window: { marquee: 41, chase: 17, on: 15, wash: 10 },
        flood: { on: 56, wash: 14 },
        star: { twinkle: 30, on: 30, shockwave: 20, pinwheel: 8 },
        wreath: { chase: 30, pinwheel: 20, shockwave: 20, wash: 15, twinkle: 10 },
        movinghead: { moving: 1 },
        generic: { chase: 20, wash: 20, twinkle: 15, bars: 10, on: 10, shockwave: 10, spirals: 5, butterfly: 5 },
    };
    // A feeling the user can pick for ideas: which effects it favours, how fast
    // things move, and how much it lifts or lowers the section's own energy.
    const FEELS = {
        auto: { label: 'From the song', mul: {}, speed: 1, shift: 0 },
        peaceful: { label: 'Peaceful', mul: { wash: 2, twinkle: 2, on: 1.5, chase: 0.6, shockwave: 0.3, pinwheel: 0.3, bars: 0.5, spirals: 0.6 }, speed: 0.6, shift: -0.25 },
        joyful: { label: 'Joyful', mul: { chase: 1.5, bars: 1.4, twinkle: 1.2, marquee: 1.3 }, speed: 1, shift: 0.05 },
        playful: { label: 'Playful', mul: { pinwheel: 2, spirals: 1.8, marquee: 1.5, bars: 1.3, wash: 0.6 }, speed: 1.2, shift: 0.1 },
        powerful: { label: 'Powerful', mul: { shockwave: 2, chase: 1.3, bars: 1.3, wash: 0.5, twinkle: 0.5, on: 0.7 }, speed: 1.4, shift: 0.25, beats: true },
        magical: { label: 'Magical / sparkly', mul: { twinkle: 2.2, butterfly: 2, spirals: 1.5, wash: 1.2, shockwave: 0.5 }, speed: 0.8, shift: 0 },
    };
    const INTENSITIES = [
        { id: 'auto', label: 'From the song', value: null },
        { id: 'vcalm', label: 'Very calm', value: 0.1 },
        { id: 'calm', label: 'Calm', value: 0.3 },
        { id: 'medium', label: 'Medium', value: 0.5 },
        { id: 'lively', label: 'Lively', value: 0.72 },
        { id: 'full', label: 'Full on', value: 0.92 },
    ];

    const CALM = new Set(['wash', 'twinkle', 'on']);
    const BUSY = new Set(['shockwave', 'pinwheel', 'bars', 'spirals', 'chase']);

    // ---------- candidates ----------

    // "No Controller" usually means a parked prop; DMX moving heads are often set up
    // with an absolute channel and no controller named, so they always count.
    const inUse = m => (m.mh || m.attrs.Controller !== 'No Controller') && !/^old|old_/i.test(m.name);

    // One target per kind of prop: the broadest group if there is one
    // ("All Arches" rather than "Arches 1-3"), otherwise its models.
    // The models a list of targets (groups, models, submodels) covers.
    function modelsOf(show, targets) {
        const out = new Set();
        for (const t of targets || []) for (const n of Show.resolveTarget(show, t)) out.add(n.model.name);
        return out;
    }

    // excluded: model names the user wants left out of ideas. A group holding
    // any of them is skipped too, or it would light them anyway.
    function candidates(show, excluded = new Set()) {
        const byClass = new Map();
        const size = name => Show.resolveTarget(show, name).length;
        const clean = name => ![...modelsOf(show, [name])].some(m => excluded.has(m));
        for (const g of show.groups.keys()) {
            if (/\bno\b|only|-\d+$|old|override|^all$|^all \(/i.test(g)) continue;
            if (excluded.size && !clean(g)) continue;
            const c = classify(show, g);
            if (c === 'generic' || c === 'face' || c === 'skip') continue;
            const cur = byClass.get(c);
            const score = (/^all/i.test(g) ? 1e6 : 0) + size(g);
            if (!cur || score > cur.score) byClass.set(c, { score, targets: [g] });
        }
        for (const m of show.models.values()) {
            if (!inUse(m) || excluded.has(m.name)) continue;
            const c = classify(show, m.name);
            if (c === 'generic' || c === 'skip') continue;
            if (c === 'face') {
                const cur = byClass.get('face') || { score: 0, targets: [] };
                cur.targets.push(m.name);
                byClass.set('face', cur);
            } else if (!byClass.has(c)) {
                byClass.set(c, { score: 0, targets: [m.name], models: true });
            } else if (byClass.get(c).models) {
                byClass.get(c).targets.push(m.name);
            }
        }
        return byClass;
    }

    // ---------- one row ----------

    function optionsFor(effect, rng, ctx) {
        const { energy, bars } = ctx;
        const fast = (0.5 + energy) * (ctx.speed || 1);
        switch (effect) {
            case 'chase': return {
                direction: pick(rng, ['Left-Right', 'Right-Left', 'From Middle', 'To Middle', 'Bounce from Left']),
                chases: ibetween(rng, 1, energy > 0.6 ? 3 : 2),
                rotations: Math.max(1, Math.round(bars / pick(rng, [1, 2, 4]) * fast)),
                size: ibetween(rng, 20, 50),
            };
            case 'bars': return { direction: pick(rng, ['up', 'down', 'expand', 'compress', 'Left', 'Right']), bars: ibetween(rng, 2, 4), cycles: Math.max(1, Math.round(bars / 2 * fast)) };
            case 'spirals': return { count: ibetween(rng, 2, 4), rotation: (rng() < 0.5 ? -1 : 1) * ibetween(rng, 10, 30), thickness: ibetween(rng, 30, 60) };
            case 'pinwheel': return { arms: ibetween(rng, 2, 6), speed: Math.round((rng() < 0.5 ? -1 : 1) * between(rng, 6, 22) * fast), twist: pick(rng, [0, 0, 100, -100]) };
            case 'twinkle': return { count: Math.round(between(rng, 10, 25) + energy * 25), steps: ibetween(rng, 20, 50) };
            case 'wash': return { cycles: Math.max(1, Math.round(between(rng, 0.5, 2) * Math.max(1, bars / 8))) };
            case 'marquee': return { band: ibetween(rng, 2, 4), skip: ibetween(rng, 1, 3), speed: Math.round(between(rng, 2, 6) * fast) };
            case 'butterfly': return { speed: Math.round(between(rng, 5, 18) * fast) };
            case 'shockwave': return { width: ibetween(rng, 20, 50) };
            case 'moving': {
                // calm parts: small, slow shapes; loud parts: big, fast ones, heads spread out
                const loud = energy > 0.6;
                return {
                    pattern: pick(rng, loud ? ['Eight', 'Lissajous', 'Diamond', 'Circle', 'Square'] : ['Circle', 'Eight', 'Leaf', 'Line']),
                    width: ibetween(rng, loud ? 50 : 15, loud ? 90 : 40), height: ibetween(rng, loud ? 25 : 8, loud ? 45 : 20),
                    pan: pick(rng, [0, 0, -20, 20]), tilt: pick(rng, [0, 0, 15, -15]),
                    cycles: Math.max(1, Math.round(bars / (loud ? pick(rng, [1, 2]) : pick(rng, [4, 8])) * (ctx.speed || 1))),
                    spread: pick(rng, loud ? [45, 90, 120, 180] : [0, 30, 45]),
                    dimmer: Math.round(loud ? 100 : 55 + energy * 50),
                };
            }
            case 'on': return energy < 0.4 ? { fadeIn: +(between(rng, 0.3, 1.5)).toFixed(1), fadeOut: +(between(rng, 0.3, 1.5)).toFixed(1) } : {};
        }
        return {};
    }

    // ---------- the colour plan ----------
    //
    // Each part gets one or two colours, not the whole scheme: verses take turns
    // between the scheme's first two colours (red verse, green verse), lifting
    // parts use both and swap them bar by bar on the hits, quiet parts go cool.

    function hsl(hex) {
        const [r, g, b] = Effects.hexToRgb(hex).map(v => v / 255);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
        if (!d) return { h: 0, s: 0, l };
        const s = d / (1 - Math.abs(2 * l - 1));
        let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
        return { h, s, l };
    }
    function coolOf(cols) {
        const cool = cols.find(c => { const x = hsl(c); return x.s > 0.25 && x.h >= 170 && x.h <= 270; });
        if (cool) return cool;
        const hues = cols.map(hsl).filter(x => x.s > 0.3).map(x => x.h);
        const festive = hues.some(h => h < 20 || h > 340) && hues.some(h => h > 90 && h < 160);
        if (festive) return '#3C78FF';
        return cols.slice().sort((a, b) => hsl(b).l - hsl(a).l)[0];
    }
    function colourPlan(scheme, energy, lift, turn) {
        const cols = scheme.colors.length ? scheme.colors : ['#FFFFFF'];
        const A = cols[0], B = cols[1] || cols[0];
        const accent = cols[2] || cols.slice().sort((a, b) => hsl(b).l - hsl(a).l)[0];
        const odd = turn % 2 === 1;
        if (energy < 0.3) {
            const cool = coolOf(cols);
            return { base: [[cool], [cool, accent]], hit: [accent], house: [cool, accent], bar: false, accent };
        }
        const main = odd ? B : A, other = odd ? A : B;
        if (lift) return { base: [[main], [other], [main, other]], hit: [main, other], house: [main, other], bar: true, accent };
        return { base: [[main], [main, accent]], hit: [other], house: [other, accent], bar: true, accent };
    }
    const schemeTag = (colors, scheme) => colors.join() === scheme.colors.join() ? scheme.id : 'custom';

    // A small change between phrases of a long part: things that move turn round.
    function flipOptions(effect, o) {
        const swap = { 'Left-Right': 'Right-Left', 'Right-Left': 'Left-Right', 'From Middle': 'To Middle', 'To Middle': 'From Middle', up: 'down', down: 'up', expand: 'compress', compress: 'expand', Left: 'Right', Right: 'Left' };
        const out = { ...o };
        if (out.direction && swap[out.direction]) out.direction = swap[out.direction];
        if (effect === 'pinwheel' && out.speed) out.speed = -out.speed;
        if (effect === 'spirals' && out.rotation) out.rotation = -out.rotation;
        return out;
    }

    // A steady row for the part. Hits (shockwaves, flashes) are left to the
    // beat layer, so each part keeps a lit base and one clear rhythm on top.
    function rowFor(show, target, rng, ctx) {
        const cls = classify(show, target);
        if (cls === 'face') {
            return { id: Sequencer.newId(), trigger: 'singing', targets: [target], effect: 'faces', options: {}, colors: ['#FFFFFF'], scheme: 'white' };
        }
        const w = { ...(WEIGHTS[cls] || WEIGHTS.generic) };
        delete w.shockwave;
        if (!Object.keys(w).length) w.on = 1;
        const e = ctx.style;
        for (const k of Object.keys(w)) {
            if (e < 0.25) { if (CALM.has(k)) w[k] *= 3; if (BUSY.has(k)) w[k] *= 0.25; }
            else if (e < 0.35) { if (CALM.has(k)) w[k] *= 1.8; if (BUSY.has(k)) w[k] *= 0.45; }
            else if (e > 0.65) { if (BUSY.has(k)) w[k] *= 1.5; if (k === 'wash' || k === 'on') w[k] *= 0.6; }
            if (ctx.feel && ctx.feel.mul[k]) w[k] *= ctx.feel.mul[k];
        }
        const effect = weighted(rng, w);
        const colors = pick(rng, ctx.cp.base).slice();
        let options = optionsFor(effect, rng, { ...ctx, energy: e });
        if (ctx.flip) options = flipOptions(effect, options);
        const row = {
            id: Sequencer.newId(), trigger: 'span', targets: [target], effect, options,
            colors, scheme: schemeTag(colors, ctx.scheme),
            level: ctx.level,
        };
        if (effect === 'moving') delete row.level;
        return row;
    }

    // Props that read well as a hit: how much his sequences use shockwaves / flashes on them.
    const HIT_PREF = { snowflake: 5, minitree: 4, star: 4, cross: 4, matrix: 3, megatree: 3, spinner: 3, peace: 2, cane: 2, arch: 2, roof: 1, window: 1, generic: 1 };
    // Big props mark the bar; small ones the beat.
    const BIG = new Set(['megatree', 'matrix', 'roof', 'flood']);

    function hitRow(show, target, rng, ctx) {
        const cls = classify(show, target);
        const w = WEIGHTS[cls] || WEIGHTS.generic;
        const effect = (w.shockwave || 0) >= 15 && rng() < 0.7 ? 'shockwave' : 'pulse';
        let trigger;
        if (BIG.has(cls) || ctx.energy < 0.5) trigger = 'downbeats';
        else if (ctx.energy > 0.78) trigger = pick(rng, ['beats', 'kick']);
        else trigger = pick(rng, ['beats', 'beats', 'snare']);
        const colors = ctx.cp.hit.slice();
        return {
            id: Sequencer.newId(), trigger, targets: [target], effect,
            options: effect === 'shockwave' ? { width: ibetween(rng, 25, 50) } : {},
            colors, scheme: schemeTag(colors, ctx.scheme),
        };
    }

    // Mean loudness between two times, and the scale that maps it to 0 (the
    // quietest part of the song) .. 1 (the loudest part).
    function rawLoud(song, t0, t1) {
        const m = song.model, L = m.loudness, step = m.loudStep || 0.05;
        if (!L) return null;
        let sum = 0, n = 0;
        for (let i = Math.floor(t0 / step); i < Math.min(L.length, Math.ceil(t1 / step)); i++) { sum += L[i]; n++; }
        return n ? sum / n : null;
    }
    function energyScale(song) {
        const vals = song.sections.map(s => rawLoud(song, s.s, s.e)).filter(v => v != null);
        const lo = Math.min(...vals), hi = Math.max(...vals);
        const ok = vals.length && hi - lo > 0.02;
        return { ok, norm: v => (v == null || !ok ? null : (v - lo) / (hi - lo)) };
    }

    // How loud each part is against the rest of the song, 0 (quietest) .. 1 (loudest),
    // measured from the audio so split or renamed parts get their own value.
    function partEnergies(song) {
        const sc = energyScale(song);
        const out = new Map();
        for (const s of song.sections) out.set(s.id, sc.norm(rawLoud(song, s.s, s.e)) ?? s.energy ?? 0.5);
        return out;
    }

    const barsOf = (song, sec) => song.grid.bars.filter(b => b.s >= sec.s - 0.05 && b.s < sec.e - 0.05);

    // Where a long part changes gear: bar boundaries where the next 4 bars are
    // clearly louder or quieter than the 4 before. Returns phrases
    // [{ b0, b1, energy }] (bar indexes within the part; b1 exclusive).
    const PHRASE_MIN = 4, PHRASE_STEP = 0.15;
    function phrases(song, sec) {
        const bars = barsOf(song, sec), n = bars.length;
        const sc = energyScale(song);
        const whole = [{ b0: 0, b1: n, energy: null }];
        if (n < 2 * PHRASE_MIN || !sc.ok) return whole;
        const E = bars.map(b => sc.norm(rawLoud(song, b.s, Math.min(b.e, sec.e))) ?? 0);
        const mean = (i, j) => { let t = 0; for (let k = i; k < j; k++) t += E[k]; return t / Math.max(1, j - i); };
        const cand = [];
        for (let b = PHRASE_MIN; b <= n - PHRASE_MIN; b++) {
            const d = Math.abs(mean(b, b + PHRASE_MIN) - mean(b - PHRASE_MIN, b));
            // changes usually land on an even bar of the part
            if (d >= PHRASE_STEP) cand.push({ b, d: d * (b % 2 ? 0.85 : 1) });
        }
        cand.sort((x, y) => y.d - x.d);
        const cuts = [];
        for (const c of cand) {
            if (cuts.length >= 3) break;
            if (cuts.every(k => Math.abs(k - c.b) >= PHRASE_MIN)) cuts.push(c.b);
        }
        if (!cuts.length) return whole;
        cuts.sort((x, y) => x - y);
        const edges = [0, ...cuts, n];
        return edges.slice(0, -1).map((b0, i) => ({ b0, b1: edges[i + 1], energy: mean(b0, edges[i + 1]) }));
    }

    // Brightness of a part's steady lights: quiet parts glow, loud parts blaze.
    const levelFor = energy => Math.round((40 + 60 * energy) / 5) * 5;

    const hashStr = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };

    // ---------- a section ----------

    // feel: a FEELS key; intensity: 0..1 to override the section's measured energy
    // ---------- the prop mix: how much ideas use each prop, per kind of section ----------
    //
    // mix = { extras: [target], levels: { [entryKey]: { '*': level, [kind]: level } } }
    // A section kind's own level wins over '*' (every part). Default: normal.

    const LEVELS = ['never', 'less', 'normal', 'more', 'always'];
    const LEVEL_WEIGHT = { less: 0.3, normal: 1, more: 3.5 };
    const CLASS_LABELS = {
        megatree: 'Mega tree', minitree: 'Mini trees', arch: 'Arches', cane: 'Candy canes', spinner: 'Spinners',
        snowflake: 'Snowflakes', matrix: 'Matrix', cross: 'Crosses', peace: 'Peace stakes', window: 'Windows',
        flood: 'Floods', star: 'Stars', movinghead: 'Moving heads', roof: 'House lines and icicles', wreath: 'Wreaths and circles', generic: 'Other', face: 'Singing face', skip: 'Not a prop (ideas skip it)',
    };

    function level(mix, key, kind) {
        const l = mix && mix.levels && mix.levels[key];
        // moving heads are in every idea unless the prop mix says otherwise
        const def = key === 'class:movinghead' ? 'always' : 'normal';
        if (!l) return def;
        return (kind && l[kind]) || l['*'] || def;
    }

    // The rows of the prop mix: one per prop type found in the show (floods
    // only when asked for), plus any prop or group the user added.
    function mixEntries(show, excluded = new Set(), mix = null) {
        const cands = candidates(show, excluded);
        const out = [];
        for (const [cls, c] of cands) {
            if (cls === 'face') continue;
            out.push({ key: 'class:' + cls, label: CLASS_LABELS[cls] || cls, targets: c.targets.slice(0, c.models ? 6 : 1), hiddenByDefault: cls === 'flood' });
        }
        for (const t of (mix && mix.extras) || []) {
            if ([...modelsOf(show, [t])].some(m => excluded.has(m))) continue;
            out.push({ key: 'target:' + t, label: t, targets: [t], extra: true });
        }
        return out;
    }

    // energy: how loud this part is (0..1, see partEnergies); style: the energy
    // that picks effects (a repeat uses its kind's, so verses share effects and
    // differ only in how many props are lit and how bright).
    const LIFT = /chorus|refrain|drop|hook/i;
    // Which repeat of its kind a part is (Verse 1 = 0, Verse 2 = 1, ...).
    const turnOf = (song, sec) => song.sections.filter(x => Sequencer.kindOf(x.name) === Sequencer.kindOf(sec.name)).findIndex(x => x.id === sec.id);

    // turn: which repeat (colours take turns); flip: turn moving things round
    // (a later phrase of a long part); matrixWords: the matrix shows the lyrics
    // in lifting parts and is a dim bed everywhere else.
    // mhParts: the parts moving heads join (null: every part)
    function sectionIdea(section, song, show, { pool, seed, scheme, feel = 'auto', intensity = null, exclude = [], mix = null, energy = null, style = null, turn = null, flip = false, matrixWords = false, mhParts = null }) {
        const excluded = exclude instanceof Set ? exclude : modelsOf(show, exclude);
        if (pool && pool.length && excluded.size) pool = pool.filter(t => ![...modelsOf(show, [t])].some(m => excluded.has(m)));
        const rng = rngFrom(seed);
        const bars = Math.max(1, section.bars || Math.round((section.e - section.s) / (song.grid.T * song.grid.meter)));
        const f = FEELS[feel] || FEELS.auto;
        if (energy == null) energy = partEnergies(song).get(section.id) ?? section.energy ?? 0.5;
        const clampE = x => Math.max(0.05, Math.min(0.95, x));
        energy = intensity != null ? intensity : clampE(energy + f.shift);
        // a quiet break looks like itself, not like its louder namesakes
        style = intensity != null ? intensity : style != null && energy >= 0.25 ? clampE(style + f.shift) : energy;
        const lift = LIFT.test(section.name) || energy >= 0.75;
        if (turn == null) turn = Math.max(0, turnOf(song, section));
        const cp = colourPlan(scheme, energy, lift, turn);
        const ctx = { energy, style, bars, scheme, feel: f, speed: f.speed, level: levelFor(energy), cp, flip };

        // Every prop type in a fixed order for this seed; the part takes as many
        // from the front as its loudness calls for, so a louder repeat adds props
        // and a quieter one drops them, keeping the rest the same.
        let order;
        const always = [];
        const usePool = !!(pool && pool.length);
        if (usePool) {
            order = pool.map(t => ({ key: 'target:' + t, targets: [t] }));
            // a part ticked in the Moving heads box gets the heads even with its own list
            const heads = mhParts && mhParts.includes(section.id) && candidates(show, excluded).get('movinghead');
            if (heads && !pool.some(t => classify(show, t) === 'movinghead')) order.push({ key: 'class:movinghead', targets: heads.targets });
        } else {
            const kind = Sequencer.kindOf(section.name);
            const entries = mixEntries(show, excluded, mix).filter(e => !e.hiddenByDefault || level(mix, e.key, kind) !== 'normal');
            const rest = [];
            for (const e of entries) {
                const lv = level(mix, e.key, kind);
                if (lv === 'never') continue;
                if (e.key === 'class:movinghead' && mhParts && !mhParts.includes(section.id)) continue;
                if (lv === 'always') always.push(e); else rest.push({ e, w: LEVEL_WEIGHT[lv] });
            }
            order = [];
            while (rest.length) {
                let sum = 0;
                for (const x of rest) sum += x.w;
                let r = rng() * sum, k = 0;
                while (k < rest.length - 1 && (r -= rest[k].w) > 0) k++;
                order.push(rest.splice(k, 1)[0].e);
            }
        }
        const total = always.length + order.length;
        const jitter = between(rng, -0.6, 0.6);
        let n = usePool ? total : Math.max(Math.min(3, total), Math.min(total, Math.round(1 + energy * (total - 1) + jitter)));
        n = Math.max(n, always.length);
        const chosen = always.concat(order).slice(0, n);
        const isMatrix = t => classify(show, t) === 'matrix';
        const words = matrixWords && lift && song.lyr && song.lyr.lines.length;
        // the words need the matrix, even in a part that would not otherwise use it
        if (words && !usePool && !chosen.some(e => e.targets.some(isMatrix))) {
            const m = order.find(e => e.targets.some(isMatrix));
            if (m) chosen.push(m);
        }

        // each prop's look comes from its own seed, so it stays put across repeats
        const rows = [];
        const propRng = t => rngFrom(seed ^ hashStr(t));
        for (const e of chosen) for (const t of e.targets) rows.push(rowFor(show, t, propRng(t), ctx));
        // The matrix as a screen: a dim slow bed (it holds a third of the show's
        // bulbs, so anything bright on it swamps the house), words in the lifts.
        const screen = new Set();
        if (matrixWords) {
            for (const r of rows) if (r.trigger === 'span' && isMatrix(r.targets[0])) {
                r.effect = 'wash'; r.options = { cycles: 1 }; r.level = Math.min(r.level ?? 100, 25);
                screen.add(r.targets[0]);
            }
            if (words && screen.size) {
                const big = [...screen].map(t => show.models.get(t)).filter(Boolean).sort((x, y) => y.nodes.length - x.nodes.length)[0];
                if (big) rows.push({ id: Sequencer.newId(), trigger: 'lines', targets: [big.name], effect: 'lyrictext', options: { size: Math.max(8, Math.round((big.bufH || 20) * 0.6)) }, colors: ['#FFFFFF'], scheme: 'custom' });
            }
        }

        // Big singing props (a snow globe with a face) carry a soft background in
        // every part; the face is drawn on top of it while someone sings.
        const faceCands = candidates(show, excluded).get('face');
        for (const t of (faceCands ? faceCands.targets : [])) {
            const m = show.models.get(t);
            if (!m || m.nodes.length < 300 || (usePool && !pool.includes(t))) continue;
            const fr = propRng('bed:' + t);
            const effect = weighted(fr, energy < 0.35 ? { wash: 4, twinkle: 3 } : { wash: 3, twinkle: 3, butterfly: 2 });
            const colors = pick(fr, ctx.cp.base).slice();
            let options = optionsFor(effect, fr, ctx);
            if (ctx.flip) options = flipOptions(effect, options);
            rows.push({ id: Sequencer.newId(), trigger: 'span', targets: [t], effect, options, colors, scheme: schemeTag(colors, ctx.scheme), level: Math.round(ctx.level * 0.5 / 5) * 5 });
        }

        // Screens (matrices, dense props) get a layered look: a second, lighter
        // effect on top of the base (sparkles, spirals or bars), unless the
        // matrix is showing the words.
        if (energy >= 0.3) {
            for (const r of rows.slice()) {
                if (r.trigger !== 'span' || screen.has(r.targets[0]) || classify(show, r.targets[0]) !== 'matrix') continue;
                const lr = propRng('layer:' + r.targets[0]);
                const over = weighted(lr, { twinkle: 5, spirals: 3, bars: 2 });
                if (over === r.effect) continue;
                const colors = [ctx.cp.accent || r.colors[0]];
                let options = optionsFor(over, lr, ctx);
                if (ctx.flip) options = flipOptions(over, options);
                rows.push({ id: Sequencer.newId(), trigger: 'span', targets: r.targets.slice(), effect: over, options, colors, scheme: schemeTag(colors, ctx.scheme), level: Math.round((r.level ?? 100) * 0.7 / 5) * 5 });
            }
        }

        // The beat layer: one prop type (two when loud) carries the rhythm on top of
        // a dimmer base; everything else stays steady.
        const hitCount = energy < 0.3 ? 0 : energy > 0.7 || f.beats ? 2 : 1;
        if (hitCount) {
            const cand = chosen.filter(e => e.targets.some(t => !['face', 'movinghead'].includes(classify(show, t)) && !screen.has(t)));
            const picked = [];
            const hr = rngFrom(seed ^ 0x5bd1e995);
            while (picked.length < hitCount && cand.length) {
                const ws = cand.map(e => HIT_PREF[classify(show, e.targets[0])] || 1);
                // with two, prefer one big prop (on the bar) and one small (on the beat)
                if (picked.length === 1) cand.forEach((e, i) => { if (BIG.has(classify(show, e.targets[0])) !== BIG.has(classify(show, picked[0].targets[0]))) ws[i] *= 3; });
                const sum = ws.reduce((x, y) => x + y, 0);
                let r = hr() * sum, k = 0;
                while (k < cand.length - 1 && (r -= ws[k]) > 0) k++;
                picked.push(cand.splice(k, 1)[0]);
            }
            for (const e of picked) {
                const tg = e.targets.filter(t => classify(show, t) !== 'face');
                for (const r of rows) if (tg.includes(r.targets[0]) && r.level != null) r.level = Math.round(r.level * 0.5 / 5) * 5;
                // one row for the whole prop type, so its hits land together
                const h = hitRow(show, tg[0], propRng('hit:' + tg[0]), ctx);
                h.targets = tg;
                rows.push(h);
            }
        }
        // Loud parts: the whole house hits together over a dimmer base. One prop
        // flashing barely moves the show; the same hit on every prop is what reads
        // as punch. Each hit takes the next colour, so red and green alternate.
        if (energy >= 0.45) {
            const lit = rows.filter(r => r.trigger === 'span' && r.effect !== 'faces' && r.effect !== 'moving' && !screen.has(r.targets[0]));
            if (lit.length >= 3) {
                for (const r of lit) r.level = Math.round(r.level * (energy >= 0.6 ? 0.6 : 0.8) / 5) * 5;
                const hasKick = (song.model.onsets.kick || []).filter(o => o.s >= 0.35 && o.t >= section.s && o.t < section.e).length >= bars * 2;
                const trigger = energy > 0.85 && hasKick ? 'kick' : energy > 0.7 ? 'beats' : 'downbeats';
                const cols = cp.house.slice();
                const row = { id: Sequencer.newId(), trigger, targets: [...new Set(lit.flatMap(r => r.targets))], effect: 'pulse', options: {}, colors: cols, scheme: schemeTag(cols, ctx.scheme), level: 70 };
                if (cp.bar && cols.length > 1) row.colourBy = 'bar';
                rows.push(row);
            }
        }
        return rows;
    }

    // A part, split into phrases where its energy changes: the same props and
    // effects throughout, but each phrase lights as much as its own loudness asks
    // for, takes the next colour turn, and turns moving things round.
    // phrased: false keeps the part as one block.
    function partIdea(section, song, show, opts) {
        const subs = opts.phrased === false ? [] : phrases(song, section);
        if (subs.length < 2) return sectionIdea(section, song, show, opts);
        const measured = partEnergies(song).get(section.id);
        const bump = opts.energy != null && measured != null ? opts.energy - measured : 0;
        const turn = opts.turn ?? Math.max(0, turnOf(song, section));
        const rows = [];
        subs.forEach((p, i) => {
            const r = sectionIdea(section, song, show, { ...opts, energy: Math.max(0, Math.min(1, p.energy + bump)), turn: turn + i, flip: i % 2 === 1 });
            for (const x of r) x.bars = [p.b0, p.b1];
            rows.push(...r);
        });
        return rows;
    }

    // Just the moving-head row(s) for a part: the same choices sectionIdea would
    // make for them (loudness, colours, speed), without touching anything else.
    function movingHeadIdea(section, song, show, { seed, scheme, feel = 'auto', intensity = null, exclude = [] }) {
        const excluded = exclude instanceof Set ? exclude : modelsOf(show, exclude);
        const c = candidates(show, excluded).get('movinghead');
        if (!c || !c.targets.length) return [];
        const bars = Math.max(1, section.bars || Math.round((section.e - section.s) / (song.grid.T * song.grid.meter)));
        const f = FEELS[feel] || FEELS.auto;
        let energy = partEnergies(song).get(section.id) ?? section.energy ?? 0.5;
        energy = intensity != null ? intensity : Math.max(0.05, Math.min(0.95, energy + f.shift));
        const lift = LIFT.test(section.name) || energy >= 0.75;
        const cp = colourPlan(scheme, energy, lift, Math.max(0, turnOf(song, section)));
        const ctx = { energy, style: energy, bars, scheme, feel: f, speed: f.speed, level: levelFor(energy), cp, flip: false };
        return c.targets.map(t => rowFor(show, t, rngFrom(seed ^ hashStr(t)), ctx));
    }

    // ---------- the whole song ----------

    // sections: which sections get a new idea (default all); whole: redo the
    // whole-song layer too. Returns only what was asked for.
    // ---------- transitions between parts ----------

    const TRANSITIONS = [
        ['cut', 'Straight cut'],
        ['ramp', 'Ramp up'],
        ['sweep', 'Sweep in'],
        ['burst', 'Burst'],
        ['colourhit', 'Colour hit'],
        ['crossfade', 'Crossfade'],
        ['build', 'Build & land (dark, then flash)'],
    ];

    // The props transitions use: the big ones for ramps and sweeps, the ones
    // that read as a burst for shockwaves.
    function transitionProps(show, excluded = new Set()) {
        const cands = candidates(show, excluded);
        return {
            big: ['roof', 'megatree', 'arch'].filter(c => cands.has(c)).map(c => cands.get(c).targets[0]),
            bursty: ['megatree', 'matrix', 'snowflake', 'star', 'cross'].filter(c => cands.has(c)).map(c => cands.get(c).targets[0]).slice(0, 3),
        };
    }

    // How part B comes in after part A. Everything a transition adds is tagged
    // with B's id, so a new choice first takes the old one away.
    function applyTransition(plan, song, A, B, move, { props, scheme, rng = Math.random, doA = true, doB = true }) {
        const ca = plan.sections[A.id], cb = plan.sections[B.id];
        const tag = B.id;
        for (const c of [ca, cb]) if (c) {
            c.rows = c.rows.filter(r => r.tr !== tag);
            for (const r of c.rows) {
                if (r.trOut === tag) { delete r.endFade; delete r.trOut; }
                if (r.trIn === tag) { delete r.startFade; delete r.trIn; }
            }
        }
        if (ca && ca.dipFor === tag) { delete ca.dip; delete ca.dipFor; }
        if (cb) cb.transition = move;
        if (move === 'cut') return;
        const sa = doA && ca, sb = doB && cb;
        const barLen = song.grid.T * (song.grid.meter || 4);
        const lit = () => [...new Set((cb ? cb.rows : []).filter(r => r.trigger === 'span' && r.effect !== 'faces' && r.effect !== 'moving').flatMap(r => r.targets))];
        const colour = (() => {
            const n = new Map();
            for (const r of (cb ? cb.rows : [])) if (r.trigger === 'span' && r.colors && r.colors[0]) n.set(r.colors[0], (n.get(r.colors[0]) || 0) + 1);
            return [...n].sort((x, y) => y[1] - x[1]).map(x => x[0])[0] || scheme.colors[0];
        })();
        const add = (c, row) => c.rows.push({ id: Sequencer.newId(), tr: tag, scheme: 'custom', options: {}, ...row });
        switch (move) {
            case 'build':
                // a held breath, then the whole house lands together
                if (sa) {
                    ca.dip = 1.5; ca.dipFor = tag;
                    if (props.big.length) add(ca, { trigger: 'leadin', targets: props.big, effect: 'on', options: { start: 5, end: 100 }, colors: [colour] });
                }
                if (sb && lit().length) add(cb, { trigger: 'first', targets: lit(), effect: 'pulse', colors: [scheme.colors[2] || '#FFFFFF'] });
                break;
            case 'ramp':
                // the big props brighten over the last two bars; no gap
                if (sa && props.big.length) add(ca, { trigger: 'leadin', targets: props.big, effect: 'on', options: { start: 10, end: 100 }, colors: [colour] });
                break;
            case 'sweep':
                // a chase runs across the house in the last bar
                if (sa && props.big.length) add(ca, { trigger: 'lastbar', targets: props.big, effect: 'chase', options: { direction: pick(rng, ['Left-Right', 'Right-Left', 'From Middle']), chases: 1, rotations: 1, size: 40 }, colors: [colour] });
                break;
            case 'burst':
                // a shockwave from the centre props as the part starts
                if (sb && props.bursty.length) add(cb, { trigger: 'first', targets: props.bursty, effect: 'shockwave', options: { width: 40 }, colors: [colour] });
                break;
            case 'colourhit':
                // the new part lands with a flash in its own colour
                if (sb && lit().length) add(cb, { trigger: 'first', targets: lit(), effect: 'pulse', colors: [colour], level: 70 });
                break;
            case 'crossfade': {
                // one look melts into the next over about a bar
                if (sa) {
                    const nb = barsOf(song, A).length, len = Math.min(barLen, (A.e - A.s) / 3);
                    for (const r of ca.rows) if (r.trigger === 'span' && r.effect !== 'faces' && (!r.bars || r.bars[1] >= nb) && !(r.endFade > 0)) { r.endFade = len; r.trOut = tag; }
                }
                if (sb) {
                    const len = Math.min(barLen, (B.e - B.s) / 3);
                    for (const r of cb.rows) if (r.trigger === 'span' && r.effect !== 'faces' && (!r.bars || r.bars[0] === 0)) { r.startFade = len; r.trIn = tag; }
                }
                break;
            }
        }
    }

    function planIdea(song, show, { seed, scheme, alike, pools, sections, whole = true, feel = 'auto', intensity = null, exclude = [], mix = null, matrixWords = false, phrased = true, mhParts = null }) {
        const rng = rngFrom(seed);
        const plan = Sequencer.emptyPlan();
        const excluded = modelsOf(show, exclude);
        const cands = candidates(show, excluded);
        const all = song.sections;
        const energies = partEnergies(song);
        // the last of the lifting parts is the peak of the song
        const liftParts = all.filter(s => LIFT.test(s.name));
        if (liftParts.length) {
            const last = liftParts[liftParts.length - 1];
            energies.set(last.id, Math.min(1, energies.get(last.id) + 0.1));
        }
        const ending = endingFade(song);
        if (whole && cands.has('flood')) {
            const row = { id: Sequencer.newId(), trigger: 'span', targets: cands.get('flood').targets, effect: 'wash', options: { cycles: Math.max(1, Math.round(song.model.duration / 30)) }, colors: scheme.colors.slice(), scheme: scheme.id, level: 60 };
            if (ending) row.endFade = ending;
            plan.whole.rows.push(row);
        }
        if (whole && song.lyr && cands.has('face')) {
            for (const f of cands.get('face').targets) plan.whole.rows.push({ id: Sequencer.newId(), trigger: 'singing', targets: [f], effect: 'faces', options: {}, colors: ['#FFFFFF'], scheme: 'white' });
        }
        // a repeat shares its kind's seed and effect style; its own loudness sets how much is lit
        const kindSeed = new Map(), kindStyle = new Map();
        for (const s of all) {
            const k = Sequencer.kindOf(s.name);
            if (!kindSeed.has(k)) kindSeed.set(k, Math.floor(rng() * 2 ** 31));
            kindStyle.set(k, (kindStyle.get(k) || []).concat(energies.get(s.id)));
        }
        const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
        const todo = sections || all;
        for (const s of todo) {
            const kind = Sequencer.kindOf(s.name);
            const pool = pools && pools[s.id];
            const own = !alike || !!(pool && pool.length);
            const rows = partIdea(s, song, show, {
                pool, seed: own ? Math.floor(rng() * 2 ** 31) : kindSeed.get(kind), scheme, feel, intensity, exclude: excluded, mix,
                energy: energies.get(s.id), style: own ? null : avg(kindStyle.get(kind)), matrixWords, phrased, mhParts,
            });
            plan.sections[s.id] = { rows, pool: pool || [] };
        }
        // Transitions between parts. A lift (into a chorus, or a big jump in
        // loudness) gets one of several moves, never the same twice running; the
        // dark-then-flash "build and land" is kept for the single biggest lift.
        // A big drop crossfades down.
        if (intensity == null) {
            const doing = new Set(todo.map(s => s.id));
            const trng = rngFrom(seed ^ 0x2545f491);
            const props = transitionProps(show, excluded);
            const pairs = [];
            for (let i = 0; i + 1 < all.length; i++) {
                const A = all[i], B = all[i + 1];
                const ea = energies.get(A.id), eb = energies.get(B.id);
                const lift = eb > 0.5 && (eb - ea > 0.2 || (LIFT.test(B.name) && !LIFT.test(A.name) && eb >= ea));
                if (lift) pairs.push({ A, B, jump: eb - ea, kind: 'lift' });
                else if (ea - eb > 0.35) pairs.push({ A, B, jump: eb - ea, kind: 'drop' });
            }
            const lifts = pairs.filter(p => p.kind === 'lift');
            const biggest = lifts.length ? lifts.reduce((x, y) => (y.jump > x.jump ? y : x)) : null;
            let prev = null;
            for (const p of pairs) {
                if (!doing.has(p.A.id) && !doing.has(p.B.id)) continue;
                let move;
                if (p.kind === 'drop') move = 'crossfade';
                else if (p === biggest && p.jump >= 0.3) move = 'build';
                else {
                    const opts = p.jump >= 0.35 ? ['ramp', 'sweep', 'burst'] : p.jump >= 0.2 ? ['ramp', 'sweep', 'burst', 'colourhit'] : ['crossfade', 'colourhit', 'sweep', 'ramp'];
                    const fresh = opts.filter(o => o !== prev && (o !== 'burst' || props.bursty.length) && ((o !== 'ramp' && o !== 'sweep') || props.big.length));
                    move = pick(trng, fresh.length ? fresh : opts);
                }
                prev = move;
                applyTransition(plan, song, p.A, p.B, move, { props, scheme, rng: trng, doA: doing.has(p.A.id), doB: doing.has(p.B.id) });
            }
        }
        // the ending follows the music: if it fades, the last part's lights fade with it
        const last = all[all.length - 1];
        if (ending && last && plan.sections[last.id]) {
            const nb = barsOf(song, last).length;
            for (const r of plan.sections[last.id].rows) if (r.trigger === 'span' && (!r.bars || r.bars[1] >= nb)) r.endFade = Math.min(ending, last.e - last.s);
        }
        return plan;
    }

    // Seconds the song takes to fade out at the end (0 when it stops dead).
    function endingFade(song) {
        const m = song.model, L = m.loudnessSmooth || m.loudness, step = m.loudStep || 0.05;
        if (!L || !L.length) return 0;
        const n = L.length, look = Math.min(n, Math.round(20 / step));
        let ref = 0;
        for (let i = Math.max(0, n - look); i < n - Math.round(4 / step); i++) ref = Math.max(ref, L[i]);
        if (ref <= 0.05) return 0;
        // the last moment still at 70% of the loud level before the end
        let i = n - 1;
        while (i > n - look && L[i] < ref * 0.7) i--;
        const fade = (n - 1 - i) * step;
        return fade >= 1.5 ? Math.round(fade * 10) / 10 : 0;
    }

    return { movingHeadIdea, TRANSITIONS, applyTransition, transitionProps, guessClass, CLASS_LABELS, sectionIdea, partIdea, planIdea, partEnergies, phrases, classify, candidates, mixEntries, FEELS, INTENSITIES, LEVELS };
})();
