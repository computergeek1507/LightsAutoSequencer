'use strict';

// Audio analysis for lighting sequences. Runs entirely in the browser.
//
// analyze()   – the expensive pass: spectral features, onsets, tempo detection.
// buildGrid() – cheap, re-run whenever the user edits BPM/offset/meter:
//               beats, bars, downbeats, sections, energy levels.
const Analysis = (() => {
    const SR = 22050;
    const N = 1024;
    const HOP = 256;
    const FPS = SR / HOP;          // feature frames per second (~86)
    const PEAK_BLOCK = 64;         // samples per waveform peak

    const BAND_EDGES = [0, 100, 200, 400, 800, 1600, 3200, 6400, SR / 2];
    const DRUM_BANDS = {
        kick: [40, 130],
        snare: [200, 2500],
        hat: [7000, 11000],
    };

    function makeFFT(n) {
        const levels = Math.log2(n) | 0;
        const rev = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            let r = 0;
            for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
            rev[i] = r;
        }
        const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) {
            cos[i] = Math.cos(2 * Math.PI * i / n);
            sin[i] = Math.sin(2 * Math.PI * i / n);
        }
        return (re, im) => {
            for (let i = 0; i < n; i++) {
                const j = rev[i];
                if (j > i) {
                    let t = re[i]; re[i] = re[j]; re[j] = t;
                    t = im[i]; im[i] = im[j]; im[j] = t;
                }
            }
            for (let size = 2; size <= n; size <<= 1) {
                const half = size >> 1, step = n / size;
                for (let i = 0; i < n; i += size) {
                    for (let j = i, k = 0; j < i + half; j++, k += step) {
                        const a = j + half;
                        const tre = re[a] * cos[k] + im[a] * sin[k];
                        const tim = im[a] * cos[k] - re[a] * sin[k];
                        re[a] = re[j] - tre; im[a] = im[j] - tim;
                        re[j] += tre; im[j] += tim;
                    }
                }
            }
        };
    }

    const tick = () => new Promise(r => setTimeout(r, 0));
    const hzToBin = hz => Math.round(hz * N / SR);
    const frameTime = f => f * HOP / SR;
    const timeFrame = t => Math.max(0, Math.round(t * SR / HOP));

    async function resampleMono(audioBuffer) {
        const len = Math.ceil(audioBuffer.duration * SR);
        const off = new OfflineAudioContext(1, len, SR);
        const src = off.createBufferSource();
        src.buffer = audioBuffer;
        src.connect(off.destination);
        src.start();
        const out = await off.startRendering();
        return out.getChannelData(0);
    }

    function waveformPeaks(x) {
        const n = Math.ceil(x.length / PEAK_BLOCK);
        const min = new Float32Array(n), max = new Float32Array(n);
        for (let b = 0; b < n; b++) {
            let lo = 0, hi = 0;
            const end = Math.min(x.length, (b + 1) * PEAK_BLOCK);
            for (let i = b * PEAK_BLOCK; i < end; i++) {
                const v = x[i];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            min[b] = lo; max[b] = hi;
        }
        return { min, max, blockSec: PEAK_BLOCK / SR };
    }

    async function spectralFeatures(x, progress) {
        const nFrames = Math.floor(x.length / HOP) + 1;
        const half = N / 2;
        const fft = makeFFT(N);
        const win = new Float64Array(N);
        for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);

        const re = new Float64Array(N), im = new Float64Array(N);
        let prev = new Float32Array(half), cur = new Float32Array(half);

        const flux = new Float32Array(nFrames);
        const drum = {};
        const drumRange = {};
        for (const k in DRUM_BANDS) {
            drum[k] = new Float32Array(nFrames);
            drumRange[k] = [Math.max(1, hzToBin(DRUM_BANDS[k][0])), Math.min(half - 1, hzToBin(DRUM_BANDS[k][1]))];
        }
        const rms = new Float32Array(nFrames);
        const chroma = new Float32Array(nFrames * 12);
        const nb = BAND_EDGES.length - 1;
        const bands = new Float32Array(nFrames * nb);

        const pcOfBin = new Int8Array(half).fill(-1);
        for (let k = hzToBin(80); k <= hzToBin(5000); k++) {
            const midi = 69 + 12 * Math.log2((k * SR / N) / 440);
            pcOfBin[k] = ((Math.round(midi) % 12) + 12) % 12;
        }
        const bandOfBin = new Int8Array(half);
        for (let k = 0; k < half; k++) {
            const f = k * SR / N;
            let b = 0;
            while (b < nb - 1 && f >= BAND_EDGES[b + 1]) b++;
            bandOfBin[k] = b;
        }

        for (let f = 0; f < nFrames; f++) {
            const start = f * HOP - half;  // centred frames: frame f is centred on f*HOP
            let sumsq = 0;
            for (let i = 0; i < N; i++) {
                const idx = start + i;
                const s = idx >= 0 && idx < x.length ? x[idx] : 0;
                sumsq += s * s;
                re[i] = s * win[i];
                im[i] = 0;
            }
            rms[f] = Math.sqrt(sumsq / N);
            fft(re, im);

            let total = 0;
            const cOff = f * 12, bOff = f * nb;
            for (let k = 1; k < half; k++) {
                const mag = Math.hypot(re[k], im[k]);
                const lm = Math.log1p(10 * mag);
                cur[k] = lm;
                const d = lm - prev[k];
                if (d > 0) total += d;
                const pc = pcOfBin[k];
                if (pc >= 0) chroma[cOff + pc] += mag;
                bands[bOff + bandOfBin[k]] += mag * mag;
            }
            for (const key in drumRange) {
                const [lo, hi] = drumRange[key];
                let s = 0;
                for (let k = lo; k <= hi; k++) {
                    const d = cur[k] - prev[k];
                    if (d > 0) s += d;
                }
                drum[key][f] = s;
            }
            flux[f] = f === 0 ? 0 : total;
            for (let b = 0; b < nb; b++) bands[bOff + b] = Math.log10(bands[bOff + b] + 1e-6);

            const t = prev; prev = cur; cur = t;
            if ((f & 2047) === 0) {
                progress && progress(0.15 + 0.6 * f / nFrames, 'Reading the spectrum');
                await tick();
            }
        }
        for (const key in drum) drum[key][0] = 0;
        return { nFrames, flux, drum, rms, chroma, bands, nb };
    }

    function movingMedian(a, halfWin) {
        const out = new Float32Array(a.length);
        const buf = new Float32Array(2 * halfWin + 1);
        for (let i = 0; i < a.length; i++) {
            const lo = Math.max(0, i - halfWin), hi = Math.min(a.length - 1, i + halfWin);
            const w = buf.subarray(0, hi - lo + 1);
            w.set(a.subarray(lo, hi + 1));
            w.sort();
            out[i] = w[w.length >> 1];
        }
        return out;
    }

    // Novelty after removing the local median, so a steady loud passage is
    // not mistaken for a run of onsets.
    function detrend(n) {
        const med = movingMedian(n, Math.round(0.25 * FPS));
        const z = new Float32Array(n.length);
        for (let i = 0; i < n.length; i++) z[i] = Math.max(0, n[i] - med[i]);
        return z;
    }

    function meanStd(a) {
        let s = 0, s2 = 0;
        for (let i = 0; i < a.length; i++) { s += a[i]; s2 += a[i] * a[i]; }
        const m = s / a.length;
        return [m, Math.sqrt(Math.max(0, s2 / a.length - m * m))];
    }

    function pickPeaks(z, { sensitivity, minGapSec, active }) {
        const [m, sd] = meanStd(z);
        const thr = m + sensitivity * sd;
        const lw = 3;
        const minGap = Math.max(1, Math.round(minGapSec * FPS));
        const peaks = [];
        for (let i = 1; i < z.length - 1; i++) {
            const v = z[i];
            if (v <= thr || !active[i]) continue;
            let isMax = true;
            for (let j = Math.max(0, i - lw); j <= Math.min(z.length - 1, i + lw); j++) {
                if (z[j] > v || (z[j] === v && j < i)) { isMax = false; break; }
            }
            if (!isMax) continue;
            const last = peaks[peaks.length - 1];
            if (last && i - last.f < minGap) {
                if (v > last.s) { last.f = i; last.s = v; }
                continue;
            }
            peaks.push({ f: i, s: v });
        }
        let maxS = 0;
        for (const p of peaks) maxS = Math.max(maxS, p.s);
        return peaks.map(p => ({ t: frameTime(p.f), s: maxS > 0 ? p.s / maxS : 0 }));
    }

    // Autocorrelation of the onset envelope with a log-normal prior around
    // 120 BPM. Only good to a couple of percent – fitGrid() refines it.
    function roughTempo(env) {
        const minLag = Math.floor(60 / 240 * FPS), maxLag = Math.ceil(60 / 40 * FPS);
        const acf = new Float64Array(maxLag + 2);
        const n = env.length;
        for (let L = minLag - 1; L <= maxLag + 1; L++) {
            let s = 0;
            for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
            acf[L] = s / (n - L);
        }
        let best = minLag, bestScore = -Infinity;
        for (let L = minLag; L <= maxLag; L++) {
            const bpm = 60 * FPS / L;
            const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
            const score = acf[L] * prior;
            if (score > bestScore) { bestScore = score; best = L; }
        }
        const a = acf[best - 1], b = acf[best], c = acf[best + 1];
        const denom = a - 2 * b + c;
        const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
        return 60 * FPS / (best + Math.max(-0.5, Math.min(0.5, shift)));
    }

    // Circular concentration of onsets on a grid of period T. Unitless, so it
    // does not favour fast tempos the way a millisecond error score does.
    function phaseFit(onsets, T) {
        let c = 0, s = 0, w = 0;
        for (const o of onsets) {
            const ph = 2 * Math.PI * o.t / T;
            c += o.s * Math.cos(ph);
            s += o.s * Math.sin(ph);
            w += o.s;
        }
        const R = w > 0 ? Math.hypot(c, s) / w : 0;
        let offset = (Math.atan2(s, c) / (2 * Math.PI)) * T;
        offset = ((offset % T) + T) % T;
        return { R, offset };
    }

    function fitGrid(onsets, bpmLo, bpmHi, step) {
        let best = { bpm: bpmLo, R: -1, offset: 0 };
        for (let bpm = bpmLo; bpm <= bpmHi + 1e-9; bpm += step) {
            const r = phaseFit(onsets, 60 / bpm);
            if (r.R > best.R) best = { bpm, R: r.R, offset: r.offset };
        }
        return best;
    }

    function medianOf(arr) {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        return s[s.length >> 1];
    }

    // Kick gaps that are a whole number of beats, bucketed by length in beats.
    function kickGapHistogram(kicks, T) {
        const h = { 0.5: 0, 1: 0, 2: 0, 4: 0 };
        for (let i = 1; i < kicks.length; i++) {
            const g = (kicks[i].t - kicks[i - 1].t) / T;
            for (const m in h) if (Math.abs(g - m) < 0.1 * m) h[m]++;
        }
        return h;
    }

    function detectTempo(onsets) {
        const rough = roughTempo(onsets.envelope);
        const coarse = fitGrid(onsets.all, rough * 0.95, rough * 1.05, 0.05);
        let bpm = fitGrid(onsets.all, coarse.bpm - 0.1, coarse.bpm + 0.1, 0.005).bpm;

        // Octave: the kick marks the beat. Hi-hats on eighths drag the grid to
        // double time, which shows up as kicks two or four "beats" apart far
        // more often than one. Gap evidence from a full mix is noisy, so only
        // act on a clear majority.
        const kicks = onsets.kick.filter(k => k.s > 0.3);
        let octave = 'kept';
        const h = kickGapHistogram(kicks, 60 / bpm);
        const evenGaps = h[2] + h[4];
        if (bpm >= 110 && evenGaps >= 15 && evenGaps > 1.5 * h[1]) {
            bpm /= 2;
            octave = 'halved';
        } else if (bpm < 90 && h[0.5] >= 15 && h[0.5] > 1.5 * h[1]) {
            bpm *= 2;
            octave = 'doubled';
        }

        // Precision: the mix's onsets wander (bass notes, vocals), the kick does
        // not, so polish the tempo against the strong kicks.
        const anchor = kicks.length >= 40 ? kicks : onsets.all;
        let fine = fitGrid(anchor, bpm * 0.994, bpm * 1.006, 0.005);
        // Most produced music is at a whole (or half) BPM; prefer it if it fits as well.
        for (const cand of [Math.round(fine.bpm), Math.round(fine.bpm * 2) / 2]) {
            const r = phaseFit(anchor, 60 / cand);
            if (Math.abs(cand - fine.bpm) < 0.06 && r.R >= 0.985 * fine.R) { fine = { bpm: cand, ...r }; break; }
        }
        // Phase from the kick alone: in half-time feels the snare sits on the
        // off-beat and averaging it in drags the grid half a beat out.
        return { bpm: Math.round(fine.bpm * 1000) / 1000, offset: fine.offset, R: fine.R, rough, octave, octaveFrom: octave === 'kept' ? null : coarse.bpm };
    }

    async function analyze(audioBuffer, progress) {
        progress && progress(0.02, 'Resampling');
        await tick();
        const x = await resampleMono(audioBuffer);
        const peaks = waveformPeaks(x);
        progress && progress(0.15, 'Reading the spectrum');
        const feat = await spectralFeatures(x, progress);

        progress && progress(0.78, 'Finding hits');
        await tick();
        let maxRms = 0;
        for (const v of feat.rms) maxRms = Math.max(maxRms, v);
        const active = new Uint8Array(feat.nFrames);
        let first = -1, last = -1;
        for (let i = 0; i < feat.nFrames; i++) {
            if (feat.rms[i] > maxRms * 0.01) {   // -40 dB
                active[i] = 1;
                if (first < 0) first = i;
                last = i;
            }
        }
        const envelope = detrend(feat.flux);
        const onsets = {
            envelope,
            all: pickPeaks(envelope, { sensitivity: 0.6, minGapSec: 0.05, active }),
            kick: pickPeaks(detrend(feat.drum.kick), { sensitivity: 1.0, minGapSec: 0.1, active }),
            snare: pickPeaks(detrend(feat.drum.snare), { sensitivity: 1.3, minGapSec: 0.1, active }),
            hat: pickPeaks(detrend(feat.drum.hat), { sensitivity: 1.0, minGapSec: 0.06, active }),
        };

        progress && progress(0.88, 'Fitting the tempo');
        await tick();
        const tempo = detectTempo(onsets);

        const loudStep = 0.05;
        const nL = Math.ceil(audioBuffer.duration / loudStep);
        const loudDb = new Float32Array(nL);
        for (let i = 0; i < nL; i++) {
            const f0 = timeFrame(i * loudStep), f1 = Math.min(feat.nFrames, timeFrame((i + 1) * loudStep));
            let s = 0, c = 0;
            for (let f = f0; f < Math.max(f1, f0 + 1) && f < feat.nFrames; f++) { s += feat.rms[f] * feat.rms[f]; c++; }
            loudDb[i] = 10 * Math.log10((c ? s / c : 0) / (maxRms * maxRms) + 1e-10);
        }
        const sortedDb = Array.from(loudDb).filter(v => v > -60).sort((a, b) => a - b);
        const floor = sortedDb.length ? sortedDb[Math.floor(sortedDb.length * 0.05)] : -60;
        const loudness = new Float32Array(nL);
        for (let i = 0; i < nL; i++) loudness[i] = Math.max(0, Math.min(1, (loudDb[i] - floor) / (0 - floor)));

        // ~0.3 s moving average, for display; the raw curve stays in the export.
        const loudnessSmooth = new Float32Array(nL);
        for (let i = 0; i < nL; i++) {
            let s = 0, c = 0;
            for (let j = Math.max(0, i - 3); j <= Math.min(nL - 1, i + 3); j++) { s += loudness[j]; c++; }
            loudnessSmooth[i] = s / c;
        }

        progress && progress(1, 'Done');
        return {
            duration: audioBuffer.duration,
            songStart: first >= 0 ? frameTime(first) : 0,
            songEnd: last >= 0 ? frameTime(last) : audioBuffer.duration,
            peaks, feat, onsets, tempo,
            loudness, loudnessSmooth, loudStep,
        };
    }

    // ---- everything below depends on the beat grid ----

    function nearestStrength(list, t, tol) {
        // list is sorted by time
        let lo = 0, hi = list.length - 1, best = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (list[mid].t < t - tol) lo = mid + 1;
            else if (list[mid].t > t + tol) hi = mid - 1;
            else {
                for (let i = mid; i >= 0 && list[i].t >= t - tol; i--) best = Math.max(best, list[i].s);
                for (let i = mid; i < list.length && list[i].t <= t + tol; i++) best = Math.max(best, list[i].s);
                break;
            }
        }
        return best;
    }

    function meanVec(feat, arr, dims, f0, f1) {
        const v = new Float64Array(dims);
        f1 = Math.min(f1, feat.nFrames);
        const n = Math.max(1, f1 - f0);
        for (let f = f0; f < f1; f++) for (let d = 0; d < dims; d++) v[d] += arr[f * dims + d];
        for (let d = 0; d < dims; d++) v[d] /= n;
        return v;
    }

    function unit(v) {
        let s = 0;
        for (const x of v) s += x * x;
        s = Math.sqrt(s) || 1;
        return v.map(x => x / s);
    }

    function rmsDb(feat, t0, t1) {
        const f0 = timeFrame(t0), f1 = Math.min(feat.nFrames, Math.max(timeFrame(t1), f0 + 1));
        let s = 0;
        for (let f = f0; f < f1; f++) s += feat.rms[f] * feat.rms[f];
        return 10 * Math.log10(s / Math.max(1, f1 - f0) + 1e-10);
    }

    function downbeatEvidence(model, beats, meter) {
        const feat = model.feat;
        const kick = beats.map(t => nearestStrength(model.onsets.kick, t, 0.05));
        const snare = beats.map(t => nearestStrength(model.onsets.snare, t, 0.05));
        // Harmony tends to change on the bar line; compare whole bars either side.
        const chord = beats.map((t, i) => {
            if (i < meter || i + meter >= beats.length) return 0;
            const a = unit(meanVec(feat, feat.chroma, 12, timeFrame(beats[i - meter]), timeFrame(t)));
            const b = unit(meanVec(feat, feat.chroma, 12, timeFrame(t), timeFrame(beats[i + meter])));
            let dot = 0;
            for (let d = 0; d < 12; d++) dot += a[d] * b[d];
            return 1 - dot;
        });
        const perPhase = arr => {
            const s = new Array(meter).fill(0), c = new Array(meter).fill(0);
            arr.forEach((v, i) => { s[i % meter] += v; c[i % meter]++; });
            const m = s.map((v, p) => v / (c[p] || 1));
            const mean = m.reduce((a, b) => a + b, 0) / meter;
            return m.map(v => mean > 0 ? v / mean - 1 : 0);
        };
        // Big changes in sound (a chorus landing, a drop) happen on bar lines.
        const nb = feat.nb;
        const timbre = beats.map((t, i) => {
            if (i < meter || i + meter >= beats.length) return 0;
            const a = meanVec(feat, feat.bands, nb, timeFrame(beats[i - meter]), timeFrame(t));
            const b = meanVec(feat, feat.bands, nb, timeFrame(t), timeFrame(beats[i + meter]));
            let d = 0;
            for (let k = 0; k < nb; k++) d += (a[k] - b[k]) ** 2;
            return Math.sqrt(d);
        });
        const nPeaks = Math.max(6, Math.round((model.songEnd - model.songStart) / 15));
        const peaks = timbre.map((v, i) => i).filter(i => i > 0 && i < timbre.length - 1 && timbre[i] >= timbre[i - 1] && timbre[i] >= timbre[i + 1])
            .sort((a, b) => timbre[b] - timbre[a]).slice(0, nPeaks);
        const share = new Array(meter).fill(0);
        let tot = 0;
        for (const i of peaks) { share[i % meter] += timbre[i]; tot += timbre[i]; }
        const struct = share.map(v => tot > 0 ? (v / tot - 1 / meter) * 2 : 0);
        return { kick: perPhase(kick), snare: perPhase(snare), chord: perPhase(chord), struct };
    }

    function chooseDownbeat(model, beats, meter) {
        const ev = downbeatEvidence(model, beats, meter);
        const score = ev.kick.map((k, p) => k - ev.snare[p] + 2 * ev.chord[p] + ev.struct[p]);
        let best = 0;
        for (let p = 1; p < meter; p++) if (score[p] > score[best]) best = p;
        return best;
    }

    function gridFit(model, beatsT, T) {
        const kicks = model.onsets.kick.filter(o => o.s > 0.3);
        const list = kicks.length > 16 ? model.onsets.kick : model.onsets.all;
        const strong = list.filter(o => o.s > 0.3);
        if (!strong.length || !beatsT.length) return null;
        const errs = [];
        const signedByThird = [[], [], []];
        const span = model.songEnd - model.songStart || 1;
        for (const o of strong) {
            const k = Math.round((o.t - beatsT[0]) / T);
            const d = o.t - (beatsT[0] + k * T);
            // only judge hits that are near a beat, not syncopations
            if (Math.abs(d) > T / 4) continue;
            errs.push(Math.abs(d));
            const third = Math.min(2, Math.max(0, Math.floor(3 * (o.t - model.songStart) / span)));
            signedByThird[third].push(d);
        }
        if (!errs.length) return null;
        const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
        const within = errs.filter(e => e <= 0.04).length / errs.length;
        const thirds = signedByThird.map(a => a.length ? medianOf(a) : 0);
        return {
            meanMs: mean * 1000,
            within40: within,
            driftMs: (thirds[2] - thirds[0]) * 1000,
            source: list === model.onsets.kick ? 'kick' : 'onsets',
        };
    }

    function detectSections(model, bars) {
        const feat = model.feat;
        const nBars = bars.length;
        if (nBars < 8) return { boundaries: [], ssm: null };

        const vecs = bars.map(b => {
            const f0 = timeFrame(b.s), f1 = Math.max(f0 + 1, timeFrame(b.e));
            const c = unit(meanVec(feat, feat.chroma, 12, f0, f1));
            const bd = meanVec(feat, feat.bands, feat.nb, f0, f1);
            return { c, bd };
        });
        const nb = feat.nb;
        const mu = new Float64Array(nb), sd = new Float64Array(nb);
        for (const v of vecs) for (let d = 0; d < nb; d++) mu[d] += v.bd[d] / nBars;
        for (const v of vecs) for (let d = 0; d < nb; d++) sd[d] += (v.bd[d] - mu[d]) ** 2 / nBars;
        for (let d = 0; d < nb; d++) sd[d] = Math.sqrt(sd[d]) || 1;
        const raw = vecs.map(v => {
            const out = Array.from(v.c);
            for (let d = 0; d < nb; d++) out.push(0.3 * (v.bd[d] - mu[d]) / sd[d]);
            return out;
        });
        const ssm = vecs => {
            const D = [], all = [];
            for (let i = 0; i < nBars; i++) {
                D.push(new Float64Array(nBars));
                for (let j = 0; j < nBars; j++) {
                    let s = 0;
                    for (let d = 0; d < vecs[i].length; d++) s += (vecs[i][d] - vecs[j][d]) ** 2;
                    D[i][j] = s;
                    if (j > i) all.push(s);
                }
            }
            const sigma2 = medianOf(all) || 1;
            return D.map(row => row.map(v => Math.exp(-v / sigma2)));
        };
        // Boundaries come from the plain per-bar matrix. Labels use a two-bar
        // embedding, which makes repeated passages stand out as diagonals but
        // would pull boundaries half a bar early.
        const Sb = ssm(raw);
        const S = ssm(raw.map((v, i) => v.concat(raw[Math.min(nBars - 1, i + 1)])));

        const K = Math.min(4, Math.floor(nBars / 4));
        const nov = new Float64Array(nBars);
        for (let i = 1; i < nBars; i++) {
            let s = 0, w = 0;
            for (let a = -K; a < K; a++) {
                for (let b = -K; b < K; b++) {
                    const ia = i + a, ib = i + b;
                    if (ia < 0 || ib < 0 || ia >= nBars || ib >= nBars) continue;
                    const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * (K / 2) ** 2));
                    const sign = (a < 0) === (b < 0) ? 1 : -1;
                    s += sign * g * Sb[ia][ib];
                    w += g;
                }
            }
            nov[i] = w ? Math.max(0, s / w) : 0;
        }
        // Big changes in loudness matter for lighting even when the harmony repeats.
        const barDb = bars.map(b => rmsDb(feat, b.s, b.e));
        const loudNov = new Float64Array(nBars);
        for (let i = 2; i < nBars - 1; i++) {
            const before = (barDb[i - 1] + barDb[i - 2]) / 2;
            const after = (barDb[i] + barDb[i + 1]) / 2;
            loudNov[i] = Math.abs(after - before);
        }
        const nMax = Math.max(...nov) || 1, lMax = Math.max(...loudNov) || 1;
        const score = new Float64Array(nBars);
        for (let i = 0; i < nBars; i++) score[i] = nov[i] / nMax + 0.5 * loudNov[i] / lMax;

        // Songs move in 4-bar phrases; find the phrase phase and favour it.
        const phase = [0, 1, 2, 3].map(q => { let s = 0; for (let i = q; i < nBars; i += 4) s += score[i]; return s; });
        const q = phase.indexOf(Math.max(...phase));
        for (let i = 0; i < nBars; i++) if ((i - q) % 4 === 0) score[i] *= 1.25;

        const [m, sdv] = meanStd(score);
        const cands = [];
        for (let i = 2; i < nBars - 2; i++) {
            if (score[i] >= score[i - 1] && score[i] >= score[i + 1]) cands.push(i);
        }
        cands.sort((a, b) => score[b] - score[a]);
        const maxSections = Math.max(4, Math.min(16, Math.round((model.songEnd - model.songStart) / 15)));
        const chosen = [];
        for (const i of cands) {
            if (score[i] < m) break;
            if (chosen.length >= maxSections - 1) break;
            if (chosen.some(c => Math.abs(c - i) < 4)) continue;
            chosen.push(i);
        }
        chosen.sort((a, b) => a - b);
        return { boundaries: chosen, S, phrasePhase: q, barDb };
    }

    function sectionSimilarity(S, a0, a1, b0, b1) {
        const len = Math.min(a1 - a0, b1 - b0);
        let best = 0;
        for (let shift = -1; shift <= 1; shift++) {
            let s = 0, c = 0;
            for (let i = 0; i < len; i++) {
                const ia = a0 + i, ib = b0 + i + shift;
                if (ib < b0 || ib >= b1 || ib >= S.length) continue;
                s += S[ia][ib]; c++;
            }
            if (c) best = Math.max(best, s / c);
        }
        return best;
    }

    function labelSections(model, bars, det) {
        const { boundaries, S } = det;
        const starts = [0].concat(boundaries);
        const segs = starts.map((b, i) => ({ b0: b, b1: i + 1 < starts.length ? starts[i + 1] : bars.length }));

        const sims = [];
        for (let i = 0; i < segs.length; i++) for (let j = 0; j < i; j++) {
            sims.push(sectionSimilarity(S, segs[j].b0, segs[j].b1, segs[i].b0, segs[i].b1));
        }
        const [sm, ss] = sims.length ? meanStd(Float64Array.from(sims)) : [0, 0];
        const thr = Math.max(0.45, sm + 0.6 * ss);

        let nextLetter = 0;
        for (let i = 0; i < segs.length; i++) {
            let best = -1, bestSim = thr;
            for (let j = 0; j < i; j++) {
                const s = sectionSimilarity(S, segs[j].b0, segs[j].b1, segs[i].b0, segs[i].b1);
                if (s > bestSim) { bestSim = s; best = j; }
            }
            segs[i].letter = best >= 0 ? segs[best].letter : String.fromCharCode(65 + nextLetter++);
        }

        const dbs = segs.map(s => rmsDb(model.feat, bars[s.b0].s, bars[s.b1 - 1].e));
        const lo = Math.min(...dbs), hi = Math.max(...dbs);
        segs.forEach((s, i) => { s.energy = hi > lo ? (dbs[i] - lo) / (hi - lo) : 0.5; });

        const byLetter = {};
        for (const s of segs) (byLetter[s.letter] = byLetter[s.letter] || []).push(s);
        const repeated = Object.keys(byLetter).filter(l => byLetter[l].length > 1);
        const avgE = l => byLetter[l].reduce((a, s) => a + s.energy, 0) / byLetter[l].length;
        let chorus = null, verse = null;
        if (repeated.length) {
            chorus = repeated.reduce((a, b) => avgE(b) > avgE(a) + 0.02 ? b : a);
            const others = repeated.filter(l => l !== chorus && avgE(l) < avgE(chorus));
            if (others.length) verse = others.reduce((a, b) => segs.indexOf(byLetter[b][0]) < segs.indexOf(byLetter[a][0]) ? b : a);
        }
        const firstChorus = segs.findIndex(s => s.letter === chorus);

        segs.forEach((s, i) => {
            const nBars = s.b1 - s.b0;
            if (s.letter === chorus) s.kind = 'Chorus';
            else if (s.letter === verse) s.kind = 'Verse';
            else if (i === 0 && (byLetter[s.letter].length === 1 || s.energy < 0.4) && nBars <= 12) s.kind = 'Intro';
            else if (i === segs.length - 1 && (byLetter[s.letter].length === 1 || s.energy < 0.5)) s.kind = 'Outro';
            else if (i + 1 < segs.length && segs[i + 1].letter === chorus && nBars <= 8) s.kind = 'Pre-Chorus';
            else if (s.energy < 0.25) s.kind = 'Break';
            else if (firstChorus >= 0 && i > firstChorus && byLetter[s.letter].length === 1) s.kind = 'Bridge';
            else s.kind = 'Section ' + s.letter;
        });
        const counts = {}, seen = {};
        for (const s of segs) counts[s.kind] = (counts[s.kind] || 0) + 1;
        for (const s of segs) {
            seen[s.kind] = (seen[s.kind] || 0) + 1;
            s.name = counts[s.kind] > 1 ? `${s.kind} ${seen[s.kind]}` : s.kind;
        }

        return segs.map((s, i) => ({
            s: i === 0 ? 0 : bars[s.b0].s,
            e: i === segs.length - 1 ? model.duration : bars[s.b1].s,
            bars: s.b1 - s.b0,
            letter: s.letter,
            name: s.name,
            energy: s.energy,
        }));
    }

    function energyLevels(model, bars) {
        const db = bars.map(b => rmsDb(model.feat, b.s, b.e));
        const sm = db.map((v, i) => medianOf([db[Math.max(0, i - 1)], v, db[Math.min(db.length - 1, i + 1)]]));
        const sorted = [...sm].sort((a, b) => a - b);
        const q = [0.2, 0.4, 0.6, 0.8].map(p => sorted[Math.floor(p * (sorted.length - 1))]);
        const lvl = sm.map(v => 1 + q.filter(x => v > x).length);
        const out = [];
        for (let i = 0; i < bars.length; i++) {
            const last = out[out.length - 1];
            if (last && last.level === lvl[i]) last.e = bars[i].e;
            else out.push({ s: bars[i].s, e: bars[i].e, level: lvl[i] });
        }
        return out;
    }

    function buildGrid(model, { bpm, offset, meter, barShift }) {
        const T = 60 / bpm;
        const startAt = Math.max(0, model.songStart - 0.1 * T);
        let k = Math.ceil((startAt - offset) / T);
        const beatsT = [];
        for (let t = offset + k * T; t < model.songEnd + 0.5 * T && t < model.duration; t += T) beatsT.push(t);

        const detectedShift = beatsT.length > meter * 2 ? chooseDownbeat(model, beatsT, meter) : 0;
        const shift = barShift == null ? detectedShift : barShift;

        const beats = beatsT.map((t, i) => ({
            s: t,
            e: i + 1 < beatsT.length ? beatsT[i + 1] : Math.min(model.duration, t + T),
            n: ((i - shift) % meter + meter) % meter + 1,
        }));

        const bars = [];
        let barNo = 0;
        for (let i = 0; i < beats.length; i++) {
            if (beats[i].n === 1 || i === 0) {
                if (beats[i].n !== 1) barNo = 0; else barNo++;
                bars.push({ s: beats[i].s, e: beats[i].e, n: barNo, beatIdx: i });
            } else {
                bars[bars.length - 1].e = beats[i].e;
            }
        }

        const det = detectSections(model, bars);
        const sections = det.S ? labelSections(model, bars, det)
            : [{ s: 0, e: model.duration, bars: bars.length, letter: 'A', name: 'Song', energy: 1 }];

        const phrases = [];
        if (det.S) {
            const q = det.phrasePhase;
            for (let i = 0; i < bars.length; i++) {
                if (i === 0 || (i - q) % 4 === 0) phrases.push({ s: bars[i].s, e: bars[i].e });
                else phrases[phrases.length - 1].e = bars[i].e;
            }
        }

        return {
            bpm, offset, meter, T,
            barShift: shift, detectedShift,
            beats, bars, sections, phrases,
            energy: energyLevels(model, bars),
            fit: gridFit(model, beatsT, T),
        };
    }

    function refitOffset(model, bpm) {
        const strong = model.onsets.kick.filter(o => o.s > 0.3);
        return phaseFit(strong.length >= 40 ? strong : model.onsets.all, 60 / bpm).offset;
    }

    return { analyze, buildGrid, refitOffset, _debug: { downbeatEvidence } };
})();
