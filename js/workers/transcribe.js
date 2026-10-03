// Module worker: Whisper speech recognition with word timestamps
// (Transformers.js). Audio arrives as 16 kHz mono windows, each already cut
// at a gap in the singing, so no word is split and long instrumental stretches
// never reach the model (that is where Whisper invents text).
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

let asr = null, loadedModel = null, device = null;
const post = (type, data = {}) => self.postMessage({ type, ...data });

async function load(model) {
    if (asr && loadedModel === model) return;
    device = (self.navigator && navigator.gpu && await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm';
    const files = {};
    asr = await pipeline('automatic-speech-recognition', model, {
        device,
        dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: x => {
            if (x.status === 'progress' && x.total) {
                files[x.file] = [x.loaded, x.total];
                let l = 0, t = 0;
                for (const k in files) { l += files[k][0]; t += files[k][1]; }
                post('download', { loaded: l, total: t });
            }
        },
    });
    loadedModel = model;
}

self.onmessage = async (e) => {
    const { model, windows, multilingual } = e.data;
    try {
        post('status', { text: 'Loading speech model' });
        await load(model);
        post('status', { text: `Listening for words (${device === 'webgpu' ? 'GPU' : 'CPU'})` });
        const words = [];
        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
            if (multilingual) opts.task = 'transcribe';
            const r = await asr(w.audio, opts);
            for (const c of r.chunks || []) {
                const [s, en] = c.timestamp;
                if (s == null) continue;
                words.push({ text: c.text.trim(), s: w.t0 + s, e: w.t0 + (en ?? s + 0.2) });
            }
            post('progress', { value: (i + 1) / windows.length });
        }
        post('done', { words, device });
    } catch (err) {
        post('error', { message: String(err && err.message || err) });
    }
};
