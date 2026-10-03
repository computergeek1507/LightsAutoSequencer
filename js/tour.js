'use strict';

// "Show me around": a step-by-step tour that points at the real controls.
// Steps whose control isn't on screen yet (no song loaded, no show opened)
// still show, centred, and say what makes the control appear.
(() => {
    const $ = id => document.getElementById(id);
    const panelOf = sel => () => { const el = document.querySelector(sel); return el && (el.closest('.panel') || el); };
    const STEPS = [
        { tab: 'song', el: () => $('drop'), title: 'Start with a song',
          text: 'Drop an MP3 here, or choose a file. In a few seconds the app finds the tempo, beats, bars, loud and quiet parts and drum hits. Nothing is uploaded: it all runs in your browser.' },
        { tab: 'song', el: () => $('play'), need: 'a song', title: 'Play it and check the beat',
          text: 'Press Play (or Space) and tick Beat click: a click on every beat, a higher one on the first beat of each bar. Everything is built on this grid, so make sure the clicks sit on the drums.' },
        { tab: 'song', el: panelOf('#bpm'), need: 'a song', title: 'Fix the tempo if needed',
          text: 'If the clicks drift or fall between the drums: try ½ tempo or 2× tempo, Tap tempo along with the song, or change which beat starts a bar.' },
        { tab: 'song', el: panelOf('#sectionRows'), need: 'a song', title: "The song's parts",
          text: 'Verse, chorus and the rest are guesses. Rename them, split a part where the music changes, join two, or drag a boundary in the timeline. Each part gets its own lights; parts with the same name can share ideas.' },
        { tab: 'song', el: () => $('vocalPanel'), need: 'a song', title: 'Words and singing (optional)',
          text: 'For singing faces and words on a matrix, paste the lyrics if you have them and press Find words & vocals. The first time, about 400 MB of models download once; then a song takes a few minutes.' },
        { tab: 'seq', el: () => $('showPanel'), title: 'Open your xLights show',
          text: 'Choose your xLights show folder (the one with xlights_rgbeffects.xml). The app reads your props, groups, singing faces and house photo, and remembers the folder next time.' },
        { tab: 'seq', el: () => $('previewPanel'), need: 'your show', title: 'Your house',
          text: 'The preview plays your lights with the song. Click a prop to see what lights it, drag a box to pick several, and use Line up photo… if the photo sits off the lights.' },
        { tab: 'seq', el: () => $('suggestPlan'), need: 'a song and your show', title: 'Get a starting plan',
          text: 'Suggest a plan lights every part: steady looks with one or two props on the beat, brighter and fuller when the music is loud, a build-up into each chorus. 🎲 Another idea gives a different one.' },
        { tab: 'seq', el: () => $('ideaFeel') && $('ideaFeel').closest('.idea-bar'), need: 'a song and your show', title: 'Steer the ideas',
          text: 'Feeling and Intensity change the kind of effects; Colours picks the scheme. Prop mix uses props more or less, Prop types says what a prop is when its name doesn\'t, Leave out keeps props out. For: picks which parts change.' },
        { tab: 'seq', el: () => $('fitBox'), need: 'a plan', title: 'Fit with the music',
          text: 'A score for how well the lights follow the loudness and the beat, and whether loud parts are brighter. With Try a few ticked, Suggest keeps the best of four ideas.' },
        { tab: 'seq', el: () => $('plan'), need: 'a plan', title: 'Change any part by hand',
          text: 'Open a part to see its light rows: which lights, when, the effect and colours. 🔁 Loop plays one part over and over, 🎲 Randomize redoes just that part, and unticking a row keeps it when you randomize. Ctrl+Z undoes anything.' },
        { tab: 'seq', el: () => $('tStrip'), need: 'your show', title: 'Move around the song',
          text: 'Jump to the previous or next part, loop the part you are in, or slow down to ½ speed to check fast effects.' },
        { tab: 'seq', el: () => $('saveProj'), need: 'a song', title: 'Save your work',
          text: 'Save project (Ctrl+S) keeps the beat grid, your parts, the words and all the lights in a small file. Open project… brings it all back, and finds the song by itself.' },
        { tab: 'seq', el: () => $('xsqPanel'), need: 'your show', title: 'Into xLights',
          text: 'Save into show folder (or Download .xsq), then open it in xLights and render. Beats, bars, song parts and words come along as timing tracks. That\'s it: have fun!' },
    ];

    let i = -1, box = null, tip = null;
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0 && !el.closest('[hidden]');
    const showTab = name => { const b = document.querySelector(`.tab[data-tab="${name}"]`); if (b && b.getAttribute('aria-selected') !== 'true') b.click(); };

    function build() {
        box = document.createElement('div');
        box.className = 'tour-box';
        tip = document.createElement('div');
        tip.className = 'tour-tip';
        tip.setAttribute('role', 'dialog');
        tip.setAttribute('aria-live', 'polite');
        document.body.append(box, tip);
    }

    function place() {
        if (i < 0) return;
        const s = STEPS[i];
        const el = s.el();
        const ok = visible(el);
        const tw = Math.min(360, window.innerWidth - 24);
        tip.style.width = tw + 'px';
        if (!ok) {
            box.style.display = 'none';
            tip.classList.add('centre');
            tip.style.left = Math.max(12, (window.innerWidth - tw) / 2) + 'px';
            tip.style.top = Math.max(12, window.innerHeight / 2 - tip.offsetHeight / 2) + 'px';
            return;
        }
        tip.classList.remove('centre');
        const r = el.getBoundingClientRect(), pad = 6;
        const top = Math.max(4, r.top - pad), bottom = Math.min(window.innerHeight - 4, r.bottom + pad);
        Object.assign(box.style, { display: 'block', left: (r.left - pad) + 'px', top: top + 'px', width: (r.width + 2 * pad) + 'px', height: Math.max(0, bottom - top) + 'px' });
        const th = tip.offsetHeight;
        let y = bottom + 10;
        if (y + th > window.innerHeight - 8) y = top - th - 10;
        if (y < 8) y = Math.min(window.innerHeight - th - 8, Math.max(8, r.top + 12));
        let x = Math.min(Math.max(12, r.left), window.innerWidth - tw - 12);
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
    }

    function show(n) {
        if (!box) build();
        i = Math.max(0, Math.min(STEPS.length - 1, n));
        const s = STEPS[i];
        showTab(s.tab);
        // let the tab draw before measuring
        setTimeout(() => {
            const el = s.el();
            const ok = visible(el);
            if (ok) el.scrollIntoView({ block: el.offsetHeight > window.innerHeight * 0.6 ? 'start' : 'center', behavior: 'instant' });
            tip.innerHTML = `
                <div class="tour-step">${i + 1} of ${STEPS.length}</div>
                <h3>${s.title}</h3>
                <p>${s.text}</p>
                ${ok || !s.need ? '' : `<p class="tour-need">This shows up once you have ${s.need}.</p>`}
                <div class="tour-btns">
                  <button type="button" class="btn small tour-end">${i === STEPS.length - 1 ? 'Close' : 'Skip the tour'}</button>
                  <span>
                    ${i > 0 ? '<button type="button" class="btn small tour-back">Back</button>' : ''}
                    ${i < STEPS.length - 1 ? '<button type="button" class="btn small primary tour-next">Next</button>' : '<button type="button" class="btn small primary tour-end2">Done</button>'}
                  </span>
                </div>`;
            tip.querySelector('.tour-end').addEventListener('click', end);
            const b = tip.querySelector('.tour-back'); if (b) b.addEventListener('click', () => show(i - 1));
            const nx = tip.querySelector('.tour-next'); if (nx) nx.addEventListener('click', () => show(i + 1));
            const d = tip.querySelector('.tour-end2'); if (d) d.addEventListener('click', end);
            place();
            (tip.querySelector('.tour-next') || tip.querySelector('.tour-end2')).focus({ preventScroll: true });
        }, 60);
    }

    function end() {
        i = -1;
        if (box) { box.remove(); tip.remove(); box = tip = null; }
        try { localStorage.setItem('xlweb-tour-seen', '1'); } catch (e) { /* storage blocked */ }
        const w = $('tourWelcome'); if (w) w.hidden = true;
    }

    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    document.addEventListener('keydown', e => {
        if (i < 0) return;
        if (e.key === 'Escape') { e.preventDefault(); end(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); if (i < STEPS.length - 1) show(i + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); if (i > 0) show(i - 1); }
    }, true);

    $('tourBtn').addEventListener('click', () => show(0));
    $('tourStart').addEventListener('click', () => show(0));
    $('tourNo').addEventListener('click', end);
    let seen = false;
    try { seen = localStorage.getItem('xlweb-tour-seen') === '1'; } catch (e) { /* storage blocked */ }
    if (!seen) $('tourWelcome').hidden = false;
    if (/[?&]tour=1\b/.test(location.search)) show(0);
})();
