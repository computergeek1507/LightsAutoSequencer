'use strict';

// Light / dark / follow the computer. Runs in <head> so the page never
// flashes the wrong colours; the choice is kept in this browser.
(() => {
    const KEY = 'xlweb-theme';
    const root = document.documentElement;
    const get = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } };
    const apply = t => {
        if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
        document.dispatchEvent(new CustomEvent('xl:theme'));
    };
    apply(get());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (get() === 'auto') apply('auto'); });
    document.addEventListener('DOMContentLoaded', () => {
        const sel = document.getElementById('themeSel');
        if (!sel) return;
        sel.value = get();
        sel.addEventListener('change', () => {
            try { localStorage.setItem(KEY, sel.value); } catch (e) { /* storage blocked */ }
            apply(sel.value);
        });
    });
})();
