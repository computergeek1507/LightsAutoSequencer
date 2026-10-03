'use strict';

// Cross-origin isolation on hosts that can't set headers (GitHub Pages).
// The voice and speech models run much faster with it (threads need
// SharedArrayBuffer), and that needs two response headers. Loaded on the page,
// this registers itself as a service worker; as the worker, it adds the headers
// to every response. Hosts that send the headers themselves (serve.js,
// Cloudflare/Netlify via _headers) never need it, and it does nothing there.
if (typeof window === 'undefined') {
    self.addEventListener('install', () => self.skipWaiting());
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => {
        const req = e.request;
        if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
        e.respondWith(fetch(req).then(res => {
            // opaque responses can't be changed (and don't need to be)
            if (res.status === 0) return res;
            const h = new Headers(res.headers);
            h.set('Cross-Origin-Embedder-Policy', 'credentialless');
            h.set('Cross-Origin-Opener-Policy', 'same-origin');
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
        }));
    });
} else if (!window.crossOriginIsolated && window.isSecureContext && 'serviceWorker' in navigator) {
    const KEY = 'xlweb-coi-reload';
    navigator.serviceWorker.register(document.currentScript.src).then(reg => {
        // the first visit isn't controlled yet: reload once the worker is active
        const reloadOnce = () => {
            let tried = false;
            try { tried = sessionStorage.getItem(KEY) === '1'; sessionStorage.setItem(KEY, '1'); } catch (e) { /* storage blocked */ }
            if (!tried) location.reload();
        };
        if (navigator.serviceWorker.controller) {
            // controlled but still not isolated: the browser lacks support; don't loop
            return;
        }
        if (reg.active) reloadOnce();
        else navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
    }).catch(err => console.warn('Cross-origin isolation helper not registered:', err));
} else if (window.crossOriginIsolated) {
    try { sessionStorage.removeItem('xlweb-coi-reload'); } catch (e) { /* storage blocked */ }
}
