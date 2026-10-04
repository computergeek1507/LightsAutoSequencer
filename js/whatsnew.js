'use strict';

// What's new: every release from releases.json (newest first), and when the
// website was last updated (the newest commit on GitHub, which is what GitHub
// Pages publishes). A dot on the button, and a one-time note for returning
// visitors, until they've looked.
(() => {
    const $ = id => document.getElementById(id);
    const SEEN = 'xlweb-seen-release';
    const REPO = 'socman1984-hub/LightsAutoSequencer';
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const LABEL = { new: 'New', better: 'Better', fixed: 'Fixed' };
    let releases = [];
    let updated = null;

    const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } };
    const day = iso => new Date(iso + 'T12:00:00').toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    const when = d => d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

    function draw() {
        $('wnUpdated').textContent = updated ? `Website last updated ${when(updated)}.` : (releases[0] ? `Latest release ${day(releases[0].date)}.` : '');
        $('wnList').innerHTML = releases.map((r, i) => `
            <section class="wn-release${i === 0 ? ' latest' : ''}">
              <h3>${esc(r.title)} <span class="muted small">${esc(day(r.date))} · ${esc(r.version)}${i === 0 ? ' · latest' : ''}</span></h3>
              <ul>${r.items.map(([type, text]) => `<li><span class="wn-tag ${esc(type)}">${esc(LABEL[type] || type)}</span>${esc(text)}</li>`).join('')}</ul>
            </section>`).join('');
    }
    function markSeen() {
        if (!releases[0]) return;
        set(SEEN, releases[0].version);
        $('whatsNewBtn').classList.remove('unseen');
        const n = $('wnNote'); if (n) n.hidden = true;
    }
    function open() { draw(); $('whatsNewDlg').showModal(); markSeen(); }

    async function load() {
        try { releases = await (await fetch('releases.json', { cache: 'no-cache' })).json(); } catch (e) { releases = []; }
        if (!releases.length) return;
        const latest = releases[0].version, seen = get(SEEN);
        if (seen !== latest) {
            $('whatsNewBtn').classList.add('unseen');
            // people who have been here before get a short note; first-timers get the tour instead
            if (seen || get('xlweb-tour-seen')) {
                $('wnNoteText').textContent = `The site was updated: ${releases[0].title}.`;
                $('wnNote').hidden = false;
            } else set(SEEN, latest);
        }
        try {
            const c = await (await fetch(`https://api.github.com/repos/${REPO}/commits?per_page=1`, { cache: 'no-cache' })).json();
            const d = c && c[0] && c[0].commit && (c[0].commit.committer || c[0].commit.author).date;
            if (d) updated = new Date(d);
        } catch (e) { /* offline or rate limited: the release date is shown instead */ }
        const f = $('footUpdated');
        if (f) f.textContent = updated ? `Last updated ${when(updated)}` : `Latest release ${day(releases[0].date)}`;
    }

    $('whatsNewBtn').addEventListener('click', open);
    $('wnClose').addEventListener('click', () => $('whatsNewDlg').close());
    $('wnNoteOpen').addEventListener('click', open);
    $('wnNoteClose').addEventListener('click', markSeen);
    const fl = $('footWhatsNew'); if (fl) fl.addEventListener('click', e => { e.preventDefault(); open(); });
    load().then(() => { if (/[?&]whatsnew=1\b/.test(location.search)) open(); });
})();
