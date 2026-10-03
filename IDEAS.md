# Ideas and plans

One running list for the web sequencer. New ideas get added here; when one is built it
moves to **Done** with the date.

## Open ideas

- **Pop-out preview.** Open the preview in its own window, synced to playback, for a
  second monitor. (Left over from the "edit while watching" list; the other five are
  built.)

### Using the empty space under the preview (wide screens)

The preview column ends where the preview does, while the plan keeps scrolling beside it.
Ideas for that space, roughly in order of usefulness:

1. ~~**Effect grid for the section.**~~ *(built 2026-10-03)* An xLights-style view of the section being played: one
   row per prop or group, a block for each effect over time, a playhead. Click a block to
   open its light row. It's the one view that shows the *whole* section at a glance,
   which the card list can't.
2. ~~**Transport strip.**~~ *(built 2026-10-03)* ⏮ previous section, ⏭ next section, 🔁 loop, playback speed
   (½× to check fast chases, 1×), and the beat number flashing with the beat.
3. **"Now playing" panel.** The sung line (karaoke style) and section name, plus which
   props are lit right now and by which effect; each clickable to its row.
4. **Notes.** A notes box per section ("make this build up more"), saved in the project.
5. **Show filter.** Tick prop types on or off in the preview, to judge one layer of the
   house at a time (preview only).
6. **History.** A list of the last undo steps ("Randomized Chorus 1", "Changed colours"),
   click to go back to one.

**Recommendation:** 1 and 2 first. Together they turn the left column into a mini
xLights: see the section's effects over time and move through the song fast. 3 fits
under them if room remains.

**Status:** 1 and 2 built; 3–6 open.

## Making the lights fit the music (review of 2026-10-03)

I played a default *Suggest a plan* for Dusty Bibles (feeling and intensity from the song,
same idea for repeats) and measured the preview frame by frame (3805 frames at 20 fps).

**What it does now:**

| Check | Result | What it means |
|---|---|---|
| Brightness vs loudness | correlation −0.06 | Loud and quiet parts look the same |
| Light change on beats vs between | 1.08× | The beat barely shows |
| Downbeats vs other beats | 1.37× | Bar starts show a little |
| Change at section boundaries | 9–39× the usual | Section changes are clear (good) |
| Singing vs not singing | 0.225 vs 0.215 brightness | The vocals don't show |
| Choruses vs verses | choruses *darker* (0.13 vs 0.27), less lit (33% vs 40%) | Backwards |
| Verse 4 (loud) vs Verse 7 (quiet break) | identical | Repeats ignore energy |
| Busiest part | the Outro | Should be the last chorus |

**Why:** *Same idea for repeats* copies by section name, so all 7 verses get one plan
whatever their energy. Choruses get ~7 beat rows (shockwaves and pulses) that are mostly
dark between hits, while verses get steady *On* and *Twinkle*, so verses read brighter.
Effects on every beat on every prop cancel out: when everything flashes, nothing stands
out.

**Suggestions, in order of payoff:**

1. **Energy drives the plan.** Every section gets a level from its loudness: how many props
   are lit, base brightness, how fast effects move. Choruses always brighter and fuller
   than the verses around them; quiet breaks (like Verse 7) go down to one or two props.
2. **Repeats match by energy, not just name.** *Same idea for repeats* keeps the same
   effects for a repeat but scales them: a loud verse adds props, a quiet one drops them.
3. **One beat layer, the rest steady.** In a section, put the beat on one or two prop types
   (e.g. arches pulse on the beat, mini-trees on the kick) over a steady base (wash, twinkle,
   spirals). Base layer keeps brightness up; the beat layer gives the punch.
4. **Accent the bar.** Big props (house outline, mega tree, matrix) change on downbeats only;
   small props on beats. Gives a two-level rhythm instead of everything at once.
5. **Builds and drops.** The bar or two before a chorus ramps up (brightness rising, chase
   speeding up); the chorus' first downbeat gets a flash on everything; the last chorus is
   the peak, and the ending follows the audio fade (see the endings memory).
6. **Follow the voice.** While singing: faces and matrix words lead, background dims a step;
   between lines, the background comes back. Optionally the mega tree's height follows the
   melody's pitch.
7. **Colour from the feeling.** Pick the colour scheme from the song's mood (and per
   section: warmer and brighter in choruses, cooler and softer in verses) rather than one
   scheme for everything.
8. **Fit check.** Show these numbers in the app (loudness follow, beat sync, chorus vs verse)
   as a small score under *Another idea*. *Suggest* can then try several ideas quietly and
   keep the one that scores best.

**Recommendation:** 1, 2 and 3 together (they fix most of the table), then 5 and 8.

**Status:** 1, 2, 3, 4, 5 and 8 built (2026-10-03, see Done). Open: **6** (follow the voice)
and **7** (colour from the feeling).

**Result on Dusty Bibles**, rendered in xLights and measured with the benchmark from his own
sequences (targets from his finished shows in brackets):

| | old Suggest | new Suggest |
|---|---|---|
| Fit score in the app | 2 | 97-99 |
| Median vs mean brightness (median below mean = room to punch) | 67 > 59 | 39-70 < 58-81 |
| Drum hits that show (≥ 45%) | 15% | 41-46% |
| Brightness follows loudness, r (0.40-0.60) | 0.37 | 0.40-0.43 |
| Dark time (5-10%) | 8% | 1-3% |

Still to watch: dark time is a little low (the house is rarely fully off) and the mean is
brighter than his references; a *Feeling* of Peaceful or a lower *Intensity* brings both
down.

## Second look: from "fits the music" to "looks like Ryan's" (review of 2026-10-03)

Watched a fresh default *Suggest* on Dusty Bibles (fit 98, words found) and measured what the
fit score can't see. The timing side is now right: quiet start, build, held breath, flash
into the chorus, whole-house hits, fade at the end. What's missing is taste, and most of it is
already written down in his own notes (sequence-aesthetics, prop feedback, Dusty Bibles
feedback):

| What I saw | Measured | His rule |
|---|---|---|
| Quiet parts are mostly a green block on the matrix | matrix = 63-65% of all light in Verse 1, 1 b, 7; 45% in choruses | Matrix is for content (lyrics in the chorus), not full-field fills; a butterfly there once made a quiet break brighter than the choruses |
| Every part has the same colour mix | red/green/blue ≈ 38/37/25 in every loud part | Tiny palette per part; alternate red and green between verses and bar by bar in a chorus; blue for quiet parts |
| A chorus is 12 props doing 8 different effects | chase, butterfly, bars, wash, marquee, twinkle, pinwheel, on | One house style per song: *shape-matched* for gentle songs (pinwheel on spinners, spirals on tree and canes, shockwave on snowflakes and crosses) or *unified* (one image across props) |
| Canes, spinners, arches run as one group each | "All CandyCanes", "All Spinners" | He rejected group canes; wants each cane on its own row, sweeps that travel and cross; spinners counter-rotating |
| The voice only moves the faces | 63-100% of each part is sung; no lyrics on the matrix | Lyrics on the matrix in the chorus (his ask); ~9 whole-house hits on the strongest sung moments, the only time the house breaks the beat |
| A part looks the same from start to end | Chorus 2 (23 s): look change start→end 0.14 | Direction or colour flips each phrase; the last chorus varies the detail |

**Suggestions, in order of payoff:**

1. **House style per song.** A *Style* choice next to Feeling: *Matched to the prop* (default
   for gentle songs) or *One picture across the house*. Matched: each prop type gets the effect
   that fits its shape; house = steady texture, yard = rhythm, big props flow, small props
   sparkle. Fewer effect types per part (2-3), shared across props.
2. **Matrix as a screen, not a light.** Lyrics on the matrix in choruses (track already there);
   a slow dim bed otherwise; never a full-brightness fill in quiet parts. Cap its share of the
   show's light (~25%).
3. **Colour story.** One or two colours per part from the scheme: red verses and green verses
   alternating, chorus hits alternating bar by bar, quiet parts in the scheme's cool colour.
4. **Props in a row travel.** Canes, arches, peace stakes, mini trees: each prop its own row,
   chases offset left to right so the light sweeps across the yard (crossing in verses,
   out-and-back in choruses, one direction in the last chorus); spinners counter-rotate. Group
   row kept for the steady base.
5. **Vocal accents.** Find the ~9 strongest sung moments (held notes, phrase peaks from the
   melody) and give each a whole-house shockwave.
6. **Phrase changes.** Every 4 or 8 bars, flip chase direction or swap the colour pair; the last
   chorus gets a variation rather than a copy.
7. **Grow the fit check** with these measures (matrix share, colour change between parts, vocal
   accents, phrase variation), so *Try a few* also prefers ideas that look like his.
8. **Small UI:** the house photo fills only about 3/4 of the preview; the rest is a black band.
   Fit the preview's width to the photo.

**Recommendation:** 1 + 4 together (they change the look most and match his strongest
feedback), then 2 and 3, then 5.

**Ryan's addition (2026-10-03):** a long part (a long chorus) should change a little where
its energy changes, automatically, without having to split it.

**Status:** built 2026-10-03: **2** as an option (*Words on the matrix in choruses*), **3**,
**8**, and Ryan's addition (see Done). Open: **1**, **4**, **5**, **6**, **7**.

Result on Dusty Bibles (xLights render, benchmark from his sequences): drum hits that show
57% (target ≥ 45%), loudness r 0.48 (his 0.40-0.60), median below mean; xLights vs preview
0.98. Dark time is still only 1% (his 5-10%).

## Going public (putting it online for everyone)

**Short answer: yes, and cheaply.** Everything runs in the visitor's own browser (analysis,
voice separation, speech model, preview, export), so a public site is just static files:
no server doing work, no song or show uploaded, nearly free hosting.

**Hosting:** a static host that lets us set two response headers (the speech and voice
models need cross-origin isolation): Cloudflare Pages or Netlify (a `_headers` file), or
Vercel (`vercel.json`). GitHub Pages can't set headers, so it would need a workaround. Each
visitor downloads the models (~400 MB) once from Hugging Face / jsDelivr, on their own
bandwidth.

**What has to happen first:**

1. ~~**Model types.**~~ *(done 2026-10-03 except DMX, image and label models)* Only the 10 types in Ryan's layout are drawn properly. Others (Icicles,
   Circle, Spinner, Wreath, Sphere, Candy Cane model, DMX, …) fall back to a single dot, so
   other people's previews would look broken. Port the rest from xLights' `src-core/models`.
2. **License.** xLights is GPLv3 and the model geometry here is ported from it; the
   phoneme mapping is Papagayo (GPLv2+). Publish the site's source under GPLv3 (e.g. a
   public GitHub repo). Everything else used (Demucs, Whisper, Transformers.js, ONNX
   Runtime, CMU dictionary) is permissively licensed.
3. **Name.** Don't call it "xLights" or make it look official. "… for xLights" is fine.
4. **Browser support.** Chrome and Edge do everything. Firefox and Safari can't open folders
   (the "pick the two files" fallback works) and the voice models may fall back to slower
   CPU paths. Say so on the page, and test there.
5. ~~**Generalize Ryan-specific defaults.**~~ *(mostly done 2026-10-03: group-by-members guessing, Prop types…, note on the page)* Idea weights come from his 44 sequences (fine as a
   starting point, but say so); the prop-type guessing relies on group names like "All
   Arches"; check the "not wired to a controller" rule on other layouts.
6. **Test with other shows.** Ask a few xLights users for their `xlights_rgbeffects.xml`;
   check the preview against their xLights and render the exported sequence there.
7. **Remove test-only bits** (`XLWeb.loadUrl`, the `--media`/`--show` server mounts) and
   add a short help/privacy page ("nothing is uploaded").
8. **Optional:** host the models ourselves (Cloudflare R2) if Hugging Face rate-limits
   heavy use; that adds a small bandwidth cost.

**Status:** waiting for Ryan's go-ahead. Publishing itself (creating the repo and the
hosting account) is his to do; I can prepare everything up to that point.

## Known weak spots

- Section names from detection are rough (verse/chorus guesses); rename them.
- Which beat starts a bar is a best guess; check it with the beat click.
- When the speech model badly mishears a song that repeats a line many times, a lyric
  line can land on the wrong repeat; drag it in the timeline's Lyrics row.
- In the preview, chases and marquees have the right pattern but can be out of step with
  xLights' own render (76–82% of bulbs match overall).
- Not exercised by testing: the browser's native folder picker, *Save into show
  folder*, and the native *Save as* dialog for projects.
- The *Feeling* and *Intensity* settings shape new ideas only; they don't change lights
  already planned.
- The fit score measures brightness, beat and loudness only. It can't judge colour, taste
  or whether a prop suits the moment, so a high score is a good start, not a verdict.

## Done

- **2026-10-03:** Projects: why opening one always asked for the MP3 (the page remembered the
  song, but the browser only re-allows reading it during a click, and the file box doesn't
  count), now one *Open* click (and *Allow on every visit* in Chrome/Edge stops it asking).
  Projects open through the picker so Save writes back in place; *Projects ▾* switcher
  (recent projects + a projects folder; also on the start screen); Save / Don't save /
  Cancel before switching or loading another song; *Auto-save*; Undo/Redo now count as
  changes. Dark mode: Auto / Light / Dark menu (app and guide).
- **2026-10-03:** Ready for other people's shows (tested on the vendor "Wizards in Winter"
  traditional layout, 155 models, 160 groups):
  - Preview draws circles, icicles (with height and shear, so peak icicles hang straight),
    candy canes, spinners, wreaths, spheres (incl. the pre-version-8 rescale), multi-point and
    channel blocks, plus the older names (Tree 180/360/Flat, Vert/Horiz Matrix) and older
    files that store sizes in parm1/2/3. Arches now stay upright when drawn right to left.
    Still a single dot: DMX fixtures, image and label models.
  - Fixed: a prop whose kind couldn't be guessed crashed *Suggest a plan*.
  - Groups are judged by their members; small "Tree" models count as mini trees; a part of
    a prop ("Snowflake/Outline") belongs to that prop. *Prop types…* overrides any guess.
    On Ryan's show the only change: house lines now use *All House Outline* (roofline and
    verticals) instead of *All House Horizontal* (mostly window segments).
  - Page notes that ideas start from one person's style.
- **2026-10-03:** Tutorial: *How to use* page (`tutorial.html`, 11 steps plus questions and
  fixes) and an in-app *Show me around* tour (14 steps that point at the real controls,
  offered once on a first visit; `?tour=1` starts it).
- **2026-10-03:** Randomizing parts of a plan: each section card has a 🎲 tick (blue stripe
  when the next *Another idea* will change it; kept in step with *For:*), and each light row
  has a tick: untick to keep that row (🔒) through *Another idea* and *Randomize*. New
  rows skip props a kept row already covers. (*Copy to…* copies the kept state too.)
- **2026-10-03:** Changes inside long parts: where the next 4 bars are clearly louder or
  quieter than the 4 before (parts of 8+ bars, up to 3 changes), the part becomes phrases.
  Same props and effects, but each phrase lights as much as its own loudness asks, takes the
  next colour turn, and turns moving things round. Light rows get *Bars from / to*. On
  Dusty Bibles the 14-bar Outro splits into red (1-4), a near-chorus green middle with the
  words (5-10) and a quiet blue tail (11-14). *Change with the energy inside long parts*
  (on by default) turns it off.
- **2026-10-03:** Colour plan: each part uses one or two colours. Verses take turns between
  the scheme's first two (red verse, green verse), lifting parts use both with whole-house
  hits changing colour each bar, quiet parts go cool (blue for a red/green scheme).
- **2026-10-03:** *Words on the matrix in choruses* (option): the matrix shows the lyrics in
  lifting parts and is a dim, slow background everywhere else (no beat hits on it).
- **2026-10-03:** The preview shows just the house photo and the lights (no black band beside
  the photo); while lining up the photo it shows the whole area.
- **2026-10-03:** Fixed: the effect grid under the preview changed height from part to part
  while playing, which nudged the preview; it now has a fixed height (scrolls inside when a
  part has many rows), and the changing text lines no longer wrap.

- **2026-10-03:** Lights that fit the music (suggestions 1-5 and 8 above):
  - Every part's loudness sets how many props are lit and how bright (new *Brightness %* per
    light row, written as xLights' Brightness slider).
  - *Same idea for repeats* keeps a kind's effects but scales each repeat by its loudness;
    quiet breaks get their own calm look.
  - One or two prop types carry the beat over a dimmer base (big props on the bar, small on
    the beat); loud parts add a whole-house hit, alternating colours hit by hit.
  - Build-ups (new *When*: last 2 bars of the part), a held breath before a lift (*Hold a
    breath at the end*, 1.5 beats dark), a flash on the first beat (new *When*), the last
    chorus as the peak, and the lights fading with the song's own fade (*Fade at end*).
  - *Fit with the music* score under the plan (follows loudness, on the beat, loud parts
    brighter, per-part table); *Try a few, keep the best fit* makes four ideas and keeps the
    best.
- **2026-10-03:** Fixed: in exported sequences, beat and drum effects sat *under* the steady
  lights in xLights (its layer 0 is the top), so they only showed through dark bulbs. Hits
  now go above the steady rows and add to them; xLights and the preview now agree 0.96-0.996.

- **2026-10-02:** Song analysis (tempo, bars, sections, energy, drum hits) and .xtiming
  export.
- **2026-10-02:** Words and vocals: voice separation, lyrics with timing, mouth shapes,
  melody.
- **2026-10-02:** Hand-editing word timing in the timeline.
- **2026-10-02:** Make a sequence: show folder, house preview, plan editor, .xsq export.
- **2026-10-02:** Own sections (split/join/rename/drag), per-section lights, Copy to…,
  randomize, undo, project files.
- **2026-10-02:** House photo placed the way xLights places it, plus *Line up photo…*.
- **2026-10-02:** *Suggest a plan* for chosen sections only (*For:* menu); plain click on
  the strip moves the playhead, Ctrl+click opens the section.
- **2026-10-03:** *Feeling* (from the song, peaceful, joyful, playful, powerful, magical)
  and *Intensity* (from the song, or very calm … full on) for ideas.
- **2026-10-03:** Colour schemes you can add, edit, rename and delete, with random
  schemes (per scheme or new) and *Back to the default schemes*; saved in the browser and
  in project files.
- **2026-10-03:** Edit while watching:
  1. Preview pinned beside the plan on wide screens, pinned on top (smaller) on narrow
     ones.
  2. *🔁 Loop* per section; *Randomize* loops the section it changed.
  3. Hovering a light row outlines its props on the house; *Solo* / *Mute* per row
     (preview only, the saved sequence keeps everything).
  4. Click a prop on the house: what lights it now, add lights for it or one of its
     groups, or use it for randomizing. Drag a box to pick several props.
  5. Light rows collapse to one line; click to open the settings.
- **2026-10-03:** Projects find their song by themselves (remembered file, music folder or
  show folder); opening a project reports what it is doing in a banner at the top.
- **2026-10-03:** *Leave out of ideas…*: props, groups or parts that Suggest / Another
  idea / Randomize never use.
- **2026-10-03:** Fixed: peace stakes drawn too narrow (cube models use xLights' raw units);
  row arrow not closing settings; jumping to a section hiding it under the pinned preview.
- **2026-10-03:** The show folder used last time reconnects by itself (quietly if the
  browser still allows it, else on opening *Make a sequence*); the panel then shrinks to one
  line with *Choose a different folder…*.
- **2026-10-03:** ⏮ back-to-start button (and Home key) by Play.
- **2026-10-03:** *🎨 Change colours…*: give planned lights a different colour scheme without
  touching effects, for chosen sections, previewed before *Apply*, one undo step.
- **2026-10-03:** *Prop mix…*: per prop (or added prop/group) and per kind of section,
  Never / Less / Normal / More / Always for *Suggest a plan* and *Randomize*.
- **2026-10-03:** Effect grid under the preview (rows of props, effect blocks over the
  section, bar lines, playhead; click a block to open its row, empty space to play from
  there) and a transport strip (prev/next section, play, loop, ½× / ¾× / 1× speed, bar and
  beat counter).
