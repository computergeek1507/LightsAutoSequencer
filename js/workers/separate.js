// Module worker: splits a song into stems with Demucs (htdemucs, ONNX) and
// returns the vocals. Input must be 44.1 kHz stereo.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.bundle.min.mjs';
import { DemucsProcessor, CONSTANTS } from 'https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/src/index.js';

const MODEL_CACHE = 'xlweb-models-v1';
let processor = null;

const post = (type, data = {}) => self.postMessage({ type, ...data });

// The model is 172 MB, so keep it in the Cache API rather than re-downloading.
async function fetchModel(url) {
    let cache = null;
    try {
        cache = await caches.open(MODEL_CACHE);
        const hit = await cache.match(url);
        if (hit) {
            post('status', { text: 'Loading voice model from cache' });
            return await hit.arrayBuffer();
        }
    } catch (e) { cache = null; }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Model download failed (${resp.status})`);
    const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        post('download', { loaded: got, total });
    }
    const bytes = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
    if (cache) {
        try { await cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) { /* quota */ }
    }
    return bytes.buffer;
}

async function load() {
    if (processor) return;
    post('status', { text: 'Downloading voice model (172 MB, first time only)' });
    const model = await fetchModel(CONSTANTS.DEFAULT_MODEL_URL);
    post('status', { text: 'Starting voice model' });
    processor = new DemucsProcessor({
        ort,
        onProgress: p => post('progress', { value: p.progress ?? p }),
    });
    await processor.loadModel(model);
}

self.onmessage = async (e) => {
    const { left, right } = e.data;
    try {
        await load();
        post('status', { text: 'Separating the voice from the music' });
        const out = await processor.separate(left, right);
        const v = out.vocals;
        self.postMessage({ type: 'done', left: v.left, right: v.right }, [v.left.buffer, v.right.buffer]);
    } catch (err) {
        post('error', { message: String(err && err.message || err) });
    }
};
