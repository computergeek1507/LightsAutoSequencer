'use strict';

// The steps from song to xLights, under the tabs: each ticks off when it's
// done, the next one is highlighted, and clicking one goes there.
(() => {
    const $ = id => document.getElementById(id);
    const bar = $('stepsBar');
    if (!bar) return;
    const tab = name => { const b = document.querySelector(`.tab[data-tab="${name}"]`); if (b && b.getAttribute('aria-selected') !== 'true') b.click(); };
    const go = (name, id) => { tab(name); setTimeout(() => { const el = $(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 80); };
    const planned = () => {
        const p = window.XLSeq && XLSeq.S && XLSeq.S.plan;
        return !!(p && ((p.whole && p.whole.rows.length) || Object.values(p.sections || {}).some(c => c.rows.length)));
    };
    const S = () => (window.XLSeq && XLSeq.S) || {};
    const STEPS = [
        { label: 'Song', hint: 'Load an MP3; beats and parts are found for you', done: () => !!XLWeb.song(), go: () => go('song', 'timeline') },
        { label: 'Words', optional: true, hint: 'Optional: find the words, for singing faces and lyrics on a matrix', done: () => !!(XLWeb.song() && XLWeb.song().lyr), go: () => go('song', 'vocalPanel') },
        { label: 'Your show', hint: 'Open your xLights show folder', done: () => !!S().show, go: () => go('seq', 'showPanel') },
        { label: 'Plan the lights', hint: 'Suggest a plan, then change anything you like', done: () => planned(), go: () => go('seq', 'planPanel') },
        { label: 'Export to xLights', hint: 'Export the .xsq into your show folder, then open it in xLights and render', done: () => !!(S().xsqSavedAt && (!S().planChangedAt || S().xsqSavedAt >= S().planChangedAt)), go: () => { if (window.XLSeq) XLSeq.openExport(); } },
    ];
    function draw() {
        if (!window.XLWeb || !XLWeb.song()) { bar.hidden = true; return; }
        bar.hidden = false;
        const state = STEPS.map(s => s.done());
        const next = STEPS.findIndex((s, i) => !state[i] && !s.optional);
        bar.innerHTML = STEPS.map((s, i) => {
            const cls = state[i] ? 'done' : i === next ? 'next' : '';
            const mark = state[i] ? '✓' : String(i + 1);
            const changed = i === 4 && !state[i] && S().xsqSavedAt ? ' (changed since you saved)' : '';
            return `<li class="${cls}${s.optional ? ' optional' : ''}"><button type="button" data-i="${i}" title="${s.hint}${changed}"><span class="n">${mark}</span>${s.label}${s.optional ? ' <em>optional</em>' : ''}</button></li>`;
        }).join('');
        bar.querySelectorAll('button').forEach(b => b.addEventListener('click', () => STEPS[+b.dataset.i].go()));
    }
    let t = 0;
    const later = () => { clearTimeout(t); t = setTimeout(draw, 120); };
    // any change after saving means the saved .xsq is out of date
    document.addEventListener('xl:changed', () => { if (window.XLSeq && XLSeq.S) XLSeq.S.planChangedAt = Date.now(); });
    for (const ev of ['xl:song', 'xl:lyrics', 'xl:show', 'xl:changed', 'xl:xsq', 'xl:tab']) document.addEventListener(ev, later);
    later();
})();
