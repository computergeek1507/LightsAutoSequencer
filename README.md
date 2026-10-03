# Lights Auto Sequencer

Turn a song into an [xLights](https://xlights.org) sequence, right in your browser. An
independent tool for xLights users; not made by or affiliated with the xLights project.
Everything runs on your own computer: the song and your show folder are never uploaded.

Two tabs:

1. **Song & words**: beats, sections, energy, drum hits, lyrics with timing, melody.
   Word timing can be corrected by hand in the timeline.
2. **Make a sequence**: load your xLights show folder, choose which models, groups or
   submodels light up in each part of the song and on which musical events, watch it in
   a preview of your house, and save a `.xsq` that xLights opens and renders.

## Running it

```
node serve.js
```

then open http://127.0.0.1:8765 in Chrome or Edge and drop an MP3 on the page.

(Opening `index.html` directly still does the beat/section analysis, but finding words needs
the server: the speech and voice models run in module workers and need cross-origin
isolation, which `serve.js` turns on.) For testing, `--media <folder>` and `--show <folder>`
mount a song folder at `/media/` and a show folder at `/show/`.

## What it finds

| Output | How |
|---|---|
| **Tempo + beat grid** | Autocorrelation for a rough tempo, then a circular-concentration fit against the kick drum for precision, with a kick-gap test to fix half/double-time errors. Snaps to a whole BPM when that fits as well. |
| **Downbeats / bars** | Votes from kick vs snare (backbeat), chord changes, and big sound changes, which tend to land on bar lines. Shift it by ear with the beat click (the downbeat clicks higher). |
| **Sections** | Bar-by-bar self-similarity (chroma + timbre), a novelty curve, and boundaries snapped to bars and 4-bar phrases. Repeats are grouped (A/B/C) and named heuristically, so rename them. |
| **Energy** | Loudness level 1–5 per bar, plus a 50 ms loudness curve in the JSON. |
| **Drum hits** | Kick / snare / hi-hat / all onsets from band-limited spectral flux. |
| **Words** *(Find words & vocals)* | See below. |
| **Vocals** | When someone is singing (hysteresis gate on the separated voice) and the melody (YIN pitch tracking → notes like `A3`). |

### Words

1. **Separate the voice** with Demucs (htdemucs ONNX via `demucs-web`, WebGPU). ~40 s for a
   3-minute song on a desktop GPU; the 172 MB model is kept in the browser's Cache Storage.
2. **Transcribe** with Whisper (Transformers.js, word timestamps), fed only the stretches
   where someone is singing, so long instrumentals never reach the model.
   - `whisper-base.en` is the **clock**: its word starts sit on the singing.
   - `whisper-small.en` hears the words far better but starts them 0.2–1 s late, so it is
     only used for the **text**, and only when no lyrics were pasted.
3. **Align** the words (pasted lyrics, or what small heard) to base's timings: edit-distance
   anchors, line-aware gap filling, a snap of every start onto a real vocal onset, and
   guards so no word starts in silence or stays lit across a rest. This is a port of the
   desktop `align.py` with fixes for stray anchors (ad-libs) and missed line openers.
4. **Mouth shapes** from xLights' own CMU dictionary + Preston Blair mapping (`dict/`),
   with numbers spelled out ("2017" → twenty seventeen).

Results (voice stem and transcripts) are cached in IndexedDB per song, so a reopened song
is instant, and pasted lyrics are remembered per song.

Measured on Dusty Bibles against the reviewed lyric track: line starts median 75 ms apart,
77% within 0.25 s, 96% of words starting on a sung syllable, none starting in silence.
Weak spot: when Whisper badly mishears a song that repeats a line many times, a line can
land on the wrong repeat. Fix it in xLights after import.

### Fixing word timing

In the timeline's **Words** row, drag a word's left edge to move its start, or drag the
word to move it; drag a line in the **Lyrics** row to move the whole line. Starts snap to
vocal onsets (Alt places freely). Click a word and use ← → to nudge 10 ms (Shift 50 ms).
Ctrl+Z undoes. Edits are kept per song (keyed by word position + word), survive
"Update words" when the lyrics around them are unchanged, and can be removed in one go.

## Making a sequence

- **Show folder**: picked with the browser's folder picker (Chrome/Edge) and reopened by
  itself on later visits (quietly if the browser still allows reading it, otherwise with one
  OK when you open *Make a sequence*); or pick `xlights_rgbeffects.xml` (+ `xlights_networks.xml`, house photo) as
  files. Only read, unless you press *Save into show folder*.
- **Layout**: `js/show.js` ports xLights' model geometry (Custom, Matrix, Tree, Star,
  Single Line, Poly Line, Arches, Window Frame, Cube). Checked against a real layout:
  every prop lands on the house photo, and node numbering matches xLights exactly
  (channel-by-channel against an xLights render: canes, floods, matrix, snowflakes and
  singing faces 100% / 83–90%).
- **Sections are yours**: split a section at the playhead (from the Sections table or a
  section card), join neighbours, rename, or drag a boundary in the timeline (snaps to
  beats, Alt for free). Once edited, detection never changes them again (*Back to
  detected sections* undoes that). A split part starts with the lights of the part it
  came from.
- **House photo**: placed the way xLights places it (with *scale image* off it keeps the
  photo's proportions, fills the preview's height, anchored bottom-left; a 4:3 photo on a
  16:9 preview covers the left three-quarters). *Line up photo…* lets you drag, scroll to
  resize (Shift/Alt: width/height only), nudge with arrow keys or type numbers; the
  placement is kept per show and saved in project files.
- **Plan, per section**: every section (plus a *Whole song* layer underneath) has its
  own rows of *lights* (groups, models, submodels) → *when* (the whole time, every beat,
  first beat of a bar, kick, snare, while singing, each line, each word) → *effect* +
  colours + options. Sections are collapsible cards; click the strip under the preview to
  play from there, Ctrl+click a part (or use
  *Go to a section*) to jump there and open its card; the playing part is
  highlighted.
- **🎨 Change colours…** (whole plan, or the 🎨 on a section card) swaps only the colours to
  another scheme for the sections you pick; the preview shows it before *Apply*, *Cancel*
  puts the old colours back, Undo works after.
- **Copy to…** copies a section's lights to any others (quick picks: *All Chorus*, every
  section), replacing or adding. Copies are independent afterwards.
- **Ideas** (`js/ideas.js`): *Suggest a plan* / *Another idea* for every section, or only the
  ones chosen under *For:* (quick picks like *Only Chorus*; the rest keep their lights) (option:
  same idea for repeats of a kind), and *Randomize* per section, optionally limited to
  that section's *lights to use*. Effect choices per prop are weighted by what the
  owner's own 44 sequences use on that kind of prop, and shifted by the section's energy.
  Undo/Redo (Ctrl+Z / Ctrl+Y on this tab) step back through tries.

### Editing while watching

- Under the preview: a transport strip (previous / next section, play, loop, ½× / ¾× / 1×
  speed, bar and beat counter) and, on wide screens, an **effect grid** for the section
  that is playing: a row per prop or group, a block per effect over time, bar lines and
  the playhead. Hover a block to see it on the house, click it to open its light row,
  click empty space to play from there.

- Wide screens: the preview is pinned on the left, the plan scrolls on the right. Narrow
  screens: a smaller preview stays pinned on top.
- *🔁 Loop* on a section card plays that section over and over (moving the playhead
  elsewhere ends it). *🎲 Randomize* loops the section it changed.
- Light rows show as one line; click to open their settings. Hover a row to outline its
  props on the house. *Solo* / *Mute* change the preview only, never the saved sequence.
- Click a prop on the house to see what lights it in the playing section, add lights for
  it (or one of its groups), or use it for randomizing. Drag a box to pick several.
- Ideas take a *Feeling* (peaceful, joyful, playful, powerful, magical) and an
  *Intensity* (or both from the song). *Edit colour schemes…* adds, edits, removes or
  randomizes schemes, with a way back to the defaults. *Prop mix…* sets, per prop type (or any prop or group you
  add) and per kind of section, whether ideas use it Never / Less / Normal / More / Always.
  *Leave out of ideas…* lists props,
  groups or parts that ideas must never use (a group holding one of them is skipped too);
  clicking a prop on the house can also add it to or take it off that list.
- Ideas follow the music: each part's loudness sets how many props are lit and how bright;
  repeats share effects but scale with their loudness; one or two prop types carry the
  beat over a dimmer base, and loud parts add a whole-house hit. Before a part that lifts,
  the house builds up, holds its breath for 1.5 beats and lands with a flash; the lights
  fade when the song does.
- *Fit with the music* under the plan scores it (0-100): does the house follow loudness,
  does the beat show, are loud parts brighter. *Try a few, keep the best fit* makes four
  ideas and keeps the best one. Light rows have *Brightness %* and, for steady rows,
  *Fade at end*; each part has *Hold a breath at the end*.
- A long part changes with its energy: where the music gets clearly louder or quieter
  inside it, ideas split it into phrases (same props, more or fewer lit, the other colour,
  moving things turned round). Light rows can be limited to *Bars* from / to.
- Colours: each part uses one or two colours; verses take turns (red verse, green verse),
  choruses use both and swap them bar by bar, quiet parts go cool.
- *Words on the matrix in choruses* (option): the lyrics on the matrix in the lifting parts,
  a dim slow background on it everywhere else.
- The 🎲 tick on a section card says whether *Another idea* changes that part (same as the
  *For:* menu). The tick at the start of a light row: untick it to keep that row (🔒) when
  randomizing; new ideas fill in around it.

## Projects

*Save project* (Ctrl+S) writes `<song>.lightseq.json`: tempo grid, your sections, lyrics
with their timing and hand edits (and the voice timing they need), the whole light plan,
and the song path for xLights. The song itself is not inside, and browsers never reveal a file's folder, so the page
finds it again by itself: through the file handle the browser keeps for that song (when it
was chosen with *choose a file* or dropped, in Chrome/Edge), else by name and size in your
music folder or show folder. Only if all of that fails does a banner at the top ask you to
choose it (or pick your music folder once, so every project looks there). Chrome/Edge save back to the
same file each time (Shift+click *Save project* to save elsewhere); other browsers download
it. The page warns before closing with unsaved changes. Work is also kept in the browser
between visits, but the project file is the copy to trust.
- **Effects** (`js/effects.js`): Solid, Flash-and-fade, Colour wash, Chase, Bars,
  Spirals, Pinwheel, Twinkle, Shockwave, Marquee, Butterfly, Singing face (Faces, driven
  by the Lyrics track), Show the words (Text on a matrix, driven by the Lyrics track).
  Each has a browser renderer for the preview and an xLights settings string taken from
  working effects in real sequences. On group rows the buffer is written explicitly
  (*Per Model Default* or *Per Preview*), so xLights draws what the preview shows.
- **Preview accuracy**: rendering the exported sequence with xLights headless and
  comparing bulb by bulb at four moments, 76–82% of bulbs agree on/off; solids, faces,
  words on the matrix (95–97%) and washes match; chases and marquees have the right
  pattern but can be out of phase. The preview is a guide; xLights' render is the truth.

## Exports

- **.xtiming**: imports into xLights (timing track header → Import Timing Tracks). Pick the
  snap that matches the sequence's frame time; xLights rounds non-aligned marks down.
  The **Lyrics** track has three layers (lines / words / mouth shapes), which is what the
  Faces effect and the Text effect's lyric mode read.
- **.analysis.json**: everything, including the pitch curve, for the next steps.

Everything runs on this computer; the song is never uploaded. Models download from the
Hugging Face hub and libraries from jsDelivr the first time.

## Checked against known songs

| Song | Detected | Known |
|---|---|---|
| Dusty Bibles | 103.00 | 103 |
| No Fear | 94.00 | 94 |
| Home in My Heart | 160.00 | 160 |
| Gonna Be Alright | 76.00 (halved from 152) | 76 |

The browser's MP3 decode lines up sample-for-sample with FFmpeg (which xLights uses), so
exported marks line up with the audio in xLights.

## Files
- `js/analysis.js`: beat/section/energy analysis (no DOM)
- `js/vocals.js`: voice separation, transcription, alignment, phonemes, melody
- `js/workers/separate.js`, `js/workers/transcribe.js`: the two models, off the main thread
- `js/app.js`: page, timeline, playback and beat click, word-timing edits, timing export
- `js/show.js`: show folder access, rgbeffects parsing, model geometry, row targets
- `js/effects.js`: effect library (preview renderer + xLights settings) and colour schemes
- `js/sequence.js`: plan → timed effects, preview frame renderer, `.xsq` writer
- `js/ideas.js`: random-but-sensible light ideas for a section or the whole song
- `js/sequi.js`: the "Make a sequence" tab (show, preview, section cards, picker, copy, undo, saving)
- `dict/`: phoneme dictionaries copied from xLights (`resources/dictionaries`)
- `serve.js`: local server with the headers the models need

From the console, `XLWeb.loadUrl('/media/song.mp3')` loads a song by URL.

## License

GNU General Public License v3.0 or later (see `LICENSE`). The prop geometry in the preview
is ported from xLights (`src-core/models`, GPLv3) and the mouth-shape mapping follows
Papagayo (GPLv2 or later).

### Third-party pieces

Loaded at run time (not stored in this repository unless noted):

| Piece | Used for | License |
|---|---|---|
| [Transformers.js](https://github.com/huggingface/transformers.js) | runs the speech model | Apache 2.0 |
| [Whisper](https://github.com/openai/whisper) (base.en, small.en) | finding the words | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | runs the voice separator | MIT |
| [Demucs](https://github.com/facebookresearch/demucs) via demucs-web | separating the voice | MIT |
| [CMU Pronouncing Dictionary](http://www.speech.cs.cmu.edu/cgi-bin/cmudict) (in `dict/`) | word sounds for the singing faces | BSD-style |
