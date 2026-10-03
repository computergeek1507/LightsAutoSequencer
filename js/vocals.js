'use strict';

// Vocals: isolate the voice, find the words, time them to the singing, and
// track the melody.
//
// The approach is the one proven on the desktop pipeline:
//   * Whisper is a good CLOCK and a bad TRANSCRIBER. Take the words from the
//     real lyrics when the user pastes them, the times from Whisper.
//   * Raw Whisper starts drift, worst at the start of a line, so every start
//     is snapped to a real rising edge in the vocal stem.
//   * A word must not start in dead air, nor stay lit across a rest.
const Vocals = (() => {
    const SR = 22050;
    const HOP = 110;                 // 5 ms envelope frames
    const ENV_FPS = SR / HOP;
    const CACHE_DB = 'xlweb-cache';

    // ---------- small helpers ----------

    const tick = () => new Promise(r => setTimeout(r, 0));

    function resample(buffer, rate, channels) {
        const off = new OfflineAudioContext(channels, Math.ceil(buffer.duration * rate), rate);
        const src = off.createBufferSource();
        src.buffer = buffer;
        src.connect(off.destination);
        src.start();
        return off.startRendering();
    }

    async function monoAt(samples, fromRate, toRate) {
        const b = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: fromRate });
        b.copyToChannel(samples, 0);
        return (await resample(b, toRate, 1)).getChannelData(0);
    }

    // IndexedDB key/value, best effort: a private window or full disk just means no cache.
    function idb() {
        return new Promise((res, rej) => {
            const r = indexedDB.open(CACHE_DB, 1);
            r.onupgradeneeded = () => r.result.createObjectStore('kv');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    async function cacheGet(key) {
        try {
            const db = await idb();
            return await new Promise(res => {
                const q = db.transaction('kv').objectStore('kv').get(key);
                q.onsuccess = () => res(q.result);
                q.onerror = () => res(undefined);
            });
        } catch (e) { return undefined; }
    }
    async function cachePut(key, val) {
        try {
            const db = await idb();
            await new Promise(res => {
                const t = db.transaction('kv', 'readwrite');
                t.objectStore('kv').put(val, key);
                t.oncomplete = res;
                t.onerror = res;
            });
        } catch (e) { /* no cache */ }
    }

    function runWorker(file, message, transfer, onEvent) {
        return new Promise((resolve, reject) => {
            const w = new Worker(file, { type: 'module' });
            w.onmessage = e => {
                const d = e.data;
                if (d.type === 'done') { w.terminate(); resolve(d); }
                else if (d.type === 'error') { w.terminate(); reject(new Error(d.message)); }
                else onEvent(d);
            };
            w.onerror = e => { w.terminate(); reject(new Error(e.message || 'worker failed')); };
            w.postMessage(message, transfer);
        });
    }

    // ---------- 1. separation ----------

    async function separate(buffer, hash, report) {
        const key = 'vocal22:' + hash;
        const cached = await cacheGet(key);
        if (cached) { report(1, 'Voice already separated (cached)'); return cached; }

        const st = buffer.sampleRate === 44100 && buffer.numberOfChannels === 2 ? buffer : await resample(buffer, 44100, 2);
        const left = new Float32Array(st.getChannelData(0));
        const right = new Float32Array(st.numberOfChannels > 1 ? st.getChannelData(1) : st.getChannelData(0));
        const res = await runWorker('js/workers/separate.js', { left, right }, [left.buffer, right.buffer], d => {
            if (d.type === 'status') report(null, d.text);
            if (d.type === 'download') report(d.total ? d.loaded / d.total * 0.3 : null, `Downloading voice model ${mb(d.loaded)} of ${mb(d.total)}`);
            if (d.type === 'progress') report(0.3 + 0.7 * d.value, 'Separating the voice from the music');
        });
        const mono = new Float32Array(res.left.length);
        for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (res.left[i] + res.right[i]);
        const v22 = new Float32Array(await monoAt(mono, 44100, SR));
        await cachePut(key, v22);
        return v22;
    }

    const mb = n => (n / 1048576).toFixed(0) + ' MB';

    // ---------- 2. the vocal stem: envelope, voiced segments, onsets ----------

    function envelope(x) {
        const nf = Math.floor(x.length / HOP);
        const rms = new Float32Array(nf);
        for (let f = 0; f < nf; f++) {
            let s = 0;
            const o = f * HOP;
            for (let k = 0; k < HOP; k++) { const v = x[o + k]; s += v * v; }
            rms[f] = Math.sqrt(s / HOP);
        }
        // light smoothing: one quiet frame must not split a word
        const sm = new Float32Array(nf);
        for (let f = 0; f < nf; f++) {
            const a = Math.max(0, f - 2), c = Math.min(nf, f + 3);
            let s = 0;
            for (let i = a; i < c; i++) s += rms[i];
            sm[f] = s / (c - a);
        }
        let peak = 0;
        for (const v of sm) if (v > peak) peak = v;
        return { sm, peak };
    }

    const f2ms = f => Math.floor(f * HOP / SR * 1000);

    // Hysteresis gate. Two thresholds, not one: a single threshold chatters on
    // and off through a decaying held note and shatters it into fragments.
    function voicedSegments(env, hi = 0.085, lo = 0.040, minVoice = 120, minGap = 300) {
        const { sm, peak } = env;
        const HI = hi * peak, LO = lo * peak;
        const segs = [];
        let on = false, st = 0;
        for (let f = 0; f < sm.length; f++) {
            if (!on && sm[f] >= HI) { on = true; st = f; }
            else if (on && sm[f] < LO) { on = false; segs.push([f2ms(st), f2ms(f)]); }
        }
        if (on) segs.push([f2ms(st), f2ms(sm.length)]);
        const merged = [];
        for (const [a, b] of segs) {
            if (merged.length && a - merged[merged.length - 1][1] < minGap) merged[merged.length - 1][1] = b;
            else merged.push([a, b]);
        }
        return merged.filter(([a, b]) => b - a >= minVoice);
    }

    // Rising edges in the vocal stem: the targets the word snap aims at.
    function onsetEdges(env, sdMult = 1.2, minGap = 90) {
        const { sm, peak } = env;
        const nf = sm.length;
        const dv = new Float32Array(nf);
        for (let f = 1; f < nf; f++) dv[f] = Math.max(0, sm[f] - sm[f - 1]);
        let mu = 0;
        for (const v of dv) mu += v;
        mu /= nf;
        let sd = 0;
        for (const v of dv) sd += (v - mu) ** 2;
        sd = Math.sqrt(sd / nf);
        const edges = [];
        let last = -1e9;
        for (let f = 2; f < nf - 2; f++) {
            if (dv[f] < mu + sdMult * sd) continue;
            if (dv[f] < dv[f - 1] || dv[f] < dv[f + 1]) continue;
            if (sm[f] < peak * 0.05) continue;
            const ms = f2ms(f);
            if (ms - last < minGap) continue;
            edges.push(ms);
            last = ms;
        }
        return edges;
    }

    // ---------- 3. melody: YIN pitch tracking + note segmentation ----------

    function pitchTrack(x22, env) {
        // 11025 Hz is plenty for a voice and makes YIN four times cheaper.
        const n = Math.floor(x22.length / 2);
        const x = new Float32Array(n);
        for (let i = 0; i < n; i++) x[i] = 0.5 * (x22[2 * i] + x22[2 * i + 1]);
        const sr = SR / 2, hop = 128, W = 256;
        const tauMin = Math.floor(sr / 1000), tauMax = Math.ceil(sr / 80);
        const nf = Math.floor((n - W - tauMax) / hop);
        const midi = new Float32Array(Math.max(0, nf));
        const conf = new Float32Array(Math.max(0, nf));
        const d = new Float32Array(tauMax + 2);
        const gate = env.peak * 0.04;
        for (let f = 0; f < nf; f++) {
            const o = f * hop;
            const ef = Math.min(env.sm.length - 1, Math.floor((o * 2 + W) / HOP));
            if (env.sm[ef] < gate) continue;
            for (let tau = 1; tau <= tauMax + 1; tau++) {
                let s = 0;
                for (let j = 0; j < W; j++) { const v = x[o + j] - x[o + j + tau]; s += v * v; }
                d[tau] = s;
            }
            // cumulative mean normalised difference
            let run = 0, best = -1;
            const cm = d;
            cm[0] = 1;
            for (let tau = 1; tau <= tauMax + 1; tau++) {
                run += d[tau];
                cm[tau] = run > 0 ? d[tau] * tau / run : 1;
            }
            for (let tau = tauMin; tau <= tauMax; tau++) {
                if (cm[tau] < 0.15) {
                    while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++;
                    best = tau;
                    break;
                }
            }
            if (best < 0) continue;
            const a = cm[best - 1], b = cm[best], c = cm[best + 1];
            const den = a - 2 * b + c;
            const t = best + (den !== 0 ? 0.5 * (a - c) / den : 0);
            const hz = sr / t;
            if (hz < 70 || hz > 1100) continue;
            midi[f] = 69 + 12 * Math.log2(hz / 440);
            conf[f] = 1 - b;
        }
        return { midi, conf, step: hop / sr };
    }

    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const noteName = m => NOTE_NAMES[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);

    function segmentNotes(p) {
        const { midi, step } = p;
        const n = midi.length;
        // median of 5 to kill octave blips
        const sm = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const w = [];
            for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && midi[j] > 0) w.push(midi[j]);
            if (midi[i] > 0 && w.length >= 3) { w.sort((a, b) => a - b); sm[i] = w[w.length >> 1]; }
        }
        const notes = [];
        let cur = null;
        const close = i => {
            if (cur && (i - cur.i0) * step >= 0.09) {
                const vals = cur.vals.sort((a, b) => a - b);
                const m = vals[vals.length >> 1];
                notes.push({ s: cur.i0 * step, e: i * step, midi: m, name: noteName(m) });
            }
            cur = null;
        };
        for (let i = 0; i < n; i++) {
            const v = sm[i];
            if (!v) { close(i); continue; }
            if (cur) {
                const ref = cur.vals.length > 4 ? [...cur.vals].sort((a, b) => a - b)[cur.vals.length >> 1] : cur.vals[cur.vals.length - 1];
                if (Math.abs(v - ref) > 0.7) close(i);
            }
            if (!cur) cur = { i0: i, vals: [] };
            cur.vals.push(v);
        }
        close(n);
        // join neighbours that are the same note
        const out = [];
        for (const nt of notes) {
            const last = out[out.length - 1];
            if (last && last.name === nt.name && nt.s - last.e < 0.04) last.e = nt.e;
            else out.push(nt);
        }
        return out;
    }

    // ---------- 4. Whisper ----------

    // Cut the vocal into windows at gaps in the singing. Thresholds here are
    // looser than the word guards use, so quiet lines still reach the model.
    function whisperWindows(env, x16) {
        const segs = voicedSegments(env, 0.04, 0.02, 150, 500);
        const wins = [];
        const pad = 0.3, maxLen = 28;
        let cur = null;
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i][0] / 1000, e = segs[i][1] / 1000;
            if (cur && e + pad - cur.t0 <= maxLen) { cur.t1 = e + pad; continue; }
            if (cur) wins.push(cur);
            cur = { t0: Math.max(0, s - pad), t1: e + pad };
        }
        if (cur) wins.push(cur);
        for (let i = 0; i + 1 < wins.length; i++) wins[i].t1 = Math.min(wins[i].t1, wins[i + 1].t0);
        return wins.filter(w => w.t1 - w.t0 > 0.4).map(w => ({
            t0: w.t0,
            audio: x16.slice(Math.floor(w.t0 * 16000), Math.min(x16.length, Math.ceil(w.t1 * 16000))),
        }));
    }

    async function transcribe(v22, env, hash, model, report) {
        const key = `asr:${hash}:${model}`;
        const cached = await cacheGet(key);
        if (cached) { report(1, 'Words already found (cached)'); return cached; }
        const x16 = await monoAt(v22, SR, 16000);
        const windows = whisperWindows(env, x16);
        const res = await runWorker('js/workers/transcribe.js', { model, windows, multilingual: !/\.en_/.test(model) },
            windows.map(w => w.audio.buffer), d => {
                if (d.type === 'status') report(null, d.text);
                if (d.type === 'download') report(d.total ? 0.2 * d.loaded / d.total : null, `Downloading speech model ${mb(d.loaded)} of ${mb(d.total)}`);
                if (d.type === 'progress') report(0.2 + 0.8 * d.value, 'Listening for words');
            });
        await cachePut(key, res.words);
        return res.words;
    }

    // ---------- 5. text: lyrics, alignment ----------

    const norm = w => w.toUpperCase().replace(/[’‘]/g, "'").replace(/[^A-Z0-9']/g, '');
    const displayWord = w => w.replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}'!?]+$/gu, '');

    function parseLyrics(text) {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^[\[(].*[\])]$/.test(l));
        const words = [];
        lines.forEach((ln, li) => {
            for (const raw of ln.split(/[\s—–]+|-(?=\S)/)) {
                const key = norm(raw);
                if (key) words.push({ key, text: displayWord(raw), line: li });
            }
        });
        return { lines, words };
    }

    // No official lyrics: lines come from Whisper itself. A new line starts at a
    // real rest, or where Whisper capitalised after a pause.
    function linesFromWhisper(wh) {
        const lines = [], words = [];
        let cur = [];
        const flush = () => { if (cur.length) { lines.push(cur.map(w => w.text).join(' ')); cur = []; } };
        wh.forEach((w, i) => {
            const prev = wh[i - 1];
            const gap = prev ? w.s - prev.e : 0;
            const cap = /^[A-Z]/.test(w.text) && !/^I('|$)/.test(w.text);
            if (prev && (gap >= 0.7 || (gap >= 0.25 && cap && cur.length >= 3) || /[.?!]$/.test(prev.text) || cur.length >= 12)) flush();
            const t = displayWord(w.text);
            if (!norm(w.text)) return;
            cur.push({ text: t });
            words.push({ key: norm(w.text), text: t, line: lines.length, cap, punct: /[.,?!;:]$/.test(w.text) });
        });
        flush();
        return { lines, words };
    }

    function align(user, whRaw, edges, vseg) {
        const wh = whRaw.map(w => ({ key: norm(w.text), s: Math.round(w.s * 1000), e: Math.round(w.e * 1000) })).filter(w => w.key);
        const A = user.length, B = wh.length;
        const stats = { words: A, whisperWords: B, anchored: 0, fromSlots: 0, spaced: 0, pushed: 0, moved: 0, capped: 0 };
        if (!A || !B) return { out: [], stats };

        // 1. edit-distance alignment; a shared 3-letter prefix is a near-miss
        const near = (a, b) => a === b || a.startsWith(b.slice(0, 3)) || b.startsWith(a.slice(0, 3));
        const W = B + 1;
        const dp = new Float32Array((A + 1) * W);
        const bp = new Uint8Array((A + 1) * W);          // 0 diag, 1 up, 2 left
        for (let i = 1; i <= A; i++) { dp[i * W] = i; bp[i * W] = 1; }
        for (let j = 1; j <= B; j++) { dp[j] = j; bp[j] = 2; }
        for (let i = 1; i <= A; i++) {
            const ua = user[i - 1].key;
            for (let j = 1; j <= B; j++) {
                const wb = wh[j - 1].key;
                const cost = ua === wb ? 0 : near(ua, wb) ? 0.4 : 1;
                let best = dp[(i - 1) * W + j - 1] + cost, mv = 0;
                if (dp[(i - 1) * W + j] + 1 < best) { best = dp[(i - 1) * W + j] + 1; mv = 1; }
                if (dp[i * W + j - 1] + 1 < best) { best = dp[i * W + j - 1] + 1; mv = 2; }
                dp[i * W + j] = best;
                bp[i * W + j] = mv;
            }
        }
        const pairs = new Map();
        for (let i = A, j = B; i > 0 && j > 0;) {
            const mv = bp[i * W + j];
            if (mv === 0) {
                if (near(user[i - 1].key, wh[j - 1].key)) pairs.set(i - 1, j - 1);
                i--; j--;
            } else if (mv === 1) i--;
            else j--;
        }
        // A line is sung in one breath-group: an anchor seconds away from the
        // rest of its line matched a stray word (an ad-lib, a mishearing).
        for (let changed = true; changed;) {
            changed = false;
            const keys = [...pairs.keys()].sort((a, b) => a - b);
            for (let q = 0; q + 1 < keys.length; q++) {
                const a = keys[q], b = keys[q + 1];
                if (user[a].line !== user[b].line) continue;
                // start to start: Whisper often stretches a stray word's end across the rest
                if (wh[pairs.get(b)].s - wh[pairs.get(a)].s <= 5000) continue;
                const aEdge = q === 0 || user[keys[q - 1]].line !== user[a].line;
                const bEdge = q + 2 >= keys.length || user[keys[q + 2]].line !== user[b].line;
                pairs.delete(aEdge || !bEdge ? a : b);
                changed = true;
                break;
            }
        }
        stats.anchored = pairs.size;

        // 2. fill the unanchored from Whisper's unmatched SLOTS where possible
        const times = new Array(A).fill(null);
        for (const [ui, wi] of pairs) times[ui] = [wh[wi].s, wh[wi].e];
        const slots = (lo, hi, n) => {
            const avail = [];
            for (let k = lo + 1; k < hi; k++) avail.push(k);
            if (!avail.length || n <= 0) return null;
            return Array.from({ length: n }, (_, k) => avail[Math.min(avail.length - 1, Math.round(k * avail.length / n))]);
        };
        const idx = [];
        for (let k = 0; k < A; k++) if (times[k]) idx.push(k);
        if (!idx.length) return { out: [], stats, error: 'No words matched. Are these the right lyrics for this song?' };
        const first = idx[0], last = idx[idx.length - 1];
        if (first > 0) {
            // Same reach limit as a line's opening words below: only borrow a
            // Whisper slot that sits just before the first anchor.
            const t1 = times[first][0];
            const sl = slots(-1, pairs.get(first), first);
            if (sl && sl.every((wi, k) => t1 - wh[wi].s <= 1500 * (first - k))) sl.forEach((wi, k) => { times[k] = [wh[wi].s, wh[wi].e]; stats.fromSlots++; });
            else { const s0 = Math.max(0, t1 - 260 * first); for (let k = 0; k < first; k++) times[k] = [s0 + 260 * k, s0 + 260 * (k + 1)]; }
        }
        // Between two anchors, the words that finish the earlier anchor's line
        // belong right after it and the words that open the later anchor's line
        // belong right before it. Spreading them evenly drags a missed line-opener
        // back across an instrumental gap, seconds early.
        for (let q = 0; q + 1 < idx.length; q++) {
            const a0 = idx[q], b0 = idx[q + 1];
            const run = b0 - a0 - 1;
            if (run <= 0) continue;
            let head = 0, tail = 0;
            while (head < run && user[a0 + 1 + head].line === user[a0].line) head++;
            while (tail < run - head && user[b0 - 1 - tail].line === user[b0].line) tail++;
            const mid = run - head - tail;
            const avail = [];
            for (let k = pairs.get(a0) + 1; k < pairs.get(b0); k++) avail.push(k);
            const t0 = times[a0][1], t1 = times[b0][0];
            const WORD = 250, REACH = 1500;
            // A slot only counts for a head/tail word if it sits next to its anchor.
            const headSlots = avail.slice(0, head).filter(wi => wh[wi].s - t0 <= REACH * (1 + avail.indexOf(wi)));
            const tailSlots = avail.slice(avail.length - tail).filter((wi, k, arr) => t1 - wh[wi].s <= REACH * (arr.length - k));
            const useSlots = avail.length >= run && headSlots.length === head && tailSlots.length === tail;
            if (useSlots) {
                for (let k = 0; k < head; k++) times[a0 + 1 + k] = [wh[avail[k]].s, wh[avail[k]].e];
                for (let k = 0; k < tail; k++) { const wi = avail[avail.length - tail + k]; times[b0 - tail + k] = [wh[wi].s, wh[wi].e]; }
            } else {
                for (let k = 0; k < head; k++) times[a0 + 1 + k] = [t0 + WORD * k, t0 + WORD * (k + 1)];
                for (let k = 0; k < tail; k++) { const s = t1 - WORD * (tail - k); times[b0 - tail + k] = [s, s + WORD]; }
            }
            if (mid) {
                const inner = useSlots ? avail.slice(head, avail.length - tail) : avail;
                if (inner.length >= mid) {
                    for (let k = 0; k < mid; k++) { const wi = inner[Math.min(inner.length - 1, Math.round(k * inner.length / mid))]; times[a0 + 1 + head + k] = [wh[wi].s, wh[wi].e]; }
                } else {
                    const m0 = t0 + WORD * head, m1 = t1 - WORD * tail;
                    const step = Math.max(120, (m1 - m0) / (mid + 1));
                    for (let k = 0; k < mid; k++) times[a0 + 1 + head + k] = [Math.round(m0 + step * k), Math.round(m0 + step * (k + 1))];
                }
            }
            stats.fromSlots += useSlots ? run : (mid && avail.length >= mid ? mid : 0);
        }
        const slEnd = slots(pairs.get(last), B, A - 1 - last);
        if (slEnd && slEnd.every((wi, k) => wh[wi].s - times[last][1] <= 1500 * (k + 1))) slEnd.forEach((wi, k) => { times[last + 1 + k] = [wh[wi].s, wh[wi].e]; stats.fromSlots++; });
        else for (let k = last + 1; k < A; k++) times[k] = [times[k - 1][1], times[k - 1][1] + 260];
        stats.spaced = A - idx.length - stats.fromSlots;

        // 3. monotonic snap onto real vocal onsets
        const WINDOW = 260, MINGAP = 70;
        const out = [];
        let prev = -1e9, ei = 0;
        for (let k = 0; k < A; k++) {
            const s0 = times[k][0];
            while (ei < edges.length && edges[ei] < s0 - WINDOW) ei++;
            let ns = null, bestD = Infinity;
            for (let j = ei; j < edges.length && edges[j] <= s0 + WINDOW; j++) {
                if (edges[j] < prev + MINGAP) continue;
                const d = Math.abs(edges[j] - s0);
                if (d < bestD) { bestD = d; ns = edges[j]; }
            }
            if (ns === null) ns = Math.max(s0, prev + MINGAP);
            out.push({ s: ns, e: times[k][1], text: user[k].text, key: user[k].key, line: user[k].line });
            prev = ns;
        }

        const segAt = ms => vseg.find(([x, y]) => x - 80 <= ms && ms <= y + 80) || null;
        const nextOnset = ms => { for (const [x] of vseg) if (x >= ms - 80) return x; return null; };
        const onsetNear = (ms, tol = 150) => vseg.some(([x]) => Math.abs(x - ms) <= tol);

        // 4. phrase-start guard: a line's first word can land on the previous
        // line's HELD NOTE. A real pickup begins at a voiced onset; a stolen
        // tail begins mid-segment.
        for (let k = 0; k < A - 1; k++) {
            if (k && out[k].line === out[k - 1].line) continue;
            if (onsetNear(out[k].s)) continue;
            const sg = segAt(out[k].s);
            if (!sg) continue;
            if (out[k + 1].s - sg[1] < 400) continue;
            const n = nextOnset(sg[1]);
            if (n === null || n >= out[k + 1].s - 70) continue;
            out[k].s = n;
            stats.pushed++;
        }

        // 5. silence guard: no start in dead air, no word lit across a rest
        for (let k = 0; k < A; k++) {
            if (segAt(out[k].s)) continue;
            const n = nextOnset(out[k].s);
            if (n === null) continue;
            const limit = k + 1 < A ? out[k + 1].s - 70 : n;
            const ns = Math.min(n, Math.max(out[k].s, limit));
            if (ns > out[k].s) { out[k].s = ns; stats.moved++; }
        }
        for (let k = 0; k < A - 1; k++) if (out[k].s >= out[k + 1].s) out[k + 1].s = out[k].s + 70;
        for (let k = 0; k < A; k++) {
            const nxt = k + 1 < A ? out[k + 1].s : out[k].e;
            let e = Math.max(out[k].s + 90, Math.min(nxt, out[k].e));
            const sg = segAt(out[k].s);
            if (sg && e > sg[1] + 200) { e = Math.max(out[k].s + 200, sg[1] + 200); stats.capped++; }
            out[k].e = e;
        }
        // de-overlap LAST: xLights rejects a timing track with overlapping marks
        for (let k = 0; k < A - 1; k++) if (out[k].e > out[k + 1].s) out[k].e = out[k + 1].s;
        for (let k = 0; k < A; k++) if (out[k].e <= out[k].s) out[k].e = out[k].s + 40;
        for (let k = 0; k < A - 1; k++) if (out[k].e > out[k + 1].s) out[k + 1].s = out[k].e;

        let near40 = 0, ej = 0;
        for (const w of out) {
            while (ej + 1 < edges.length && Math.abs(edges[ej + 1] - w.s) <= Math.abs(edges[ej] - w.s)) ej++;
            if (edges.length && Math.abs(edges[ej] - w.s) <= 40) near40++;
        }
        stats.onOnset = A ? near40 / A : 0;
        stats.inSilence = out.filter(w => !segAt(w.s)).length;
        return { out, stats, pairs };
    }

    // Line breaks for transcribed text, decided after alignment so they follow
    // the real pauses in the singing. A long run is split at its best break:
    // the longest pause, helped by a capital or punctuation from Whisper.
    function relineByTiming(words) {
        const n = words.length;
        const score = i => (words[i].s - words[i - 1].e) + (words[i].cap ? 250 : 0) + (words[i - 1].punct ? 300 : 0);
        const ranges = [];
        const split = (a, b) => {
            const dur = words[b - 1].e - words[a].s;
            let best = -1, bestScore = -Infinity;
            for (let i = a + 2; i <= b - 2; i++) {
                const sc = score(i);
                if (sc > bestScore) { bestScore = sc; best = i; }
            }
            const hardGap = best > 0 && words[best].s - words[best - 1].e >= 700;
            if (best < 0 || (!hardGap && b - a <= 8 && dur <= 4500)) { ranges.push([a, b]); return; }
            split(a, best);
            split(best, b);
        };
        // always break at a real rest first
        let start = 0;
        for (let i = 1; i <= n; i++) {
            if (i === n || words[i].s - words[i - 1].e >= 700) { if (i > start) split(start, i); start = i; }
        }
        ranges.sort((p, q) => p[0] - q[0]);
        const lines = ranges.map(([a, b], li) => {
            for (let i = a; i < b; i++) words[i].line = li;
            return words.slice(a, b).map(w => w.text).join(' ');
        });
        return lines;
    }

    function phrasesOf(lines, words) {
        const ph = [];
        lines.forEach((ln, li) => {
            const ws = words.filter(w => w.line === li);
            if (!ws.length) return;
            ph.push({ s: ws[0].s, e: Math.max(ws[ws.length - 1].e, ws[0].s + 300), text: ln });
        });
        for (let i = 0; i < ph.length; i++) {
            if (i && ph[i].s < ph[i - 1].e) ph[i].s = ph[i - 1].e;
            if (ph[i].e <= ph[i].s) ph[i].e = ph[i].s + 300;
        }
        return ph;
    }

    // ---------- 6. phonemes for singing faces ----------

    let dict = null;
    async function loadDict() {
        if (dict) return dict;
        const [std, usr, map] = await Promise.all(['dict/standard_dictionary', 'dict/user_dictionary', 'dict/phoneme_mapping']
            .map(u => fetch(u).then(r => r.ok ? r.text() : '')));
        const cmu = new Map();
        for (const src of [usr, std]) {
            for (const line of src.split('\n')) {
                if (!line || line.startsWith(';;;') || line.startsWith('#')) continue;
                const p = line.trim().split(/\s+/);
                if (p.length < 2 || p[0].endsWith(')')) continue;
                const k = p[0].toUpperCase();
                if (!cmu.has(k)) cmu.set(k, p.slice(1));
            }
        }
        const pb = new Map();
        for (const line of map.split('\n')) {
            const p = line.split('#')[0].trim().split(/\s+/);
            if (p.length === 2 && p[0] !== '.') pb.set(p[0], p[1]);
        }
        dict = { cmu, pb };
        return dict;
    }

    const ONES = ['ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN', 'ELEVEN', 'TWELVE',
        'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
    const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
    function under100(n) { return n < 20 ? [ONES[n]] : [TENS[Math.floor(n / 10)]].concat(n % 10 ? [ONES[n % 10]] : []); }
    function under1000(n) { return n < 100 ? under100(n) : [ONES[Math.floor(n / 100)], 'HUNDRED'].concat(n % 100 ? under100(n % 100) : []); }
    // Numbers are not in CMUdict; songs mostly sing years ("twenty seventeen").
    function numberWords(s) {
        const n = parseInt(s, 10);
        if (!(n >= 0) || n > 999999) return [];
        if (s.length === 4 && n >= 1100 && n < 2100 && !(n >= 2000 && n < 2010)) {
            const hi = Math.floor(n / 100), lo = n % 100;
            return under100(hi).concat(lo === 0 ? ['HUNDRED'] : lo < 10 ? ['O', ONES[lo]] : under100(lo));
        }
        if (n >= 1000) return under1000(Math.floor(n / 1000)).concat(['THOUSAND'], n % 1000 ? under1000(n % 1000) : []);
        return under1000(n);
    }

    // Last resort for words the dictionary lacks: one shape per letter group.
    function guessShapes(word) {
        const out = [];
        const w = word.toLowerCase().replace(/[^a-z]/g, '');
        for (let i = 0; i < w.length; i++) {
            const c = w[i];
            let v;
            if ('bmp'.includes(c)) v = 'MBP';
            else if ('fv'.includes(c)) v = 'FV';
            else if (c === 'l') v = 'L';
            else if ('wq'.includes(c)) v = 'WQ';
            else if (c === 'o') v = 'O';
            else if (c === 'u') v = 'U';
            else if ('ei'.includes(c)) v = c === 'i' ? 'AI' : 'E';
            else if (c === 'a') v = 'AI';
            else v = 'etc';
            if (out[out.length - 1] !== v) out.push(v);
        }
        return out.length ? out : ['AI'];
    }

    function shapesFor(key, d, missing) {
        const lookup = k => d.cmu.get(k) || d.cmu.get(k.replace(/'/g, '')) || null;
        let seq = lookup(key);
        if (!seq && /\d/.test(key)) {
            const parts = key.match(/\d+|[A-Z']+/g) || [];
            seq = [];
            for (const p of parts) {
                const sub = /\d/.test(p) ? numberWords(p) : [p];
                for (const w of sub) { const q = lookup(w); if (q) seq.push(...q); }
            }
            if (!seq.length) seq = null;
        }
        if (!seq) { missing.add(key); return guessShapes(key); }
        const shapes = [];
        for (const p of seq) {
            const v = d.pb.get(p) || d.pb.get(p.replace(/\d/g, '')) || 'etc';
            if (shapes[shapes.length - 1] !== v) shapes.push(v);
        }
        return shapes;
    }

    function phonemesOf(words, d) {
        const missing = new Set();
        const raw = [];
        for (const w of words) {
            let shapes = shapesFor(w.key, d, missing);
            const span = Math.max(1, w.e - w.s);
            // Keep every shape at least 40 ms (over one frame) and inside its
            // word: a fast word drops its in-between shapes rather than spilling.
            const n = Math.max(1, Math.min(shapes.length, Math.floor(span / 40)));
            if (n < shapes.length) shapes = Array.from({ length: n }, (_, i) => shapes[Math.floor(i * shapes.length / n)]);
            shapes.forEach((v, i) => {
                const x = w.s + Math.floor(span * i / shapes.length);
                const y = w.s + Math.floor(span * (i + 1) / shapes.length);
                raw.push([x, y, v]);
            });
        }
        raw.sort((a, b) => a[0] - b[0]);
        const cl = [];
        for (let [x, y, v] of raw) {
            if (cl.length && x < cl[cl.length - 1][1]) x = cl[cl.length - 1][1];
            if (y <= x) y = x + 30;
            cl.push([x, y, v]);
        }
        // a mark under one 25 ms frame is invalid: absorb it into the previous one
        const merged = [];
        for (const [x, y, v] of cl) {
            if (y - x < 40 && merged.length) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], y);
            else merged.push([x, y, v]);
        }
        for (let i = 0; i + 1 < merged.length; i++) if (merged[i][1] > merged[i + 1][0]) merged[i][1] = merged[i + 1][0];
        return {
            phonemes: merged.filter(m => m[1] > m[0]).map(([s, e, label]) => ({ s, e, label })),
            missing: [...missing],
        };
    }

    // ---------- orchestration ----------

    // Two Whisper sizes, two jobs. Measured on Dusty Bibles: "small" hears the
    // words far better but puts its word starts 0.2-1 s late; "base" mishears
    // more but its starts sit on the singing. So base is the clock, and small
    // only supplies text when the user has not pasted the lyrics.
    const CLOCK_MODEL = 'onnx-community/whisper-base.en_timestamped';
    const TEXT_MODEL = 'onnx-community/whisper-small.en_timestamped';

    // The expensive part: separation, stem analysis, transcription. Cached per song.
    async function analyze(buffer, hash, { needText }, report) {
        const stage = (from, to) => (p, text) => report(p == null ? null : from + (to - from) * p, text);
        const v22 = await separate(buffer, hash, stage(0, 0.4));
        report(0.41, 'Measuring the voice');
        await tick();
        const env = envelope(v22);
        const vseg = voicedSegments(env);
        const edges = onsetEdges(env);
        const pitch = pitchTrack(v22, env);
        const notes = segmentNotes(pitch);
        const whisper = await transcribe(v22, env, hash, CLOCK_MODEL, stage(0.45, needText ? 0.7 : 1));
        const v = { v22, env, vseg, edges, pitch, notes, whisper, whisperText: null, hash };
        if (needText) await addText(v, stage(0.7, 1));
        return v;
    }

    async function addText(v, report) {
        if (!v.whisperText) v.whisperText = await transcribe(v.v22, v.env, v.hash, TEXT_MODEL, report);
        return v;
    }

    // Cheap: re-run whenever the pasted lyrics change.
    async function build(v, lyricsText) {
        const fromUser = lyricsText && lyricsText.trim().length > 0;
        const src = fromUser ? parseLyrics(lyricsText) : linesFromWhisper(v.whisperText || v.whisper);
        const { out, stats, error } = align(src.words, v.whisper, v.edges, v.vseg);
        if (!fromUser) {
            out.forEach((w, i) => { w.cap = src.words[i].cap; w.punct = src.words[i].punct; });
            src.lines = relineByTiming(out);
        }
        const d = await loadDict();
        const ph = phonemesOf(out, d);
        return {
            source: fromUser ? 'lyrics' : 'whisper',
            lineTexts: src.lines,
            lines: phrasesOf(src.lines, out),
            words: out,
            phonemes: ph.phonemes,
            missing: ph.missing,
            stats, error,
        };
    }

    // After a hand edit of word times (ms): lines and mouth shapes follow the words.
    function relayout(lineTexts, words) {
        const ph = phonemesOf(words, dict);
        return { lines: phrasesOf(lineTexts, words), phonemes: ph.phonemes, missing: ph.missing };
    }

    async function heardText(v) {
        return (await build(v, '')).lines.map(l => l.text).join('\n');
    }

    return { analyze, addText, build, relayout, loadDict, heardText, SR, ENV_FPS, HOP, _debug: { envelope, voicedSegments, onsetEdges, align, parseLyrics, linesFromWhisper, numberWords } };
})();
