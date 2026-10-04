'use strict';

// The plan's control boxes (How this works, Ideas, Change what's planned, View):
// each can be folded to its title, and, with the layout unlocked, dragged or
// nudged into another order. Locked by default so nothing moves by accident.
// Order, folded boxes and the lock are kept in this browser.
(() => {
    const $ = id => document.getElementById(id);
    const stack = $('ctlStack');
    if (!stack) return;
    const KEY = 'xlweb-ctl-layout', LOCK = 'xlweb-ctl-locked';
    const blocks = () => [...stack.querySelectorAll(':scope > .ctl-group[data-block]')];
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } };
    const save = () => {
        const data = { order: blocks().map(b => b.dataset.block), min: blocks().filter(b => b.classList.contains('min')).map(b => b.dataset.block) };
        try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* storage blocked */ }
    };
    let locked = true;
    try { locked = localStorage.getItem(LOCK) !== '0'; } catch (e) { /* storage blocked */ }

    // give every box its fold button, its body wrapper and its move controls
    for (const b of blocks()) {
        const head = b.querySelector(':scope > .ctl-head');
        const body = document.createElement('div');
        body.className = 'ctl-body';
        while (head.nextSibling) body.appendChild(head.nextSibling);
        b.appendChild(body);
        const title = head.querySelector('h3').textContent;
        const fold = document.createElement('button');
        fold.type = 'button';
        fold.className = 'ctl-fold';
        head.prepend(fold);
        const move = document.createElement('span');
        move.className = 'ctl-move';
        move.innerHTML = `<button type="button" class="ctl-up" title="Move ${title} up" aria-label="Move ${title} up">↑</button><button type="button" class="ctl-down" title="Move ${title} down" aria-label="Move ${title} down">↓</button><span class="ctl-grip" title="Drag to move ${title}" aria-hidden="true">⠿</span>`;
        head.appendChild(move);
        const setFold = min => {
            b.classList.toggle('min', min);
            fold.textContent = min ? '▸' : '▾';
            fold.title = min ? `Show ${title}` : `Minimize ${title}`;
            fold.setAttribute('aria-expanded', String(!min));
        };
        setFold(false);
        fold.addEventListener('click', () => { setFold(!b.classList.contains('min')); save(); });
        head.querySelector('h3').addEventListener('dblclick', () => { setFold(!b.classList.contains('min')); save(); });
        b._setFold = setFold;
        move.querySelector('.ctl-up').addEventListener('click', () => { const p = b.previousElementSibling; if (p) { stack.insertBefore(b, p); save(); b.querySelector('.ctl-up').focus(); } });
        move.querySelector('.ctl-down').addEventListener('click', () => { const n = b.nextElementSibling; if (n) { stack.insertBefore(n, b); save(); b.querySelector('.ctl-down').focus(); } });
        // drag by the grip only, so text and controls inside still work normally
        const grip = move.querySelector('.ctl-grip');
        grip.addEventListener('pointerdown', e => {
            if (locked || e.button !== 0) return;
            e.preventDefault();
            grip.setPointerCapture(e.pointerId);
            b.classList.add('dragging');
            const onMove = ev => markDrop(b, ev.clientX, ev.clientY);
            const onUp = () => {
                grip.removeEventListener('pointermove', onMove);
                grip.removeEventListener('pointerup', onUp);
                grip.removeEventListener('pointercancel', onUp);
                const over = stack.querySelector('.drop-before, .drop-after');
                if (over) stack.insertBefore(b, over.classList.contains('drop-after') ? over.nextElementSibling : over);
                b.classList.remove('dragging');
                clearMarks();
                save();
            };
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
            grip.addEventListener('pointercancel', onUp);
        });
    }

    // restore the saved order and folds
    const saved = load();
    if (Array.isArray(saved.order)) {
        for (const id of saved.order) { const b = stack.querySelector(`:scope > [data-block="${id}"]`); if (b) stack.appendChild(b); }
    }
    for (const b of blocks()) b._setFold(Array.isArray(saved.min) && saved.min.includes(b.dataset.block));

    // dropping: before or after the box under the pointer
    function clearMarks() { blocks().forEach(x => x.classList.remove('drop-before', 'drop-after')); }
    function markDrop(dragged, x, y) {
        clearMarks();
        const over = blocks().find(o => { if (o === dragged) return false; const r = o.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
        if (!over) return;
        const r = over.getBoundingClientRect();
        // wide boxes split top/bottom, half-width ones left/right
        const after = r.width > r.height * 2.2 ? y > r.top + r.height / 2 : x > r.left + r.width / 2;
        over.classList.add(after ? 'drop-after' : 'drop-before');
    }

    function setLocked(v) {
        locked = v;
        stack.classList.toggle('unlocked', !v);
        const btn = $('layoutLock');
        btn.textContent = v ? '🔒 Layout locked' : '🔓 Arranging… (click to lock)';
        btn.title = v ? 'Unlock to move the boxes below around' : 'Lock the layout so nothing moves by accident';
        btn.setAttribute('aria-pressed', String(v));
        btn.classList.toggle('on', !v);
        $('layoutReset').hidden = v;
        try { localStorage.setItem(LOCK, v ? '1' : '0'); } catch (e) { /* storage blocked */ }
    }
    $('layoutLock').addEventListener('click', () => setLocked(!locked));
    $('layoutReset').addEventListener('click', () => {
        for (const id of ['intro', 'ideas', 'change', 'view']) { const b = stack.querySelector(`:scope > [data-block="${id}"]`); if (b) stack.appendChild(b); }
        for (const b of blocks()) b._setFold(false);
        save();
    });
    setLocked(locked);
})();
