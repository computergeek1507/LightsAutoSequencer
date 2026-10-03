// Local web server for the sequencer: node serve.js [port] [--media <dir>] [--show <dir>]
//
// The page must be served (not opened as a file) because the voice separation
// and speech models need cross-origin isolation for multi-threaded WebAssembly.
// --media / --show mount a song folder at /media/ and a show folder at /show/
// (testing only; the page itself reads the show through the folder picker).
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const port = parseInt(args.find(a => /^\d+$/.test(a)) || '8765', 10);
const roots = { '/': __dirname };
for (const [flag, mount] of [['--media', '/media/'], ['--show', '/show/']]) {
    const i = args.indexOf(flag);
    if (i >= 0 && args[i + 1]) roots[mount] = path.resolve(args[i + 1]);
}

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.xml': 'application/xml', '.xsq': 'application/xml', '.wasm': 'application/wasm',
};

http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') url = '/index.html';
    const prefix = Object.keys(roots).sort((a, b) => b.length - a.length).find(p => url.startsWith(p));
    const root = roots[prefix];
    const file = path.resolve(root, '.' + url.slice(prefix.length - 1));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    });
}).listen(port, '127.0.0.1', () => console.log(`xLights web sequencer: http://127.0.0.1:${port}/`));
