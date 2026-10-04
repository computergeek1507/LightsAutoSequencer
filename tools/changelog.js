// Builds CHANGELOG.md from releases.json (the same notes the app's What's new shows).
// Run after editing releases.json:  node tools/changelog.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const rel = JSON.parse(fs.readFileSync(path.join(root, 'releases.json'), 'utf8'));
const label = { new: 'New', better: 'Better', fixed: 'Fixed' };
let md = '# What\'s new\n\nRelease notes for Lights Auto Sequencer, newest first. The same list is in the app under **✨ What\'s new**.\n';
for (const r of rel) {
    md += `\n## ${r.version} — ${r.title}\n\n_${r.date}_\n\n`;
    for (const [t, text] of r.items) md += `- **${label[t] || t}:** ${text}\n`;
}
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), md);
console.log('CHANGELOG.md written:', rel.length, 'releases');
