'use strict';

// How well a plan follows the music, measured from the preview the way a
// viewer would see it:
//   loud  - does the house get brighter when the song gets louder?
//   beat  - do the lights change more on the beat than between beats?
//   lift  - are the loud parts (choruses) brighter than the quiet ones?
// Each is 0..1; score is 0..100. Draws every few lights only (stride), so a
// whole song measures in a second or two.
const Fit = (() => {
    const STEP = 0.25;    // seconds between loudness samples
    const STRIDE = 8;

    function corr(a, b) {
        const n = Math.min(a.length, b.length);
        if (n < 3) return 0;
        let ma = 0, mb = 0;
        for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
        ma /= n; mb /= n;
        let sab = 0, saa = 0, sbb = 0;
        for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
        return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
    }

    // signal: { cancelled } — set it to stop a measurement that is no longer wanted
    async function measure(plan, song, show, signal = {}) {
        const gen = Sequencer.generate(plan, song, show);
        if (!gen.count) return null;
        const prep = Sequencer.prepare(show, gen, song, STRIDE);
        // each light weighted by 1 / (lights in its model), so the 4800-light
        // matrix counts as one prop, not as a third of the show
        const idx = new Map();
        for (const t of prep.targets) for (let k = 0; k < t.N.n; k++) {
            const g = t.N.g[k];
            if (idx.has(g)) continue;
            let mdl = null;
            for (const mm of show.models.values()) if (g >= mm.offset && g < mm.offset + mm.nodes.length) { mdl = mm; break; }
            idx.set(g, mdl ? mdl.name : '');
        }
        const nodes = Int32Array.from(idx.keys());
        if (!nodes.length) return null;
        const per = new Map();
        for (const name of idx.values()) per.set(name, (per.get(name) || 0) + 1);
        const wt = Float32Array.from(idx.values(), name => 1 / (per.get(name) * per.size));
        const out = prep.colors;
        const frame = t => { Sequencer.renderFrame(prep, song, t); return out; };
        const level = t => {
            frame(t);
            let s = 0;
            nodes.forEach((g, i) => { s += (out[3 * g] + out[3 * g + 1] + out[3 * g + 2]) * wt[i]; });
            return s / 765;
        };
        let prev = new Float32Array(nodes.length);
        const snap = t => {
            frame(t);
            const v = new Float32Array(nodes.length);
            nodes.forEach((g, i) => { v[i] = (out[3 * g] + out[3 * g + 1] + out[3 * g + 2]) * wt[i]; });
            return v;
        };
        const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / 765; };
        let work = 0;
        const yieldNow = async () => { if (++work % 40 === 0) await new Promise(r => setTimeout(r, 0)); return signal.cancelled; };

        // brightness over the song against loudness
        const m = song.model, L = m.loudnessSmooth || m.loudness, ls = m.loudStep || 0.05;
        const bright = [], loud = [], times = [];
        for (let t = STEP / 2; t < m.duration; t += STEP) {
            bright.push(level(t));
            loud.push(L ? L[Math.min(L.length - 1, Math.floor(t / ls))] : 0);
            times.push(t);
            if (await yieldNow()) return null;
        }
        // smooth over a second, so single flashes don't swamp the trend
        const sm = bright.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - 2); j <= Math.min(bright.length - 1, i + 2); j++) { s += bright[j]; c++; } return s / c; });
        const rLoud = corr(sm, loud);

        // change just after each beat vs the same gap in the middle of the beat
        const T = song.grid.T, beats = song.grid.beats;
        let on = 0, off = 0;
        for (let i = 0; i < beats.length; i += 2) {
            const b = beats[i].s;
            prev = snap(b - 0.04);
            on += diff(prev, snap(b + 0.08));
            prev = snap(b + T * 0.45);
            off += diff(prev, snap(b + T * 0.45 + 0.12));
            if (await yieldNow()) return null;
        }
        const beatRatio = off > 0 ? on / off : on > 0 ? 3 : 1;

        // parts: brightness against their loudness
        const energies = Ideas.partEnergies(song);
        const parts = song.sections.map(s => {
            let sum = 0, n = 0;
            times.forEach((t, i) => { if (t >= s.s && t < s.e) { sum += bright[i]; n++; } });
            return { id: s.id, name: s.name, bright: n ? sum / n : 0, energy: energies.get(s.id) };
        }).filter(p => p.energy != null);
        const rLift = corr(parts.map(p => p.bright), parts.map(p => p.energy));

        const loudS = Math.max(0, Math.min(1, rLoud / 0.6));
        const beatS = Math.max(0, Math.min(1, (beatRatio - 1) / 1.5));
        const liftS = Math.max(0, Math.min(1, rLift / 0.7));
        return {
            loud: loudS, beat: beatS, lift: liftS,
            score: Math.round(100 * (0.35 * loudS + 0.35 * beatS + 0.3 * liftS)),
            raw: { rLoud, beatRatio, rLift, parts },
        };
    }

    return { measure };
})();
