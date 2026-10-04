'use strict';

(() => {
    const $ = id => document.getElementById(id);

    const state = {
        fileName: '',
        ctx: null,
        buffer: null,
        model: null,
        grid: null,
        params: null,       // { bpm, offset, meter, barShift }
        view: { pxPerSec: 50, t0: 0 },
        play: { source: null, startCtx: 0, startPos: 0, playing: false, pos: 0, clickNext: 0, timer: 0 },
        taps: [],
        hash: '',
        voc: null,          // Vocals.analyze() result
        lyr: null,          // Vocals.build() result
        vocBuffer: null,    // the separated voice, for "voice only" playback
        vocBusy: false,
    };

    const TRACKS = [
        { id: 'beats', label: 'Beats', on: true, note: 'every beat, labelled 1-4' },
        { id: 'bars', label: 'Bars', on: true, note: 'one mark per bar, numbered' },
        { id: 'phrases', label: 'Phrases', on: false, note: '4-bar groups' },
        { id: 'sections', label: 'Sections', on: true, note: 'intro, verse, chorus…' },
        { id: 'energy', label: 'Energy', on: true, note: 'loudness level 1-5 per bar' },
        { id: 'kick', label: 'Kick', on: true, note: 'bass drum hits' },
        { id: 'snare', label: 'Snare', on: true, note: 'snare / clap hits' },
        { id: 'hat', label: 'Hi-hat', on: false, note: 'cymbal hits (dense)' },
        { id: 'all', label: 'Onsets', on: false, note: 'every note start' },
        { id: 'lyrics', label: 'Lyrics', on: true, note: 'lines, words and mouth shapes (for Faces)', vocal: true },
        { id: 'vocals', label: 'Vocals', on: true, note: 'when someone is singing', vocal: true },
        { id: 'notes', label: 'Vocal notes', on: false, note: 'the melody, one mark per sung note', vocal: true },
    ];

    // ---------- loading ----------

    // Songs are opened through the browser's file picker where it has one, so
    // the page gets a handle to the file it can keep (in IndexedDB, keyed by the
    // song's fingerprint) and reopen later without asking where it is.
    const drop = $('drop');
    const AUDIO_TYPES = [{ description: 'Songs', accept: { 'audio/*': ['.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac'] } }];

    async function pickSong() {
        if (window.showOpenFilePicker) {
            try {
                const [h] = await window.showOpenFilePicker({ id: 'xlweb-song', types: AUDIO_TYPES });
                await loadFile(await h.getFile(), h);
            } catch (err) { if (!err || err.name !== 'AbortError') setStatus('Could not open that song: ' + (err.message || err), true); }
            return;
        }
        $('file').click();
    }
    $('pick').addEventListener('click', pickSong);
    $('file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    document.addEventListener('dragover', e => e.preventDefault());
    // one handler for the whole page (the drop zone is inside it)
    document.addEventListener('drop', e => {
        e.preventDefault();
        const item = e.dataTransfer.items && e.dataTransfer.items[0];
        const file = e.dataTransfer.files[0];
        if (!file) return;
        // the handle has to be asked for during the drop event itself
        const hp = item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
        hp.then(h => loadFile(file, h && h.kind === 'file' ? h : null));
    });

    function setStatus(msg, isError) {
        const el = $('status');
        el.textContent = msg;
        el.classList.toggle('error', !!isError);
    }

    async function loadFile(file, handle) {
        if (/\.json$/i.test(file.name)) { if (await confirmLeave()) await openProjectFile(file, handle); return; }
        // a different song (not the one a project being opened is waiting for) replaces the work
        if (!pendingProject && state.buffer && !(await confirmLeave())) return;
        if (!pendingProject) state.projectHandle = null;
        stop();
        state.fileName = file.name.replace(/\.[^.]+$/, '');
        state.fileFull = file.name;
        state.fileSize = file.size;
        state.fileHandle = handle || null;
        await loadArrayBuffer(await file.arrayBuffer());
    }

    // ---------- finding a song again ----------

    const songKey = hash => 'song:' + hash;

    async function rememberSongHandle() {
        if (state.fileHandle && state.hash) await Show.kvPut(songKey(state.hash), state.fileHandle);
    }

    // Ask the browser for read access. Without a recent click this can only
    // check, not ask; the caller then offers a button.
    async function canRead(handle, mayAsk) {
        try {
            if (!handle.queryPermission) return true;    // e.g. the browser's private storage
            if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
            if (!mayAsk) return false;
            return (await handle.requestPermission({ mode: 'read' })) === 'granted';
        } catch (e) { return false; }
    }

    // Look for a file by name in a folder and its subfolders (two levels).
    async function findInFolder(dir, name, depth = 2) {
        try {
            for await (const [n, h] of dir.entries()) {
                if (h.kind === 'file' && n.toLowerCase() === name.toLowerCase()) return h;
            }
            if (depth > 0) {
                for await (const [n, h] of dir.entries()) {
                    if (h.kind === 'directory' && !/^backup/i.test(n)) {
                        const hit = await findInFolder(h, name, depth - 1);
                        if (hit) return hit;
                    }
                }
            }
        } catch (e) { /* unreadable folder */ }
        return null;
    }

    // Find the project's song without asking where it is: the handle saved
    // when it was opened, else the music folder, else the show folder.
    // Returns { handle, how } when it can be read now, { handle, needsClick }
    // when the browser knows the file but wants a click to allow reading it
    // again (once per visit, unless "Allow on every visit" was chosen), or null.
    async function findProjectSong(p, mayAsk) {
        const want = p.song || {};
        let waiting = null;
        const saved = want.hash && await Show.kvGet(songKey(want.hash));
        if (saved) {
            if (await canRead(saved, mayAsk)) return { handle: saved, how: 'remembered' };
            waiting = { handle: saved, needsClick: true };
        }
        if (!want.file) return waiting;
        for (const [key, label] of [['musicFolder', 'your music folder'], ['projectsFolder', 'your projects folder'], ['folder', 'your show folder']]) {
            const dir = await Show.kvGet(key);
            if (!dir) continue;
            if (!(await canRead(dir, mayAsk))) { if (!waiting) waiting = { dir, label, needsClick: true }; continue; }
            const h = await findInFolder(dir, want.file);
            if (h) {
                const f = await h.getFile();
                if (!want.size || f.size === want.size) return { handle: h, how: label };
            }
        }
        return waiting;
    }

    async function pickMusicFolder() {
        if (!window.showDirectoryPicker) return null;
        try {
            const dir = await window.showDirectoryPicker({ id: 'xlweb-music', mode: 'read' });
            await Show.kvPut('musicFolder', dir);
            return dir;
        } catch (e) { return null; }
    }

    async function loadArrayBuffer(ab) {
        try {
            setStatus('Decoding…');
            state.hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', ab)), b => b.toString(16).padStart(2, '0')).join('');
            await rememberSongHandle();
            state.voc = state.lyr = state.lyrRaw = state.lyrWordsMs = state.vocBuffer = null;
            state.wordEdits = new Map();
            state.editUndo = [];
            state.ctx = state.ctx || new AudioContext();
            state.buffer = await state.ctx.decodeAudioData(ab);
            const t0 = performance.now();
            state.model = await Analysis.analyze(state.buffer, (p, what) => setStatus(`${what}… ${Math.round(p * 100)}%`));
            const tm = state.model.tempo;
            state.params = { bpm: tm.bpm, offset: tm.offset, meter: 4, barShift: null };
            const savedParams = loadParams();
            if (savedParams) state.params = savedParams;
            loadUserSections();
            rebuild();
            state.params.barShift = state.grid.barShift;
            setStatus(`Analysed in ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
            showResults();
            state.projectHandle = null;
            state.projectDirty = false;
            setProjStatus('');
            if (pendingProject) {
                const p = pendingProject;
                pendingProject = null;
                await applyProject(p);
                const same = !p.song || !p.song.hash || p.song.hash === state.hash;
                banner(same ? `Opened the project for <b>${esc(state.fileFull)}</b>.`
                    : `Opened the project, but <b>${esc(state.fileFull)}</b> is not exactly the file it was made with (${esc(p.song.file)}), so times may be off.`,
                [['OK', () => banner(null)]], same ? 'ok' : 'error');
            }
        } catch (err) {
            console.error(err);
            setStatus('Could not read that file: ' + (err.message || err), true);
            if (pendingProject) banner(`Could not read the song: ${esc(err.message || String(err))}`, [['Choose another…', pickSong, true], ['Cancel', () => { pendingProject = null; banner(null); }]], 'error');
        }
    }

    function showResults() {
        $('results').hidden = false;
        drop.classList.add('compact');
        $('songName').textContent = state.fileName;
        $('songMeta').textContent = `${fmtTime(state.buffer.duration, false)} · ${state.buffer.sampleRate} Hz · ${state.buffer.numberOfChannels === 2 ? 'stereo' : state.buffer.numberOfChannels + ' ch'}`;
        state.play.pos = 0;
        fitView();
        syncControls();
        renderTracks();
        resetVocalPanel();
        draw();
    }

    function rebuild() {
        state.grid = Analysis.buildGrid(state.model, state.params);
        // Detected sections get stable ids by position; once the user edits
        // sections, their own list replaces detection for good.
        state.grid.sections.forEach((s, i) => { s.id = 'd' + i; });
        state.detectedSections = state.grid.sections;
        if (state.userSections) state.grid.sections = state.userSections;
        if (state.params.barShift == null) state.params.barShift = state.grid.barShift;
        saveParams();
        renderStats();
        renderSections();
        draw();
        document.dispatchEvent(new CustomEvent('xl:song'));
        document.dispatchEvent(new CustomEvent('xl:changed'));
    }

    // ---------- the user's own sections ----------

    const sectionsKey = () => 'xlweb-sections:' + state.hash;
    const paramsKey = () => 'xlweb-grid:' + state.hash;

    // Tempo-grid corrections are kept per song too.
    function loadParams() {
        try {
            const p = JSON.parse(localStorage.getItem(paramsKey()) || 'null');
            if (p && p.bpm > 0) return p;
        } catch (e) { /* none */ }
        return null;
    }
    function saveParams() {
        try { localStorage.setItem(paramsKey(), JSON.stringify(state.params)); } catch (e) { /* storage blocked */ }
    }

    function loadUserSections() {
        state.userSections = null;
        try {
            const v = JSON.parse(localStorage.getItem(sectionsKey()) || 'null');
            if (Array.isArray(v) && v.length) state.userSections = v;
        } catch (e) { /* none */ }
    }

    function saveUserSections() {
        try {
            if (state.userSections) localStorage.setItem(sectionsKey(), JSON.stringify(state.userSections));
            else localStorage.removeItem(sectionsKey());
        } catch (e) { /* storage blocked */ }
    }

    function ownSections() {
        if (!state.userSections) {
            state.userSections = state.grid.sections.map(s => ({ id: s.id, s: s.s, e: s.e, name: s.name, letter: s.letter, energy: s.energy, bars: s.bars }));
            state.grid.sections = state.userSections;
        }
        return state.userSections;
    }

    const newSectionId = () => 'u' + Math.random().toString(36).slice(2, 8);

    function barsIn(s, e) { return state.grid.bars.filter(b => b.s >= s - 0.01 && b.s < e - 0.01).length; }

    // Nearest beat, so sections start where the music does.
    function snapToBeat(t) {
        let best = t, bd = Infinity;
        for (const b of state.grid.beats) { const d = Math.abs(b.s - t); if (d < bd) { bd = d; best = b.s; } }
        return best;
    }

    function sectionsChanged(detail) {
        saveUserSections();
        renderStats();
        renderSections();
        draw();
        document.dispatchEvent(new CustomEvent('xl:sections', { detail }));
        document.dispatchEvent(new CustomEvent('xl:song'));
        document.dispatchEvent(new CustomEvent('xl:changed'));
    }

    function splitSection(id, t, free) {
        const list = ownSections();
        const i = list.findIndex(s => s.id === id);
        if (i < 0) return null;
        const s = list[i];
        const at = free ? t : snapToBeat(t);
        if (at <= s.s + 0.2 || at >= s.e - 0.2) return null;
        const right = { ...s, id: newSectionId(), s: at, name: nextName(s.name), bars: barsIn(at, s.e) };
        s.e = at;
        s.bars = barsIn(s.s, at);
        list.splice(i + 1, 0, right);
        sectionsChanged({ op: 'split', from: id, to: right.id });
        return right;
    }

    // "Chorus 1" -> "Chorus 1 b", "Chorus 1 b" -> "Chorus 1 c"
    function nextName(name) {
        const m = name.match(/^(.*\S)\s+([a-y])$/);
        return m ? `${m[1]} ${String.fromCharCode(m[2].charCodeAt(0) + 1)}` : `${name} b`;
    }

    function mergeWithNext(id) {
        const list = ownSections();
        const i = list.findIndex(s => s.id === id);
        if (i < 0 || i + 1 >= list.length) return;
        const gone = list[i + 1];
        list[i].e = gone.e;
        list[i].bars = barsIn(list[i].s, list[i].e);
        list.splice(i + 1, 1);
        sectionsChanged({ op: 'merge', into: id, removed: gone.id });
    }

    function renameSection(id, name) {
        const s = ownSections().find(x => x.id === id);
        if (!s) return;
        s.name = name.trim() || s.name;
        sectionsChanged({ op: 'rename', id });
    }

    // Move the boundary between section i-1 and i.
    function moveBoundary(i, t, free) {
        const list = ownSections();
        const a = list[i - 1], b = list[i];
        if (!a || !b) return;
        let at = free ? t : snapToBeat(t);
        at = Math.max(a.s + 0.25, Math.min(b.e - 0.25, at));
        a.e = b.s = at;
        a.bars = barsIn(a.s, a.e);
        b.bars = barsIn(b.s, b.e);
    }

    function resetSections() {
        state.userSections = null;
        state.grid.sections = state.detectedSections;
        sectionsChanged({ op: 'reset' });
    }

    function sectionAtTime(t) {
        return state.grid.sections.find(s => t >= s.s && t < s.e) || null;
    }

    // ---------- panels ----------

    function renderStats() {
        const g = state.grid, m = state.model, tm = m.tempo;
        const kicks = m.onsets.kick.length, snares = m.onsets.snare.length;
        const items = [
            ['Tempo', `${g.bpm.toFixed(2)} BPM`, g.bpm !== tm.bpm ? `detected ${tm.bpm.toFixed(2)}` : (tm.octaveFrom ? `detected (${tm.octave} from ${tm.octaveFrom.toFixed(0)})` : 'detected')],
            ['Beats', g.beats.length, `${g.meter}/4 time, ${g.bars.length} bars`],
            ['Sections', g.sections.length, g.sections.filter(s => /^Chorus/.test(s.name)).length + ' chorus'],
            ['Drum hits', kicks + snares, `${kicks} kick · ${snares} snare`],
            ['Music', `${fmtTime(m.songStart)} – ${fmtTime(m.songEnd)}`, 'first to last sound'],
        ];
        $('stats').innerHTML = items.map(([k, v, s]) =>
            `<div class="stat"><div class="k">${k}</div><div class="v">${esc(String(v))}</div><div class="s">${esc(s)}</div></div>`).join('');

        const f = g.fit, el = $('gridFit');
        if (!f) { el.textContent = ''; el.className = 'fit'; return; }
        const good = f.meanMs < 20 && f.within40 > 0.85 && Math.abs(f.driftMs) < 25;
        const ok = f.meanMs < 35 && f.within40 > 0.65;
        let msg = `${f.source === 'kick' ? 'Kick hits' : 'Onsets'} land ${f.meanMs.toFixed(1)} ms from the grid on average, ${Math.round(f.within40 * 100)}% within 40 ms.`;
        if (Math.abs(f.driftMs) >= 25) msg += ` The grid drifts ${f.driftMs > 0 ? 'early' : 'late'} by about ${Math.abs(f.driftMs).toFixed(0)} ms over the song, so try nudging BPM by ±0.05.`;
        else if (!ok) msg += ' That is a loose fit. The tempo may vary (live recording?) or be a multiple of the real one.';
        el.textContent = msg;
        el.className = 'fit ' + (good ? 'good' : ok ? 'ok' : 'bad');
    }

    function renderSections() {
        const tb = $('sectionRows');
        tb.innerHTML = '';
        const list = state.grid.sections;
        list.forEach((s, i) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td class="num"><button type="button" class="link seek">${fmtTime(s.s)}</button></td>
                <td class="num">${s.bars} bars</td>
                <td><span class="swatch" style="background:${sectionColor(s.letter || 'A')}"></span><input type="text" value="${esc(s.name)}" aria-label="Section name"></td>
                <td><span class="meter"><span style="width:${Math.round((s.energy ?? 0.5) * 100)}%"></span></span></td>
                <td class="sec-actions"><button type="button" class="btn tiny split" title="Split this section at the playhead">Split</button>${i + 1 < list.length ? '<button type="button" class="btn tiny merge" title="Join with the next section">Join ↓</button>' : ''}</td>`;
            tr.querySelector('.seek').addEventListener('click', () => seek(s.s, true));
            const inp = tr.querySelector('input');
            inp.addEventListener('input', e => { s.name = e.target.value; draw(); });
            inp.addEventListener('change', e => renameSection(s.id, e.target.value));
            tr.querySelector('.split').addEventListener('click', () => {
                const t = currentTime();
                const target = t > s.s + 0.2 && t < s.e - 0.2 ? t : (s.s + s.e) / 2;
                const right = splitSection(s.id, target);
                if (!right) { setSectionNote(`That spot is too close to the edge of "${s.name}".`); return; }
                setSectionNote(`Split "${s.name}" at ${fmtTime(right.s, true)}${target === t ? ' (the playhead)' : ' (its middle, because the playhead was not inside it)'}. Rename the new part below.`);
                const row = [...$('sectionRows').querySelectorAll('input[type=text]')][list.indexOf(right)];
                if (row) { row.focus(); row.select(); }
            });
            const mg = tr.querySelector('.merge');
            if (mg) mg.addEventListener('click', () => { mergeWithNext(s.id); setSectionNote('Joined. Undo with Split if needed.'); });
            tb.appendChild(tr);
        });
        $('sectionsOwned').hidden = !state.userSections;
    }

    function setSectionNote(msg) { $('sectionNote').textContent = msg; }

    $('splitAtPlayhead').addEventListener('click', () => {
        const t = currentTime(), s = sectionAtTime(t);
        if (!s) return;
        const right = splitSection(s.id, t);
        setSectionNote(right ? `Split "${s.name}" at ${fmtTime(right.s, true)}. Rename the new part in the table.` : 'Move the playhead inside a section, away from its edges, then split.');
    });
    $('resetSections').addEventListener('click', () => {
        if (!confirm('Go back to the detected sections? Your own splits and names are removed, and lights planned for sections that no longer exist are dropped.')) return;
        resetSections();
        setSectionNote('Back to the detected sections.');
    });

    function renderTracks() {
        $('trackChoices').innerHTML = TRACKS.map(t => {
            const off = t.vocal && !state.lyr;
            return `<label class="track${off ? ' off' : ''}"><input type="checkbox" data-id="${t.id}" ${t.on && !off ? 'checked' : ''} ${off ? 'disabled' : ''}> <b>${t.label}</b> <span>${off ? 'after Find words' : t.note}</span></label>`;
        }).join('');
        $('trackChoices').querySelectorAll('input').forEach(cb =>
            cb.addEventListener('change', () => { TRACKS.find(t => t.id === cb.dataset.id).on = cb.checked; }));
    }

    function syncControls() {
        const p = state.params;
        $('bpm').value = p.bpm.toFixed(2);
        $('offset').value = p.offset.toFixed(3);
        $('meter').value = String(p.meter);
        const db = $('downbeat');
        db.innerHTML = '';
        for (let i = 0; i < p.meter; i++) db.add(new Option(String(i + 1), String(i)));
        db.value = String(state.grid.barShift);
    }

    function setBpm(bpm, refit = true) {
        if (!(bpm >= 30 && bpm <= 300)) return;
        state.params.bpm = Math.round(bpm * 1000) / 1000;
        if (refit) state.params.offset = Analysis.refitOffset(state.model, state.params.bpm);
        state.params.barShift = null;
        rebuild();
        state.params.barShift = state.grid.barShift;
        syncControls();
    }

    $('bpm').addEventListener('change', e => setBpm(parseFloat(e.target.value)));
    $('offset').addEventListener('change', e => {
        const v = parseFloat(e.target.value);
        if (v >= 0) { state.params.offset = v; rebuild(); syncControls(); }
    });
    $('meter').addEventListener('change', e => {
        state.params.meter = parseInt(e.target.value, 10);
        state.params.barShift = null;
        rebuild();
        state.params.barShift = state.grid.barShift;
        syncControls();
    });
    $('downbeat').addEventListener('change', e => {
        state.params.barShift = parseInt(e.target.value, 10);
        rebuild();
    });
    $('half').addEventListener('click', () => setBpm(state.params.bpm / 2, false));
    $('double').addEventListener('click', () => setBpm(state.params.bpm * 2, false));
    $('reset').addEventListener('click', () => {
        const tm = state.model.tempo;
        state.params = { bpm: tm.bpm, offset: tm.offset, meter: 4, barShift: null };
        rebuild();
        state.params.barShift = state.grid.barShift;
        syncControls();
    });
    $('tapBtn').addEventListener('click', () => {
        const now = performance.now();
        state.taps = state.taps.filter(t => now - t < 3000);
        state.taps.push(now);
        if (state.taps.length >= 4) {
            const iv = (state.taps[state.taps.length - 1] - state.taps[0]) / (state.taps.length - 1);
            setBpm(60000 / iv);
            $('tapBtn').textContent = `Tap (${state.params.bpm.toFixed(1)})`;
        } else {
            $('tapBtn').textContent = `Tap… ${state.taps.length}`;
        }
    });

    // ---------- playback ----------

    function currentTime() {
        const p = state.play;
        // the song moves at the playback rate (½× plays the audio at half speed)
        return p.playing ? p.startPos + (state.ctx.currentTime - p.startCtx) * (p.rate || 1) : p.pos;
    }

    function play() {
        if (!state.buffer) return;
        state.ctx.resume();
        const p = state.play;
        if (p.pos >= state.buffer.duration - 0.05) p.pos = 0;
        const src = state.ctx.createBufferSource();
        src.buffer = $('voiceOnly').checked && state.vocBuffer ? state.vocBuffer : state.buffer;
        src.playbackRate.value = p.rate || 1;
        src.connect(state.ctx.destination);
        p.startCtx = state.ctx.currentTime + 0.03;
        p.startPos = p.pos;
        src.start(p.startCtx, p.pos);
        src.onended = () => { if (p.source === src) { p.pos = currentTime(); p.playing = false; p.source = null; $('play').textContent = 'Play'; } };
        p.source = src;
        p.playing = true;
        p.clickNext = 0;
        $('play').textContent = 'Pause';
        p.timer = setInterval(scheduleClicks, 25);
        requestAnimationFrame(frame);
    }

    function stop() {
        const p = state.play;
        if (p.source) {
            p.pos = currentTime();
            const s = p.source;
            p.source = null;
            try { s.stop(); } catch (e) { /* already stopped */ }
        }
        p.playing = false;
        clearInterval(p.timer);
        $('play').textContent = 'Play';
    }

    function seek(t, keepPlaying) {
        const was = state.play.playing;
        stop();
        state.play.pos = Math.max(0, Math.min(state.buffer.duration, t));
        if (was && keepPlaying !== false) play();
        ensureVisible(state.play.pos);
        draw();
    }

    function scheduleClicks() {
        const p = state.play;
        if (!p.playing || !$('click').checked) return;
        const now = currentTime();
        const horizon = now + 0.12;
        const beats = state.grid.beats;
        if (!p.clickNext || p.clickNext >= beats.length || beats[Math.max(0, p.clickNext - 1)].s > now + 0.2) {
            p.clickNext = beats.findIndex(b => b.s >= now - 0.01);
            if (p.clickNext < 0) return;
        }
        while (p.clickNext < beats.length && beats[p.clickNext].s < horizon) {
            const b = beats[p.clickNext++];
            if (b.s < now - 0.01) continue;
            const when = p.startCtx + (b.s - p.startPos) / (p.rate || 1);
            const osc = state.ctx.createOscillator(), g = state.ctx.createGain();
            osc.frequency.value = b.n === 1 ? 1760 : 1100;
            g.gain.setValueAtTime(0.0001, when);
            g.gain.exponentialRampToValueAtTime(b.n === 1 ? 0.5 : 0.3, when + 0.002);
            g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
            osc.connect(g).connect(state.ctx.destination);
            osc.start(when);
            osc.stop(when + 0.06);
        }
    }

    function frame() {
        if (!state.play.playing) { draw(); return; }
        const t = currentTime();
        if ($('follow').checked) {
            const w = plotWidth() / state.view.pxPerSec;
            if (t < state.view.t0 || t > state.view.t0 + w * 0.9) state.view.t0 = clampT0(t - w * 0.1);
        }
        draw();
        requestAnimationFrame(frame);
    }

    $('play').addEventListener('click', () => state.play.playing ? stop() : play());
    // back to the beginning; keeps playing if it was playing
    function toStart() {
        if (!state.buffer) return;
        seek(0, true);
        state.view.t0 = 0;
        draw();
    }
    $('toStart').addEventListener('click', toStart);
    document.addEventListener('keydown', e => {
        if (!state.buffer || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
        if (e.key === 'Home') { e.preventDefault(); toStart(); return; }
        const songTab = !document.querySelector('[data-pane=song]').hidden;
        if (e.code === 'Space' && e.target.tagName !== 'BUTTON') {
            e.preventDefault();
            state.play.playing ? stop() : play();
        } else if (!songTab) {
            return;   // the sequence tab has its own keys
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && state.lyr) {
            if (undoWordEdit()) e.preventDefault();
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.lyr && state.lyr.selected != null) {
            const step = (e.shiftKey ? 50 : 10) * (e.key === 'ArrowLeft' ? -1 : 1);
            if (nudgeSelected(step)) e.preventDefault();
        } else if (e.key === 'Escape' && state.lyr) {
            state.lyr.selected = null;
            draw();
        }
    });

    // ---------- timeline ----------

    const LABEL_W = 78;
    const BASE_LANES = [
        { id: 'overview', h: 30, label: '' },
        { id: 'ruler', h: 20, label: '' },
        { id: 'sections', h: 26, label: 'Sections' },
        { id: 'wave', h: 110, label: 'Waveform' },
        { id: 'energy', h: 16, label: 'Energy' },
        { id: 'bars', h: 20, label: 'Bars' },
        { id: 'beats', h: 24, label: 'Beats' },
        { id: 'kick', h: 18, label: 'Kick' },
        { id: 'snare', h: 18, label: 'Snare' },
        { id: 'hat', h: 18, label: 'Hi-hat' },
    ];
    const VOCAL_LANES = [
        { id: 'voice', h: 44, label: 'Voice' },
        { id: 'lines', h: 24, label: 'Lyrics' },
        { id: 'words', h: 22, label: 'Words' },
        { id: 'mouth', h: 20, label: 'Mouth' },
        { id: 'notes', h: 56, label: 'Melody' },
    ];
    let LANES = BASE_LANES, totalH = 0;
    function layoutLanes() {
        LANES = state.lyr ? BASE_LANES.concat(VOCAL_LANES) : BASE_LANES;
        totalH = LANES.reduce((a, l) => a + l.h + 1, 0);
    }
    layoutLanes();
    const canvas = $('tl'), tl = $('timeline');

    function plotWidth() { return Math.max(100, tl.clientWidth - LABEL_W); }
    function clampT0(t0) {
        const w = plotWidth() / state.view.pxPerSec;
        return Math.max(0, Math.min(t0, Math.max(0, state.buffer.duration - w)));
    }
    function minPps() { return plotWidth() / state.buffer.duration; }
    function fitView() { state.view.pxPerSec = minPps(); state.view.t0 = 0; $('zoom').value = 0; }
    function ppsFromSlider(v) { const lo = Math.log(minPps()), hi = Math.log(800); return Math.exp(lo + (hi - lo) * v / 100); }
    function sliderFromPps(pps) { const lo = Math.log(minPps()), hi = Math.log(800); return Math.round(100 * (Math.log(pps) - lo) / (hi - lo)); }

    function setZoom(pps, anchorT) {
        const v = state.view;
        const ax = (anchorT - v.t0) * v.pxPerSec;
        v.pxPerSec = Math.max(minPps(), Math.min(800, pps));
        v.t0 = clampT0(anchorT - ax / v.pxPerSec);
        $('zoom').value = sliderFromPps(v.pxPerSec);
        draw();
    }

    function ensureVisible(t) {
        const v = state.view, w = plotWidth() / v.pxPerSec;
        if (t < v.t0 || t > v.t0 + w) v.t0 = clampT0(t - w * 0.25);
    }

    $('zoom').addEventListener('input', e => {
        if (!state.buffer) return;
        const v = state.view, center = v.t0 + plotWidth() / v.pxPerSec / 2;
        setZoom(ppsFromSlider(+e.target.value), center);
    });

    tl.addEventListener('wheel', e => {
        if (!state.buffer) return;
        e.preventDefault();
        const v = state.view;
        const x = e.offsetX - LABEL_W;
        if (e.ctrlKey || e.metaKey) {
            setZoom(v.pxPerSec * Math.exp(-e.deltaY * 0.002), v.t0 + Math.max(0, x) / v.pxPerSec);
        } else {
            const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            v.t0 = clampT0(v.t0 + d / v.pxPerSec);
            draw();
        }
    }, { passive: false });

    let dragOverview = false;
    function overviewSeek(x) {
        const t = (x - LABEL_W) / plotWidth() * state.buffer.duration;
        const w = plotWidth() / state.view.pxPerSec;
        state.view.t0 = clampT0(t - w / 2);
        draw();
    }
    tl.addEventListener('mousedown', e => {
        if (!state.buffer || e.offsetX < LABEL_W) return;
        if (e.offsetY < LANES[0].h) { dragOverview = true; overviewSeek(e.offsetX); return; }
        const lane = laneAt(e.offsetY);
        const bi = lane && lane.id === 'sections' ? boundaryAt(e.offsetX) : -1;
        if (bi > 0) {
            e.preventDefault();
            sectionDrag = { i: bi };
            return;
        }
        const hit = lane && hitWord(e.offsetX, lane.id);
        if (hit) {
            e.preventDefault();
            startWordDrag(hit);
            draw();
            return;
        }
        if (state.lyr) state.lyr.selected = null;
        seek(state.view.t0 + (e.offsetX - LABEL_W) / state.view.pxPerSec);
    });
    // index of the section whose START is under x (boundary with the one before), or -1
    let sectionDrag = null;
    function boundaryAt(xPx) {
        const t = state.view.t0 + (xPx - LABEL_W) / state.view.pxPerSec;
        const tol = 5 / state.view.pxPerSec;
        const list = state.grid.sections;
        for (let i = 1; i < list.length; i++) if (Math.abs(list[i].s - t) <= tol) return i;
        return -1;
    }

    window.addEventListener('mousemove', e => {
        const r = tl.getBoundingClientRect();
        if (dragOverview) { overviewSeek(e.clientX - r.left); return; }
        if (wordDrag) { moveWordDrag(e.clientX - r.left, e.altKey); return; }
        if (sectionDrag) {
            moveBoundary(sectionDrag.i, state.view.t0 + (e.clientX - r.left - LABEL_W) / state.view.pxPerSec, e.altKey);
            sectionDrag.moved = true;
            draw();
        }
    });
    tl.addEventListener('mousemove', e => {
        if (wordDrag || dragOverview || sectionDrag) return;
        const lane = laneAt(e.offsetY);
        if (lane && lane.id === 'sections' && e.offsetX >= LABEL_W) { tl.style.cursor = boundaryAt(e.offsetX) > 0 ? 'ew-resize' : ''; return; }
        if (!state.lyr) { tl.style.cursor = ''; return; }
        const hit = lane && e.offsetX >= LABEL_W && hitWord(e.offsetX, lane.id);
        tl.style.cursor = !hit ? '' : hit.kind === 'start' ? 'ew-resize' : 'grab';
    });
    window.addEventListener('mouseup', () => {
        dragOverview = false;
        if (wordDrag) endWordDrag();
        if (sectionDrag) {
            const d = sectionDrag;
            sectionDrag = null;
            if (d.moved) { sectionsChanged({ op: 'move' }); setSectionNote('Moved the boundary. It snaps to beats; hold Alt to place it freely.'); }
        }
    });
    new ResizeObserver(() => {
        if (!state.buffer) return;
        if (state.view.pxPerSec < minPps()) state.view.pxPerSec = minPps();
        state.view.t0 = clampT0(state.view.t0);
        draw();
    }).observe(tl);

    function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

    const SECTION_HUES = [210, 340, 150, 40, 270, 190, 10, 90, 300, 120];
    function sectionColor(letter, alpha = 1) {
        const h = SECTION_HUES[(letter.charCodeAt(0) - 65) % SECTION_HUES.length];
        return `hsla(${h}, 65%, 55%, ${alpha})`;
    }

    function draw() {
        if (!state.buffer || !state.grid) return;
        const dpr = window.devicePixelRatio || 1;
        const W = tl.clientWidth;
        if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(totalH * dpr)) {
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(totalH * dpr);
            canvas.style.width = W + 'px';
            canvas.style.height = totalH + 'px';
        }
        const c = canvas.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        const col = {
            bg: css('--surface'), lane: css('--lane'), grid: css('--line'), text: css('--muted'),
            fg: css('--text'), wave: css('--wave'), accent: css('--accent'), play: css('--playhead'),
        };
        c.fillStyle = col.bg;
        c.fillRect(0, 0, W, totalH);

        const v = state.view, pw = plotWidth(), dur = state.buffer.duration;
        const t1 = v.t0 + pw / v.pxPerSec;
        const X = t => LABEL_W + (t - v.t0) * v.pxPerSec;
        const g = state.grid, m = state.model;
        c.font = '11px system-ui, sans-serif';
        c.textBaseline = 'middle';

        let y = 0;
        for (const lane of LANES) {
            const h = lane.h;
            if (lane.id !== 'overview' && lane.id !== 'ruler') {
                c.fillStyle = col.lane;
                c.fillRect(LABEL_W, y, pw, h);
            }
            c.save();
            c.beginPath();
            c.rect(LABEL_W, y, pw, h);
            c.clip();
            drawLane(c, lane.id, y, h, { X, t1, pw, dur, col, g, m, v });
            c.restore();
            if (lane.label) {
                c.fillStyle = col.text;
                c.textAlign = 'left';
                c.fillText(lane.label, 8, y + h / 2);
            }
            y += h + 1;
        }

        const t = currentTime();
        const px = X(t);
        if (px >= LABEL_W && px <= LABEL_W + pw) {
            c.fillStyle = col.play;
            c.fillRect(Math.round(px) - 1, LANES[0].h, 2, totalH - LANES[0].h);
        }
        $('clock').textContent = fmtTime(t, true);
    }

    function drawLane(c, id, y, h, k) {
        const { X, t1, pw, dur, col, g, m, v } = k;
        const visible = arr => arr.filter(o => (o.e ?? o.t ?? o.s) >= v.t0 && (o.s ?? o.t) <= t1);

        if (id === 'overview') {
            const sx = t => LABEL_W + t / dur * pw;
            for (const s of g.sections) {
                c.fillStyle = sectionColor(s.letter, 0.35);
                c.fillRect(sx(s.s), y + 2, sx(s.e) - sx(s.s), h - 4);
            }
            drawWave(c, y + 2, h - 4, 0, dur, pw / dur, col.wave, sx);
            c.strokeStyle = col.fg;
            c.lineWidth = 1.5;
            c.strokeRect(sx(v.t0) + 0.5, y + 1.5, Math.max(3, (t1 - v.t0) / dur * pw) - 1, h - 3);
            c.fillStyle = col.play;
            c.fillRect(sx(currentTime()) - 1, y, 2, h);
            return;
        }
        if (id === 'ruler') {
            const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
            const step = steps.find(s => s * v.pxPerSec >= 70) || 60;
            c.fillStyle = col.text;
            c.strokeStyle = col.grid;
            c.textAlign = 'left';
            for (let t = Math.floor(v.t0 / step) * step; t <= t1; t += step) {
                const x = Math.round(X(t)) + 0.5;
                c.beginPath(); c.moveTo(x, y + h - 6); c.lineTo(x, y + h); c.stroke();
                c.fillText(fmtTime(t, step < 1), x + 3, y + h / 2 - 1);
            }
            return;
        }
        if (id === 'sections') {
            for (const s of visible(g.sections)) {
                const x0 = X(s.s), x1 = X(s.e);
                c.fillStyle = sectionColor(s.letter, 0.85);
                c.fillRect(x0, y + 2, x1 - x0 - 1, h - 4);
                c.fillStyle = '#fff';
                c.textAlign = 'left';
                c.save();
                c.beginPath(); c.rect(x0, y, x1 - x0 - 4, h); c.clip();
                c.fillText(s.name, Math.max(x0, LABEL_W) + 5, y + h / 2);
                c.restore();
            }
            return;
        }
        if (id === 'wave') {
            for (const s of visible(g.sections)) {
                c.fillStyle = sectionColor(s.letter, 0.08);
                c.fillRect(X(s.s), y, X(s.e) - X(s.s), h);
            }
            if (g.T * v.pxPerSec > 12) {
                c.fillStyle = col.grid;
                for (const b of visible(g.beats)) c.fillRect(Math.round(X(b.s)), y, b.n === 1 ? 2 : 1, h);
            } else if (v.pxPerSec > 30) {
                c.fillStyle = col.grid;
                for (const b of visible(g.bars)) c.fillRect(Math.round(X(b.s)), y, 1, h);
            }
            drawWave(c, y, h, v.t0, t1, v.pxPerSec, col.wave, X);
            // loudness envelope
            c.strokeStyle = col.accent;
            c.globalAlpha = 0.8;
            c.lineWidth = 1.5;
            c.beginPath();
            const L = m.loudnessSmooth, st = m.loudStep;
            const i0 = Math.max(0, Math.floor(v.t0 / st)), i1 = Math.min(L.length - 1, Math.ceil(t1 / st));
            const stride = Math.max(1, Math.floor((i1 - i0) / pw));
            for (let i = i0; i <= i1; i += stride) {
                const px = X(i * st), py = y + h - 3 - L[i] * (h - 6);
                i === i0 ? c.moveTo(px, py) : c.lineTo(px, py);
            }
            c.stroke();
            c.globalAlpha = 1;
            return;
        }
        if (id === 'energy') {
            for (const e of visible(g.energy)) {
                c.fillStyle = `hsla(${45 - e.level * 9}, 90%, ${68 - e.level * 6}%, ${0.25 + e.level * 0.15})`;
                c.fillRect(X(e.s), y + 2, X(e.e) - X(e.s), h - 4);
            }
            return;
        }
        if (id === 'bars') {
            c.textAlign = 'left';
            const showNums = 20 * (g.T * g.meter) * v.pxPerSec > 400;
            const every = showNums ? 1 : Math.ceil(30 / (g.T * g.meter * v.pxPerSec));
            for (const b of visible(g.bars)) {
                const x = Math.round(X(b.s)) + 0.5;
                c.strokeStyle = col.fg;
                c.beginPath(); c.moveTo(x, y + 2); c.lineTo(x, y + h - 2); c.stroke();
                if (b.n % every === 0 || every === 1) {
                    c.fillStyle = col.text;
                    c.fillText(String(b.n), x + 3, y + h / 2);
                }
            }
            return;
        }
        if (id === 'beats') {
            const dense = g.T * v.pxPerSec < 6;
            for (const b of visible(g.beats)) {
                if (dense && b.n !== 1) continue;
                const x = Math.round(X(b.s));
                const down = b.n === 1;
                c.fillStyle = down ? col.accent : col.text;
                const bh = down ? h - 4 : h * 0.5;
                c.fillRect(x, y + h - 2 - bh, down ? 3 : 2, bh);
                if (g.T * v.pxPerSec > 22) {
                    c.textAlign = 'left';
                    c.fillText(String(b.n), x + 3, y + 7);
                }
            }
            return;
        }
        const L = state.lyr;
        if (id === 'voice' && L) {
            for (const sg of visible(L.vseg)) {
                c.fillStyle = 'hsla(285, 60%, 60%, 0.18)';
                c.fillRect(X(sg.s), y, X(sg.e) - X(sg.s), h);
            }
            const env = state.voc.env, step = 1 / Vocals.ENV_FPS;
            if (!env) return;   // restored from a project: no voice stem until Find words runs
            c.fillStyle = 'hsl(285, 55%, 55%)';
            for (let x = LABEL_W; x < LABEL_W + pw; x++) {
                const ta = v.t0 + (x - LABEL_W) / v.pxPerSec, tb = ta + 1 / v.pxPerSec;
                let hi = 0;
                for (let f = Math.floor(ta / step); f <= Math.min(env.sm.length - 1, Math.floor(tb / step)); f++) if (env.sm[f] > hi) hi = env.sm[f];
                const bh = Math.min(1, hi / env.peak) * (h - 4);
                c.fillRect(x, y + h / 2 - bh / 2, 1, Math.max(0.5, bh));
            }
            return;
        }
        if ((id === 'lines' || id === 'words' || id === 'mouth') && L) {
            const list = id === 'lines' ? L.lines : id === 'words' ? L.words : L.phonemes;
            const hue = id === 'lines' ? 285 : id === 'words' ? 320 : 30;
            c.textAlign = 'left';
            const edited = id === 'words' && state.wordEdits && state.wordEdits.size ? state.wordEdits : null;
            for (const w of visible(list)) {
                const x0 = X(w.s), x1 = X(w.e);
                const wi = id === 'words' ? L.words.indexOf(w) : -1;
                const sel = wi >= 0 && wi === L.selected;
                c.fillStyle = sel ? 'hsl(45, 95%, 55%)' : `hsla(${hue}, 60%, 55%, 0.85)`;
                c.fillRect(x0, y + 2, Math.max(1, x1 - x0 - 1), h - 4);
                if (id === 'words' && x1 - x0 > 6) {
                    // start handle: this is what dragging moves
                    c.fillStyle = sel ? '#7a4b00' : 'rgba(255,255,255,0.75)';
                    c.fillRect(Math.round(x0), y + 2, 2, h - 4);
                    if (edited && edited.has(wi + '|' + state.lyrRaw.words[wi].key)) {
                        c.fillStyle = 'hsl(45, 95%, 60%)';
                        c.fillRect(x0, y + h - 4, Math.max(2, x1 - x0 - 1), 2);
                    }
                }
                if (x1 - x0 > 14) {
                    c.save();
                    c.beginPath(); c.rect(x0, y, x1 - x0 - 2, h); c.clip();
                    c.fillStyle = sel ? '#1d1300' : '#fff';
                    c.fillText(w.text, Math.max(x0, LABEL_W) + 4, y + h / 2);
                    c.restore();
                }
            }
            return;
        }
        if (id === 'notes' && L) {
            if (!L.noteRange) {
                const ms = L.notes.map(n => n.midi).sort((p, q) => p - q);
                L.noteRange = ms.length ? [Math.floor(ms[Math.floor(ms.length * 0.02)]) - 1, Math.ceil(ms[Math.floor(ms.length * 0.98)]) + 1] : [48, 72];
            }
            const [lo, hi] = L.noteRange, row = (h - 4) / Math.max(1, hi - lo);
            c.fillStyle = col.grid;
            for (let m2 = Math.ceil(lo); m2 <= hi; m2++) if (m2 % 12 === 0) c.fillRect(LABEL_W, y + h - 2 - (m2 - lo) * row, pw, 1);
            c.textAlign = 'left';
            for (const n of visible(L.notes)) {
                const yy = y + h - 2 - (Math.min(hi, Math.max(lo, n.midi)) - lo) * row;
                c.fillStyle = 'hsl(160, 60%, 42%)';
                c.fillRect(X(n.s), yy - 2, Math.max(1.5, X(n.e) - X(n.s) - 1), 4);
                if (X(n.e) - X(n.s) > 24) { c.fillStyle = col.text; c.fillText(n.text, X(n.s) + 2, yy - 7); }
            }
            return;
        }
        const hits = { kick: m.onsets.kick, snare: m.onsets.snare, hat: m.onsets.hat }[id];
        if (hits) {
            const hue = { kick: 0, snare: 200, hat: 50 }[id];
            for (const o of visible(hits)) {
                c.fillStyle = `hsla(${hue}, 75%, 55%, ${0.35 + 0.65 * o.s})`;
                const bh = 3 + o.s * (h - 5);
                c.fillRect(Math.round(X(o.t)), y + h - 1 - bh, Math.max(1.5, Math.min(4, v.pxPerSec * 0.02)), bh);
            }
        }
    }

    function drawWave(c, y, h, t0, t1, pps, color, X) {
        const pk = state.model.peaks, bs = pk.blockSec;
        const mid = y + h / 2, amp = h / 2 - 1;
        c.fillStyle = color;
        const x0 = Math.floor(X(t0)), x1 = Math.ceil(X(t1));
        for (let x = Math.max(LABEL_W, x0); x < x1; x++) {
            const ta = t0 + (x - X(t0)) / pps, tb = ta + 1 / pps;
            let b0 = Math.floor(ta / bs), b1 = Math.max(b0 + 1, Math.floor(tb / bs));
            b0 = Math.max(0, b0); b1 = Math.min(pk.min.length, b1);
            let lo = 0, hi = 0;
            for (let b = b0; b < b1; b++) { if (pk.min[b] < lo) lo = pk.min[b]; if (pk.max[b] > hi) hi = pk.max[b]; }
            c.fillRect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
    }

    // ---------- vocals ----------

    const lyricsKey = () => 'xlweb-lyrics:' + state.hash;

    function setVocalStatus(msg, p, isError) {
        $('vocalStatus').textContent = msg;
        $('vocalStatus').classList.toggle('error', !!isError);
        const bar = $('vocalProg');
        bar.hidden = p == null;
        if (p != null) bar.value = p;
    }

    function resetVocalPanel() {
        let saved = '';
        try { saved = localStorage.getItem(lyricsKey()) || ''; } catch (e) { /* storage blocked */ }
        $('lyricsText').value = saved;
        $('vocalResult').hidden = true;
        $('editHelp').hidden = true;
        $('resetEdits').hidden = true;
        $('useHeard').hidden = true;
        $('voiceOnlyWrap').hidden = true;
        $('voiceOnly').checked = false;
        $('findWords').textContent = 'Find words & vocals';
        $('findWords').disabled = false;
        setVocalStatus('', null);
        layoutLanes();
    }

    async function findWords() {
        if (state.vocBusy || !state.buffer) return;
        if (location.protocol === 'file:') {
            setVocalStatus('Finding words needs the page served rather than opened as a file. In the xlights-web folder run "node serve.js", then open http://127.0.0.1:8765', null, true);
            return;
        }
        const hash = state.hash;
        const lyrics = $('lyricsText').value;
        state.vocBusy = true;
        $('findWords').disabled = true;
        const t0 = performance.now();
        let lastP = 0;
        const report = (p, text) => {
            if (hash !== state.hash) return;
            if (p != null) lastP = p;
            setVocalStatus((text || '') + '…', lastP);
        };
        try {
            let voc = state.voc && !state.voc.partial ? state.voc : null;
            if (!voc) {
                voc = await Vocals.analyze(state.buffer, hash, { needText: !lyrics.trim() }, report);
            } else if (!lyrics.trim() && !voc.whisperText) {
                await Vocals.addText(voc, report);
            }
            if (hash !== state.hash) return;   // another song was loaded meanwhile
            if (!state.voc || state.voc.partial) {
                state.voc = voc;
                const b = state.ctx.createBuffer(1, voc.v22.length, Vocals.SR);
                b.copyToChannel(voc.v22, 0);
                state.vocBuffer = b;
            }
            await applyLyrics();
            const secs = (performance.now() - t0) / 1000;
            setVocalStatus(secs > 3 ? `Done in ${Math.round(secs)} s. Results are saved, so this song is instant next time.` : 'Updated.', null);
        } catch (err) {
            console.error(err);
            const hint = /webgpu|GPU|memory|allocation/i.test(err.message) ? ' (your browser may be short of GPU memory; close other tabs and try again)' : '';
            setVocalStatus('Could not finish: ' + err.message + hint, null, true);
        } finally {
            state.vocBusy = false;
            $('findWords').disabled = false;
        }
    }

    async function applyLyrics() {
        const text = $('lyricsText').value;
        try { localStorage.setItem(lyricsKey(), text); } catch (e) { /* storage blocked */ }
        state.lyrRaw = await Vocals.build(state.voc, text);
        loadWordEdits();
        relayoutWords(applyWordEdits());
        $('findWords').textContent = 'Update words';
        $('editHelp').hidden = false;
        $('useHeard').hidden = false;
        $('voiceOnlyWrap').hidden = false;
        layoutLanes();
        renderTracks();
        renderLyrics();
        draw();
    }

    // ---------- hand edits to word timing ----------
    //
    // Edits are stored against (word index, word) so they survive re-running
    // "Update words" as long as the lyrics around them did not change.

    const editsKey = () => 'xlweb-wordedits:' + state.hash;

    function loadWordEdits() {
        state.wordEdits = new Map();
        try {
            for (const [k, s, e] of JSON.parse(localStorage.getItem(editsKey()) || '[]')) state.wordEdits.set(k, [s, e]);
        } catch (e) { /* none */ }
        state.editUndo = [];
    }

    function saveWordEdits() {
        try { localStorage.setItem(editsKey(), JSON.stringify([...state.wordEdits].map(([k, v]) => [k, ...v]))); } catch (e) { /* storage blocked */ }
    }

    const wordKey = (w, i) => i + '|' + w.key;

    // Raw aligned words (ms) with the user's edits on top.
    function applyWordEdits() {
        const words = state.lyrRaw.words.map(w => ({ ...w }));
        words.forEach((w, i) => {
            const ed = state.wordEdits.get(wordKey(w, i));
            if (ed) { w.s = ed[0]; w.e = ed[1]; }
        });
        for (let i = 0; i + 1 < words.length; i++) if (words[i].e > words[i + 1].s) words[i].e = words[i + 1].s;
        for (const w of words) if (w.e < w.s + 40) w.e = w.s + 40;
        return words;
    }

    function relayoutWords(wordsMs) {
        const r = state.lyrRaw;
        const re = Vocals.relayout(r.lineTexts, wordsMs);
        const sec = x => ({ s: x.s / 1000, e: x.e / 1000 });
        state.lyrWordsMs = wordsMs;
        state.lyr = {
            source: r.source,
            lines: re.lines.map(x => ({ ...sec(x), text: x.text })),
            words: wordsMs.map(x => ({ ...sec(x), text: x.text, line: x.line })),
            phonemes: re.phonemes.map(x => ({ ...sec(x), text: x.label })),
            vseg: state.voc.vseg.map(([a, b]) => ({ s: a / 1000, e: b / 1000 })),
            notes: state.voc.notes.map(n => ({ s: n.s, e: n.e, midi: n.midi, text: n.name })),
            stats: r.stats, missing: re.missing, error: r.error,
            selected: state.lyr && state.lyr.selected,
        };
        $('resetEdits').hidden = !state.wordEdits.size;
        $('resetEdits').textContent = `Undo all timing edits (${state.wordEdits.size})`;
        document.dispatchEvent(new CustomEvent('xl:lyrics'));
    }

    // Commit new times (ms) for some words; records them as edits.
    function commitWordTimes(changes, label) {
        state.editUndo.push(new Map(state.wordEdits));
        if (state.editUndo.length > 50) state.editUndo.shift();
        for (const [i, s, e] of changes) {
            const w = state.lyrRaw.words[i];
            state.wordEdits.set(wordKey(w, i), [Math.round(s), Math.round(e)]);
        }
        saveWordEdits();
        relayoutWords(applyWordEdits());
        renderLyrics();
        draw();
        if (label) setVocalStatus(label, null);
    }

    function undoWordEdit() {
        if (!state.editUndo || !state.editUndo.length) return false;
        state.wordEdits = state.editUndo.pop();
        saveWordEdits();
        relayoutWords(applyWordEdits());
        renderLyrics();
        draw();
        setVocalStatus('Undid the last timing edit.', null);
        return true;
    }

    // Where a dragged time may go: magnetised to a nearby vocal onset unless Alt is held.
    function snapToOnset(ms, alt) {
        if (alt || !state.voc) return ms;
        const tol = 6 / state.view.pxPerSec * 1000;
        let best = ms, bd = tol;
        for (const e of state.voc.edges) {
            const d = Math.abs(e - ms);
            if (d < bd) { bd = d; best = e; }
            if (e > ms + tol) break;
        }
        return best;
    }

    // drag = { kind: 'start' | 'word' | 'line', i | line, grabMs, orig: [[i,s,e]...] }
    let wordDrag = null;

    function laneAt(y) {
        let top = 0;
        for (const l of LANES) {
            if (y >= top && y < top + l.h + 1) return { id: l.id, top, h: l.h };
            top += l.h + 1;
        }
        return null;
    }

    function hitWord(xPx, laneId) {
        if (!state.lyr) return null;
        const ms = (state.view.t0 + (xPx - LABEL_W) / state.view.pxPerSec) * 1000;
        const words = state.lyrWordsMs;
        const edgeTol = 5 / state.view.pxPerSec * 1000;
        if (laneId === 'words') {
            for (let i = 0; i < words.length; i++) {
                if (Math.abs(words[i].s - ms) <= edgeTol) return { kind: 'start', i, ms };
            }
            for (let i = 0; i < words.length; i++) if (ms > words[i].s && ms < words[i].e) return { kind: 'word', i, ms };
        }
        if (laneId === 'lines') {
            const L = state.lyr.lines;
            for (let k = 0; k < L.length; k++) {
                if (ms >= L[k].s * 1000 && ms <= L[k].e * 1000) {
                    const line = words.find(w => w.s >= L[k].s * 1000 - 1 && w.s < L[k].e * 1000);
                    if (line) return { kind: 'line', line: line.line, ms };
                }
            }
        }
        return null;
    }

    function startWordDrag(hit) {
        const words = state.lyrWordsMs;
        const idx = hit.kind === 'line' ? words.map((w, i) => w.line === hit.line ? i : -1).filter(i => i >= 0) : [hit.i];
        const lo = Math.max(0, idx[0] - 1), hi = Math.min(words.length - 1, idx[idx.length - 1] + 1);
        const orig = [];
        for (let i = lo; i <= hi; i++) orig.push([i, words[i].s, words[i].e]);
        wordDrag = { ...hit, idx, orig, moved: false };
        state.lyr.selected = hit.kind === 'line' ? null : hit.i;
    }

    function moveWordDrag(xPx, alt) {
        const d = wordDrag, words = state.lyrWordsMs;
        const ms = (state.view.t0 + (xPx - LABEL_W) / state.view.pxPerSec) * 1000;
        const o = new Map(d.orig.map(([i, s, e]) => [i, [s, e]]));
        const first = d.idx[0], last = d.idx[d.idx.length - 1];
        const prev = o.get(first - 1), next = o.get(last + 1);
        const out = [];
        if (d.kind === 'start') {
            const [, e] = o.get(first);
            let s = snapToOnset(ms, alt);
            s = Math.max(prev ? prev[0] + 40 : 0, Math.min(e - 40, s));
            out.push([first, s, e]);
            if (prev && prev[1] > s) out.push([first - 1, prev[0], s]);
            else if (prev) out.push([first - 1, prev[0], prev[1]]);
        } else {
            const [s0] = o.get(first);
            const e1 = o.get(last)[1];
            let delta = ms - d.ms;
            const snapped = snapToOnset(s0 + delta, alt);
            delta = snapped - s0;
            const minS = prev ? prev[0] + 40 : 0;
            const maxE = next ? next[1] - 40 : state.buffer.duration * 1000;
            delta = Math.max(minS - s0, Math.min(maxE - e1, delta));
            for (const i of d.idx) { const [s, e] = o.get(i); out.push([i, s + delta, e + delta]); }
            if (prev) out.push([first - 1, prev[0], Math.min(prev[1], s0 + delta)]);
            if (next) out.push([last + 1, Math.max(next[0], e1 + delta), next[1]]);
        }
        for (const [i, s, e] of out) { words[i].s = s; words[i].e = e; }
        d.out = out;
        d.moved = true;
        relayoutWords(words);
        draw();
    }

    function endWordDrag() {
        const d = wordDrag;
        wordDrag = null;
        if (!d.moved) { draw(); return; }
        // Only record what actually changed.
        const changed = d.out.filter(([i, s, e]) => {
            const o = d.orig.find(x => x[0] === i);
            return Math.round(o[1]) !== Math.round(s) || Math.round(o[2]) !== Math.round(e);
        });
        if (changed.length) {
            const what = d.kind === 'line' ? 'Moved the line' : d.kind === 'start' ? `Moved the start of "${state.lyrWordsMs[d.i].text}"` : `Moved "${state.lyrWordsMs[d.i].text}"`;
            commitWordTimes(changed, what + '. Ctrl+Z undoes it.');
        }
    }

    function nudgeSelected(deltaMs) {
        const i = state.lyr && state.lyr.selected;
        if (i == null) return false;
        const words = state.lyrWordsMs, w = words[i];
        const prev = words[i - 1];
        const s = Math.max(prev ? prev.s + 40 : 0, Math.min(w.e - 40, w.s + deltaMs));
        const changes = [[i, s, w.e]];
        if (prev && prev.e > s) changes.push([i - 1, prev.s, s]);
        commitWordTimes(changes, `"${w.text}" now starts at ${fmtTime(s / 1000, true)}. Arrow keys nudge it, Ctrl+Z undoes.`);
        return true;
    }

    $('resetEdits').addEventListener('click', () => {
        if (!state.wordEdits.size) return;
        state.editUndo.push(new Map(state.wordEdits));
        state.wordEdits = new Map();
        saveWordEdits();
        relayoutWords(applyWordEdits());
        renderLyrics();
        draw();
        setVocalStatus('Timing edits removed. Ctrl+Z brings them back.', null);
    });

    function renderLyrics() {
        const L = state.lyr, st = L.stats;
        $('vocalResult').hidden = false;
        const parts = [
            `<b>${L.words.length}</b> words in <b>${L.lines.length}</b> lines`,
            `${Math.round((st.onOnset || 0) * 100)}% start on a sung syllable`,
            `<b>${L.vseg.length}</b> sung passages, <b>${L.notes.length}</b> notes`,
        ];
        let warn = '';
        if (L.error) warn = L.error;
        else if (L.source === 'lyrics' && st.words && st.anchored / st.words < 0.4) {
            warn = `Only ${Math.round(st.anchored / st.words * 100)}% of your words matched what was sung. Check that these are the lyrics for this song.`;
        }
        if (L.missing.length) {
            const list = L.missing.slice(0, 12).map(w => w.toLowerCase()).join(', ') + (L.missing.length > 12 ? '…' : '');
            parts.push(`mouth shapes guessed for: ${esc(list)}`);
        }
        $('vocalStats').innerHTML = (L.source === 'lyrics' ? 'Using your lyrics. ' : 'Using the words it heard. Paste the real lyrics above for exact words. ') +
            parts.join(' · ') + (warn ? `<div class="warn">${esc(warn)}</div>` : '');
        const tb = $('lyricRows');
        tb.innerHTML = '';
        for (const ln of L.lines) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td class="num"><button type="button" class="link seek">${fmtTime(ln.s, true)}</button></td><td>${esc(ln.text)}</td>`;
            tr.querySelector('.seek').addEventListener('click', () => seek(ln.s, true));
            tb.appendChild(tr);
        }
    }

    $('findWords').addEventListener('click', findWords);
    $('useHeard').addEventListener('click', async () => {
        if (!state.voc || state.vocBusy) return;
        if (!state.voc.whisperText) {
            const hash = state.hash;
            state.vocBusy = true;
            try {
                await Vocals.addText(state.voc, (p, text) => { if (hash === state.hash) setVocalStatus((text || '') + '…', p); });
            } catch (err) {
                setVocalStatus('Could not finish: ' + err.message, null, true);
                return;
            } finally { state.vocBusy = false; }
            if (hash !== state.hash) return;
        }
        $('lyricsText').value = await Vocals.heardText(state.voc);
        $('lyricsText').focus();
        setVocalStatus('This is what it heard. Fix any wrong words, then press Update words.', null);
    });
    $('voiceOnly').addEventListener('change', () => { if (state.play.playing) { stop(); play(); } });

    // ---------- export ----------

    function snapMs(t, snap) {
        const ms = t * 1000;
        return snap ? Math.round(ms / snap) * snap : Math.round(ms);
    }

    function buildMarks(id, snap) {
        const g = state.grid, m = state.model, dur = m.duration;
        let marks;
        const L = state.lyr;
        if (id === 'lines') marks = L.lines.map(x => ({ s: x.s, e: x.e, label: x.text }));
        else if (id === 'words') marks = L.words.map(x => ({ s: x.s, e: x.e, label: x.text }));
        else if (id === 'mouth') marks = L.phonemes.map(x => ({ s: x.s, e: x.e, label: x.text }));
        else if (id === 'vocals') marks = L.vseg.map(x => ({ s: x.s, e: x.e, label: '' }));
        else if (id === 'notes') marks = L.notes.map(x => ({ s: x.s, e: x.e, label: x.text }));
        else if (id === 'beats') marks = g.beats.map(b => ({ s: b.s, e: b.e, label: String(b.n) }));
        else if (id === 'bars') marks = g.bars.map(b => ({ s: b.s, e: b.e, label: String(b.n) }));
        else if (id === 'phrases') marks = g.phrases.map((p, i) => ({ s: p.s, e: p.e, label: String(i + 1) }));
        else if (id === 'sections') marks = g.sections.map(s => ({ s: s.s, e: s.e, label: s.name }));
        else if (id === 'energy') marks = g.energy.map(e => ({ s: e.s, e: e.e, label: String(e.level) }));
        else {
            const list = m.onsets[id];
            const maxLen = g.T / 2;
            marks = list.map((o, i) => ({ s: o.t, e: Math.min(o.t + maxLen, i + 1 < list.length ? list[i + 1].t : dur, dur), label: '' }));
        }
        const out = [];
        for (const mk of marks) {
            let s = snapMs(mk.s, snap), e = snapMs(mk.e, snap);
            const prev = out[out.length - 1];
            if (prev && s < prev.e) s = prev.e;
            if (e <= s) continue;
            out.push({ s, e, label: mk.label });
        }
        return out;
    }

    function xmlEsc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function buildXTiming() {
        const snap = parseInt($('snap').value, 10);
        const chosen = TRACKS.filter(t => t.on && (!t.vocal || state.lyr));
        if (!chosen.length) return null;
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        if (chosen.length > 1) xml += '<timings>\n';
        for (const t of chosen) {
            xml += `<timing name="${xmlEsc(t.label)}" subType="Generic" SourceVersion="2026.10">\n`;
            // A lyric track is three layers (phrases, words, phonemes), which is
            // what the Faces effect reads.
            for (const layer of t.id === 'lyrics' ? ['lines', 'words', 'mouth'] : [t.id]) {
                xml += '   <EffectLayer>\n';
                for (const mk of buildMarks(layer, snap)) {
                    xml += `      <Effect label="${xmlEsc(mk.label)}" starttime="${mk.s}" endtime="${mk.e}" />\n`;
                }
                xml += '   </EffectLayer>\n';
            }
            xml += '</timing>\n';
        }
        if (chosen.length > 1) xml += '</timings>\n';
        return xml;
    }

    function download(name, text, type) {
        const blob = new Blob([text], { type });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    $('exportX').addEventListener('click', () => {
        const xml = buildXTiming();
        if (!xml) { alert('Tick at least one track to export.'); return; }
        download(`${state.fileName || 'song'}.xtiming`, xml, 'application/xml');
    });

    $('exportJ').addEventListener('click', () => {
        const g = state.grid, m = state.model;
        const r3 = x => Math.round(x * 1000) / 1000;
        const data = {
            song: state.fileName,
            durationSec: r3(m.duration),
            musicStartSec: r3(m.songStart),
            musicEndSec: r3(m.songEnd),
            bpm: g.bpm,
            firstBeatSec: r3(g.offset),
            beatsPerBar: g.meter,
            beats: g.beats.map(b => ({ t: r3(b.s), beat: b.n })),
            bars: g.bars.map(b => ({ t: r3(b.s), end: r3(b.e), bar: b.n })),
            phrases: g.phrases.map(p => ({ t: r3(p.s), end: r3(p.e) })),
            sections: g.sections.map(s => ({ name: s.name, group: s.letter, t: r3(s.s), end: r3(s.e), bars: s.bars, energy: r3(s.energy) })),
            energy: g.energy.map(e => ({ t: r3(e.s), end: r3(e.e), level: e.level })),
            hits: Object.fromEntries(['kick', 'snare', 'hat', 'all'].map(k => [k, m.onsets[k].map(o => ({ t: r3(o.t), strength: r3(o.s) }))])),
            loudness: { stepSec: m.loudStep, values: Array.from(m.loudness, v => r3(v)) },
            gridFit: g.fit,
        };
        const L = state.lyr;
        if (L) {
            const seg = x => ({ t: r3(x.s), end: r3(x.e) });
            data.lyrics = {
                source: L.source === 'lyrics' ? 'pasted lyrics' : 'transcribed',
                lines: L.lines.map(x => ({ ...seg(x), text: x.text })),
                words: L.words.map(x => ({ ...seg(x), text: x.text, line: x.line })),
                mouth: L.phonemes.map(x => ({ ...seg(x), shape: x.text })),
            };
            data.vocals = {
                singing: L.vseg.map(seg),
                notes: L.notes.map(x => ({ ...seg(x), note: x.text, midi: Math.round(x.midi * 10) / 10 })),
                pitch: state.voc.pitch ? { stepSec: r3(state.voc.pitch.step), midi: Array.from(state.voc.pitch.midi, x => Math.round(x * 10) / 10) } : null,
            };
        }
        download(`${state.fileName || 'song'}.analysis.json`, JSON.stringify(data, null, 1), 'application/json');
    });

    // ---------- helpers ----------

    function fmtTime(t, ms) {
        t = Math.max(0, t);
        const m = Math.floor(t / 60), s = t - m * 60;
        return ms ? `${m}:${s.toFixed(3).padStart(6, '0')}` : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
    }

    function esc(s) {
        return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
    document.addEventListener('xl:theme', () => { if (state.buffer) draw(); });

    // Hook for testing from the console: XLWeb.loadUrl('song.mp3')
    // ---------- project files ----------
    //
    // A project holds everything decided about a song: the tempo grid, the
    // user's sections, the lyrics and their timing (including hand edits), and
    // the light plan. The song itself is not in it; opening a project asks for
    // the MP3 if a different one is loaded.

    const PROJECT_FORMAT = 'xlights-web-project';
    state.projectDirty = false;
    state.projectHandle = null;
    let pendingProject = null;
    let pendingProjectHandle = null;
    let restoring = false;

    function setProjStatus(msg) { $('projStatus').textContent = msg; if (typeof updateTitle === 'function') setTimeout(updateTitle, 0); }

    function markDirty() {
        if (restoring || !state.buffer) return;
        state.projectDirty = true;
        setProjStatus('Unsaved changes');
        if (autoSaveOn()) {
            clearTimeout(markDirty.t);
            markDirty.t = setTimeout(() => { if (state.projectDirty && autoSaveOn()) saveProject(false, true); }, 1500);
        }
    }
    const autoSaveOn = () => $('autoSave').checked;
    document.addEventListener('xl:changed', markDirty);
    document.addEventListener('xl:lyrics', markDirty);

    function hasWork() {
        const p = window.XLSeq && XLSeq.getPlan();
        const planned = p && ((p.whole && p.whole.rows.length) || Object.values(p.sections || {}).some(c => c.rows.length));
        return !!(planned || state.userSections || (state.wordEdits && state.wordEdits.size) || state.lyr);
    }

    window.addEventListener('beforeunload', e => {
        if (state.projectDirty && hasWork()) { e.preventDefault(); e.returnValue = ''; }
    });

    function projectData() {
        const L = state.lyrRaw;
        return {
            format: PROJECT_FORMAT,
            version: 1,
            savedAt: new Date().toISOString(),
            // The browser never reveals a file's folder, so the song is found again
            // by its fingerprint (hash) through the handle the browser keeps, or by
            // name + size in the music or show folder. 'path' is the location as
            // typed for xLights, kept for reference.
            song: { file: state.fileFull, name: state.fileName, hash: state.hash, size: state.fileSize || null, duration: state.buffer.duration, path: window.XLSeq ? XLSeq.mediaPath() : '' },
            grid: state.params,
            sections: state.userSections,
            lyrics: {
                text: $('lyricsText').value,
                wordEdits: [...(state.wordEdits || new Map())].map(([k, v]) => [k, ...v]),
                aligned: L ? { source: L.source, lineTexts: L.lineTexts, words: L.words, stats: L.stats, error: L.error || null } : null,
                voice: state.voc ? { vseg: state.voc.vseg, edges: state.voc.edges, notes: state.voc.notes } : null,
            },
            plan: window.XLSeq ? XLSeq.getPlan() : null,
            mediaPath: window.XLSeq ? XLSeq.mediaPath() : '',
            photo: window.XLSeq ? XLSeq.getBgAdj() : null,
            colourSchemes: Effects.SCHEMES,
        };
    }

    // auto: an auto-save. It never opens a dialog or downloads; if the file
    // can't be written without a click, it says so and waits.
    async function saveProject(saveAs, auto = false) {
        if (!state.buffer) return false;
        const data = projectData();
        const text = JSON.stringify(data, null, 1);
        const name = `${state.fileName || 'song'}.lightseq.json`;
        const at = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        try {
            if (window.showSaveFilePicker) {
                if (!state.projectHandle || saveAs) {
                    if (auto) { setProjStatus('Unsaved changes · press Save project once to start auto-saving'); return false; }
                    state.projectHandle = await window.showSaveFilePicker({ suggestedName: name, id: 'xlweb-project', types: [{ description: 'Light sequencer project', accept: { 'application/json': ['.json'] } }] });
                }
                const h = state.projectHandle;
                if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
                    if (auto) { setProjStatus('Unsaved changes · press Save project once to let auto-save write to ' + h.name); return false; }
                    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('the browser did not allow saving to ' + h.name);
                }
                const w = await h.createWritable();
                await w.write(text);
                await w.close();
                state.projectDirty = false;
                setProjStatus(`${auto ? 'Auto-saved' : 'Saved'} ${h.name} at ${at()}`);
                rememberProject(h, data);
                return true;
            }
        } catch (err) {
            if (err && err.name === 'AbortError') return false;
            console.error(err);
            if (auto) { setProjStatus('Auto-save failed (' + (err.message || err) + '); press Save project.'); return false; }
            setProjStatus('Could not save there (' + (err.message || err) + '); downloading instead.');
        }
        if (auto) return false;
        download(name, text, 'application/json');
        state.projectDirty = false;
        setProjStatus(`Downloaded ${name}`);
        return true;
    }

    // ---------- the banner that says what opening a project is doing ----------

    function banner(html, buttons = [], kind = '') {
        const b = $('projBanner');
        if (!html) { b.hidden = true; return; }
        b.hidden = false;
        b.className = 'proj-banner ' + kind;
        $('projBannerText').innerHTML = html;
        const box = $('projBannerBtns');
        box.innerHTML = '';
        for (const [label, fn, primary] of buttons) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn small' + (primary ? ' primary' : '');
            btn.textContent = label;
            btn.addEventListener('click', fn);
            box.appendChild(btn);
        }
        b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Anything unexpected: say so, with the details ready to paste into Discord #bugs.
    const reported = new Set();
    function reportError(msg, stack) {
        const text = String(msg || 'Unknown error');
        if (reported.has(text) || /ResizeObserver loop/.test(text)) return;
        reported.add(text);
        const details = `${text}\n${stack || ''}\nPage: ${location.href}\nBrowser: ${navigator.userAgent}`;
        banner(`Something went wrong: <b>${esc(text.slice(0, 200))}</b>. The page may still work; if it doesn't, reload it. Please tell us in Discord <b>#bugs</b> (copy the details and paste them there), so it can be fixed.`, [
            ['Copy details', async () => { try { await navigator.clipboard.writeText(details); } catch (e) { /* no clipboard */ } }, true],
            ['Discord', () => window.open('https://discord.gg/xjgWweqCEs', '_blank', 'noopener')],
            ['Dismiss', () => banner(null)],
        ], 'error');
    }
    window.addEventListener('error', e => reportError(e.message, e.error && e.error.stack));
    window.addEventListener('unhandledrejection', e => { const r = e.reason; if (r && r.name === 'AbortError') return; reportError(r && r.message || r, r && r.stack); });

    async function openProjectFile(file, handle = null) {
        pendingProjectHandle = handle;
        try {
            let p;
            try { p = JSON.parse(await file.text()); } catch (e) { p = null; }
            if (!p || p.format !== PROJECT_FORMAT) {
                banner(`<b>${esc(file.name)}</b> is not a project saved by this page.`, [['OK', () => banner(null)]], 'error');
                return;
            }
            const songName = (p.song && p.song.file) || 'its song';
            if (state.buffer && p.song && p.song.hash === state.hash) {
                banner(`Opening project for <b>${esc(songName)}</b>…`);
                await applyProject(p);
                banner(`Opened the project for <b>${esc(songName)}</b>.`, [['OK', () => banner(null)]], 'ok');
                return;
            }
            pendingProject = p;
            banner(`Opening project for <b>${esc(songName)}</b>: looking for the song…`);
            const found = await findProjectSong(p, true);
            if (found && !found.needsClick) {
                banner(`Opening project for <b>${esc(songName)}</b>: found the song (${esc(found.how)}), reading it…`);
                await loadFile(await found.handle.getFile(), found.handle);
                return;
            }
            if (found && found.needsClick) { askToAllow(p, found); return; }
            askForSong(p);
        } catch (err) {
            console.error(err);
            banner(`Could not open that project: ${esc(err.message || String(err))}`, [['OK', () => banner(null)]], 'error');
        }
    }

    // The browser remembers the song (or its folder) but wants a click before
    // the page may read it again. One click, no browsing.
    function askToAllow(p, found) {
        const s = p.song || {};
        const what = found.dir ? `${esc(found.label)} (<b>${esc(found.dir.name)}</b>)` : `<b>${esc(s.file || 'the song')}</b>`;
        banner(`This project's song is ${found.dir ? 'probably in ' : ''}${what}. Your browser asks before the page reads it again: press <b>Open</b>, and in Chrome or Edge choose <b>Allow on every visit</b> so it won't ask next time.`, [
            [found.dir ? `Open ${found.dir.name}` : `Open ${s.file || 'the song'}`, async () => {
                const ok = await canRead(found.handle || found.dir, true);
                if (!ok) { askForSong(p); return; }
                const again = await findProjectSong(p, false);
                if (again && !again.needsClick) {
                    banner(`Reading <b>${esc(s.file || 'the song')}</b>…`);
                    await loadFile(await again.handle.getFile(), again.handle);
                } else askForSong(p);
            }, true],
            ['Choose the song instead…', () => askForSong(p)],
            ['Cancel', () => { pendingProject = null; pendingProjectHandle = null; banner(null); }],
        ], 'ask');
    }

    // The song could not be found by itself: say which one is needed and offer ways to point at it.
    function askForSong(p) {
        const s = p.song || {};
        const where = s.path && /[\\/]/.test(s.path) ? ` It was at <code>${esc(s.path)}</code>.` : '';
        const buttons = [[`Choose ${s.file || 'the song'}…`, pickSong, true]];
        if (window.showDirectoryPicker) buttons.push(['Pick your music folder…', async () => {
            const dir = await pickMusicFolder();
            if (!dir) return;
            banner(`Looking for <b>${esc(s.file)}</b> in ${esc(dir.name)}…`);
            const found = await findProjectSong(p, true);
            if (found) await loadFile(await found.handle.getFile(), found.handle);
            else askForSong(p);
        }]);
        buttons.push(['Cancel', () => { pendingProject = null; pendingProjectHandle = null; banner(null); }]);
        banner(`To open this project, the page needs its song: <b>${esc(s.file || 'unknown')}</b>.${where} Choose it once; after that projects find their songs by themselves${window.showDirectoryPicker ? ' (or pick the folder you keep songs in, and every project will look there)' : ''}.`, buttons, 'ask');
    }

    async function applyProject(p) {
        restoring = true;
        try {
            if (p.song && p.song.hash && p.song.hash !== state.hash) {
                setStatus(`Note: this is not exactly the song file the project was made with (${p.song.file}), so times may be off.`, true);
            }
            if (p.grid && p.grid.bpm > 0) state.params = { ...p.grid };
            state.userSections = Array.isArray(p.sections) && p.sections.length ? p.sections : null;
            saveUserSections();
            rebuild();
            syncControls();
            const L = p.lyrics || {};
            $('lyricsText').value = L.text || '';
            try { localStorage.setItem(lyricsKey(), L.text || ''); } catch (e) { /* storage blocked */ }
            state.wordEdits = new Map((L.wordEdits || []).map(([k, s, e]) => [k, [s, e]]));
            state.editUndo = [];
            saveWordEdits();
            if (L.aligned && L.voice) {
                await Vocals.loadDict();
                state.voc = { partial: true, vseg: L.voice.vseg || [], edges: L.voice.edges || [], notes: L.voice.notes || [], env: null, pitch: null, hash: state.hash };
                state.lyrRaw = L.aligned;
                relayoutWords(applyWordEdits());
                $('findWords').textContent = 'Update words';
                $('editHelp').hidden = false;
                $('useHeard').hidden = true;
                layoutLanes();
                renderTracks();
                renderLyrics();
                setVocalStatus('Words restored from the project. Press Update words only if you change the lyrics.', null);
            }
            // the project's colour schemes join the user's own (nothing of theirs is removed)
            if (Array.isArray(p.colourSchemes)) {
                const have = new Set(Effects.SCHEMES.map(s => s.id));
                const extra = p.colourSchemes.filter(s => s && s.id && !have.has(s.id) && Array.isArray(s.colors));
                if (extra.length) Effects.setSchemes(Effects.SCHEMES.concat(extra));
            }
            if (window.XLSeq) {
                XLSeq.setPlan(p.plan || null);
                XLSeq.setMediaPath(p.mediaPath);
                XLSeq.setBgAdj(p.photo);
            }
            draw();
            state.projectDirty = false;
            if (pendingProjectHandle) { state.projectHandle = pendingProjectHandle; pendingProjectHandle = null; rememberProject(state.projectHandle, p); }
            setProjStatus(`Opened ${state.projectHandle ? state.projectHandle.name : 'project'} (saved ${p.savedAt ? new Date(p.savedAt).toLocaleString() : 'earlier'})`);
            setStatus('Project opened.');
        } finally {
            restoring = false;
        }
    }

    $('saveProj').addEventListener('click', e => saveProject(e.shiftKey));
    // the File menu
    const menuDo = fn => () => { closeProjMenu(); fn(); };
    $('fmSong').addEventListener('click', menuDo(async () => { if (await confirmLeave()) pickSong(); }));
    $('fmSave').addEventListener('click', menuDo(() => saveProject(false)));
    $('fmSaveAs').addEventListener('click', menuDo(() => saveProject(true)));
    $('fmExport').addEventListener('click', menuDo(() => window.XLSeq && XLSeq.openExport()));
    $('fmTiming').addEventListener('click', menuDo(() => $('exportX').click()));
    $('fmJson').addEventListener('click', menuDo(() => $('exportJ').click()));
    $('exportBtn').addEventListener('click', () => window.XLSeq && XLSeq.openExport());

    // The project's name beside the buttons (and in the window title), with a
    // dot while there are unsaved changes, as in most programs.
    function updateTitle() {
        const name = state.projectHandle ? state.projectHandle.name.replace(/\.lightseq\.json$/i, '').replace(/\.json$/i, '') : (state.fileName ? `${state.fileName} (not saved yet)` : '');
        const dirty = state.projectDirty && hasWork();
        $('projTitle').textContent = name ? (dirty ? '• ' : '') + name : '';
        $('projTitle').classList.toggle('dirty', !!dirty);
        document.title = name ? `${dirty ? '• ' : ''}${name.replace(/ \(not saved yet\)$/, '')} – Lights Auto Sequencer` : 'Lights Auto Sequencer';
    }
    setInterval(updateTitle, 1000);
    $('openProj').addEventListener('click', () => pickProject());
    $('openProj0').addEventListener('click', () => pickProject());
    $('projFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openProjectFile(f); });

    const PROJECT_TYPES = [{ description: 'Light sequencer project', accept: { 'application/json': ['.json'] } }];

    // Open a project through the browser's picker where there is one, so the page
    // keeps a handle: Save then writes back to the same file, and it joins the
    // recent projects.
    async function pickProject() {
        if (!(await confirmLeave())) return;
        if (!window.showOpenFilePicker) { $('projFile').click(); return; }
        try {
            const [h] = await window.showOpenFilePicker({ id: 'xlweb-project', types: PROJECT_TYPES });
            if (autoSaveOn()) await h.requestPermission({ mode: 'readwrite' }).catch(() => null);
            await openProjectFile(await h.getFile(), h);
        } catch (err) { if (!err || err.name !== 'AbortError') banner(`Could not open that project: ${esc(err.message || String(err))}`, [['OK', () => banner(null)]], 'error'); }
    }

    // ---------- recent projects and the projects folder ----------

    const RECENT_KEY = 'recentProjects';
    async function recentProjects() {
        const list = await Show.kvGet(RECENT_KEY);
        return Array.isArray(list) ? list : [];
    }
    async function rememberProject(handle, p) {
        if (!handle) return;
        try {
            let list = await recentProjects();
            const same = [];
            for (const r of list) if (r.handle && await r.handle.isSameEntry(handle).catch(() => false)) same.push(r);
            list = list.filter(r => !same.includes(r));
            list.unshift({ handle, name: handle.name, song: (p.song && p.song.file) || '', hash: (p.song && p.song.hash) || '', savedAt: p.savedAt || new Date().toISOString(), openedAt: new Date().toISOString() });
            await Show.kvPut(RECENT_KEY, list.slice(0, 12));
            renderRecentStart();
        } catch (e) { /* storage blocked */ }
    }
    async function forgetProject(i) {
        const list = await recentProjects();
        list.splice(i, 1);
        await Show.kvPut(RECENT_KEY, list);
    }

    // Save, don't save, or stay: asked before anything replaces work that isn't saved.
    function confirmLeave() {
        if (!state.projectDirty || !hasWork()) return Promise.resolve(true);
        const dlg = $('leaveDlg');
        $('leaveName').textContent = state.projectHandle ? state.projectHandle.name : (state.fileName || 'this song');
        return new Promise(resolve => {
            const done = v => { dlg.close(); cleanup(); resolve(v); };
            const save = async () => { dlg.close(); cleanup(); resolve(await saveProject(false)); };
            const nosave = () => { state.projectDirty = false; done(true); };
            const cancel = () => done(false);
            const onCancel = e => { e.preventDefault(); done(false); };
            const cleanup = () => {
                $('leaveSave').removeEventListener('click', save);
                $('leaveDiscard').removeEventListener('click', nosave);
                $('leaveStay').removeEventListener('click', cancel);
                dlg.removeEventListener('cancel', onCancel);
            };
            $('leaveSave').addEventListener('click', save);
            $('leaveDiscard').addEventListener('click', nosave);
            $('leaveStay').addEventListener('click', cancel);
            dlg.addEventListener('cancel', onCancel);
            dlg.showModal();
        });
    }

    // Open a project from the list. The browser asks before reading a file
    // again, and only during a click, so the project and its song are asked for
    // together, straight away.
    async function openRecent(h, songHash) {
        if (!(await confirmLeave())) return;
        const song = songHash ? await Show.kvGet(songKey(songHash)) : null;
        const asks = [allowFile(h)];
        if (song) asks.push(canRead(song, true));
        const [okProject] = await Promise.all(asks);
        if (!okProject) { banner(`The browser didn't allow opening <b>${esc(h.name)}</b>.`, [['OK', () => banner(null)]], 'error'); return; }
        closeProjMenu();
        try { await openProjectFile(await h.getFile(), h); }
        catch (err) { banner(`Could not open <b>${esc(h.name)}</b> (moved or deleted?): ${esc(err.message || String(err))}`, [['OK', () => banner(null)]], 'error'); }
    }

    // Read access, plus write access when auto-save will need it.
    async function allowFile(h) {
        if (autoSaveOn() && h.requestPermission) {
            try {
                if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted' || (await h.requestPermission({ mode: 'readwrite' })) === 'granted') return true;
            } catch (e) { /* fall back to read */ }
        }
        return canRead(h, true);
    }

    async function listProjectsIn(dir, depth = 1, out = [], prefix = '') {
        try {
            for await (const [n, h] of dir.entries()) {
                if (h.kind === 'file' && /\.lightseq\.json$/i.test(n)) out.push({ handle: h, name: n, where: prefix });
                else if (h.kind === 'directory' && depth > 0 && !/^backup/i.test(n)) await listProjectsIn(h, depth - 1, out, prefix ? prefix + '/' + n : n);
            }
        } catch (e) { /* unreadable */ }
        return out;
    }

    const ago = iso => {
        const s = (Date.now() - new Date(iso).getTime()) / 1000;
        if (!(s >= 0)) return '';
        if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
        if (s < 86400) return Math.round(s / 3600) + ' h ago';
        return new Date(iso).toLocaleDateString();
    };

    async function drawProjMenu(askFolder = false) {
        const box = $('projMenuList');
        const list = await recentProjects();
        const isCurrent = async r => state.projectHandle && r.handle && await r.handle.isSameEntry(state.projectHandle).catch(() => false);
        let html = '<div class="pm-head">Recent projects</div>';
        if (!list.length) html += '<p class="muted small pm-empty">Projects you open or save appear here.</p>';
        for (let i = 0; i < list.length; i++) {
            const r = list[i];
            html += `<div class="pm-row${(await isCurrent(r)) ? ' current' : ''}"><button type="button" class="pm-open" data-i="${i}"><b>${esc(r.name.replace(/\.lightseq\.json$/i, ''))}</b><span class="muted small">${esc(r.song || '')}${r.openedAt ? ' · ' + esc(ago(r.openedAt)) : ''}</span></button><button type="button" class="pm-x" data-x="${i}" title="Remove from this list (the file stays)" aria-label="Remove from list">×</button></div>`;
        }
        const dir = await Show.kvGet('projectsFolder');
        if (dir) {
            let ok = await canRead(dir, askFolder);
            html += `<div class="pm-head">In ${esc(dir.name)}</div>`;
            if (!ok) html += `<p class="small pm-empty"><button type="button" class="link" id="pmAllow">Show the projects in ${esc(dir.name)}</button></p>`;
            else {
                const files = (await listProjectsIn(dir)).sort((a, b) => a.name.localeCompare(b.name));
                if (!files.length) html += '<p class="muted small pm-empty">No projects in this folder yet.</p>';
                files.forEach((f, i) => { html += `<div class="pm-row"><button type="button" class="pm-open" data-f="${i}"><b>${esc(f.name.replace(/\.lightseq\.json$/i, ''))}</b>${f.where ? `<span class="muted small">${esc(f.where)}</span>` : ''}</button></div>`; });
                box._files = files;
            }
        }
        html += `<div class="pm-foot"><button type="button" class="btn small" id="pmOther">Open another…</button>${window.showDirectoryPicker ? `<button type="button" class="btn small" id="pmFolder">${dir ? 'Change projects folder…' : 'Choose projects folder…'}</button>` : ''}</div>`;
        box.innerHTML = html;
        box.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => { const r = list[+b.dataset.i]; openRecent(r.handle, r.hash); }));
        box.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => openRecent(box._files[+b.dataset.f].handle, null)));
        box.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', async e => { e.stopPropagation(); await forgetProject(+b.dataset.x); drawProjMenu(); renderRecentStart(); }));
        const allow = $('pmAllow'); if (allow) allow.addEventListener('click', () => drawProjMenu(true));
        $('pmOther').addEventListener('click', () => { closeProjMenu(); pickProject(); });
        const pf = $('pmFolder');
        if (pf) pf.addEventListener('click', async () => {
            try {
                const d = await window.showDirectoryPicker({ id: 'xlweb-projects', mode: 'readwrite' });
                await Show.kvPut('projectsFolder', d);
                drawProjMenu();
            } catch (e) { /* cancelled */ }
        });
    }
    function closeProjMenu() { $('projMenu').hidden = true; $('projMenuBtn').setAttribute('aria-expanded', 'false'); }
    $('projMenuBtn').addEventListener('click', e => {
        e.stopPropagation();
        const m = $('projMenu');
        if (!m.hidden) { closeProjMenu(); return; }
        m.hidden = false;
        $('projMenuBtn').setAttribute('aria-expanded', 'true');
        // keep it on screen whichever side of the window the button is on
        m.style.left = '0px';
        const r = m.getBoundingClientRect();
        if (window.innerWidth > 0 && r.right > window.innerWidth - 8) m.style.left = Math.round(window.innerWidth - 8 - r.right) + 'px';
        drawProjMenu();
    });
    document.addEventListener('click', e => { if (!$('projMenu').hidden && !e.composedPath().includes($('projMenu'))) closeProjMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('projMenu').hidden) closeProjMenu(); });

    // The start screen lists recent projects too: one click back to work.
    async function renderRecentStart() {
        const box = $('recentStart');
        const list = (await recentProjects()).slice(0, 6);
        if (!list.length || state.buffer) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = '<span class="muted small">Recent projects:</span> ' + list.map((r, i) => `<button type="button" class="btn small" data-i="${i}" title="${esc(r.song || '')}">${esc(r.name.replace(/\.lightseq\.json$/i, ''))}</button>`).join(' ');
        box.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => { const r = list[+b.dataset.i]; openRecent(r.handle, r.hash); }));
    }
    renderRecentStart();
    // once a song is open the start-screen list goes away
    document.addEventListener('xl:song', () => { if (state.buffer) $('recentStart').hidden = true; });

    // ---------- auto-save ----------

    try { $('autoSave').checked = localStorage.getItem('xlweb-autosave') === '1'; } catch (e) { /* storage blocked */ }
    if (!window.showSaveFilePicker) { $('autoSave').checked = false; $('autoSave').disabled = true; $('autoSave').parentElement.title = 'Auto-save needs Chrome or Edge (they can write to a file you chose)'; }
    $('autoSave').addEventListener('change', async e => {
        try { localStorage.setItem('xlweb-autosave', e.target.checked ? '1' : '0'); } catch (err) { /* storage blocked */ }
        if (!e.target.checked) clearTimeout(markDirty.t);
        if (!e.target.checked || !state.buffer) return;
        // turning it on saves now, choosing the file first if there isn't one yet
        if (state.projectDirty || !state.projectHandle) await saveProject(false);
        else setProjStatus('Auto-save on: changes save by themselves to ' + state.projectHandle.name);
    });
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(e.shiftKey); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pickProject(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && state.buffer) { e.preventDefault(); if (window.XLSeq) XLSeq.openExport(); }
    });

    // ---------- tabs ----------

    function showTab(name) {
        document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
        document.querySelectorAll('.tabpane').forEach(p => { p.hidden = p.dataset.pane !== name; });
        if (name === 'song') requestAnimationFrame(draw);
        document.dispatchEvent(new CustomEvent('xl:tab', { detail: name }));
    }
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

    // The sequence builder (sequi.js) reads the song through this.
    window.XLWeb = {
        state,
        buildXTiming,
        time: () => currentTime(),
        playing: () => state.play.playing,
        seek: t => seek(t, true),
        play: () => { if (!state.play.playing) play(); },
        stop: () => stop(),
        rate: () => state.play.rate || 1,
        setRate: r => {
            const was = state.play.playing;
            if (was) stop();
            state.play.rate = r;
            if (was) play();
        },
        splitSection: (id, t) => splitSection(id, t),
        mergeWithNext: id => mergeWithNext(id),
        renameSection: (id, name) => renameSection(id, name),
        sectionAt: t => sectionAtTime(t),
        projectData: () => projectData(),
        song: () => state.grid && { model: state.model, grid: state.grid, sections: state.grid.sections, lyr: state.lyr, fileName: state.fileName, fileFull: state.fileFull, hash: state.hash },
        // test hooks: open a project from a file handle; save as if Save project were pressed
        openProjectHandle: (h, hash) => openRecent(h, hash || null),
        saveProject: (auto) => saveProject(false, !!auto),
        setProjectHandle: h => { state.projectHandle = h; },
        projectState: () => ({ dirty: state.projectDirty, handle: state.projectHandle ? state.projectHandle.name : null, status: $('projStatus').textContent }),
        loadUrl: async (url) => {
            state.fileFull = decodeURIComponent(url.split('/').pop());
            state.fileName = state.fileFull.replace(/\.[^.]+$/, '');
            const r = await fetch(url);
            await loadArrayBuffer(await r.arrayBuffer());
        },
    };
})();
