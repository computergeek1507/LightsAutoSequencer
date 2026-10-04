# What's new

Release notes for Lights Auto Sequencer, newest first. The same list is in the app under **✨ What's new**.

## 2026.10.04.2 — Older xLights versions

_2026-10-04_

- **New:** The page lists which xLights versions work: show folders from xLights 2021 or newer; saved sequences open in xLights 2023 or newer; moving-head effects need xLights 2024.10 or newer.
- **New:** Export option for xLights older than 2024.10: leave out the moving-head effects.
- **New:** If something goes wrong, a note says so, with Copy details to paste into Discord #bugs.
- **Better:** The show line names your layout's xLights version, and any props that couldn't be read.
- **Fixed:** One prop that can't be read (or an odd submodel or face) no longer stops the whole show from loading; very old layouts with groups in the model list load too.

## 2026.10.04 — Moving heads, a File menu and a pop-out preview

_2026-10-04_

- **New:** Moving heads: a Moving head effect (pattern, size, aim, speed, spread between heads, brightness, colours) that xLights renders with its own Moving Head effect. Tested in an xLights render.
- **New:** Moving heads are drawn in the preview as fixtures with beams that sweep in their colour.
- **New:** Moving heads box: choose which parts of the song the heads join, add or re-roll just the heads without touching anything else, and set how big they look in the preview. Each part also has + Moving heads.
- **New:** Ideas and 🎲 Randomize include moving heads: slow, small shapes in quiet parts, big fast ones in loud parts.
- **New:** File menu: open a song or project, recent projects, Save, Save as, Auto-save and Export, like any program. The project's name shows beside it, with a • while there are unsaved changes.
- **New:** ⤓ Export to xLights (Ctrl+E): one dialog to save the .xsq into your show folder or download it.
- **New:** ⧉ Pop out: the preview in its own window, handy on a second screen.
- **New:** Step tracker under the tabs: Song › Words › Your show › Plan the lights › Export, ticking off as you go.
- **New:** What's new (this list) and when the website was last updated.
- **Better:** Matrices get a layered look (a base plus a lighter effect on top), and big singing props like a snow globe get a background with the face on top.
- **Better:** Round props (snowflakes, spinners, wreaths, stars) share each other's moves, and names like "ChromaFlake" count as snowflakes.
- **Better:** Image props are drawn as their picture, glowing in the light's colour.
- **Fixed:** Moving heads set to "No Controller" in xLights were skipped by ideas and Randomize.

## 2026.10.03.2 — Tester feedback round: guide, projects, transitions and more

_2026-10-03_

- **New:** How to use guide and a Show me around tour in the app.
- **New:** More prop types in the preview: circles, icicles, candy canes, spinners, wreaths, spheres, multi-point and channel blocks, and older xLights files.
- **New:** Prop types…: tell ideas what a prop is when its name doesn't say.
- **New:** Projects: recent projects to switch between, a projects folder, and Save / Don't save / Cancel before switching. Auto-save.
- **New:** Dark mode (Auto / Light / Dark).
- **New:** 📝 Words on the matrix: put the sung words on your matrix in the parts you choose.
- **New:** Only the part that's playing: the plan shows just the part you hear and follows the song.
- **New:** The control boxes above the plan can be folded and rearranged (unlock the layout first).
- **New:** Each part shows how it comes in (ramp up, sweep in, burst, colour hit, crossfade…) and you can change it.
- **New:** Discord link for ideas, bugs and help.
- **Better:** Going into a chorus no longer goes dark and flashes white every time: each lift gets its own transition.
- **Better:** A new start screen, and the controls above the plan grouped into Ideas, Change what's planned and View.
- **Better:** Same look for parts with the same name is off by default, with a clearer explanation.
- **Fixed:** Opening a project kept asking where the MP3 is: now one click (and Chrome/Edge can allow it on every visit).
- **Fixed:** Props that aren't in your show (from another layout, or renamed) are never written into the sequence; a note offers to swap them.
- **Fixed:** Suggest a plan crashed on props whose type couldn't be guessed.

## 2026.10.03.1 — First public version

_2026-10-03_

- **New:** Load an MP3: tempo, beats, bars, song parts, loud and quiet sections and drum hits are found for you.
- **New:** Find the words: voice separation and speech recognition, matched to your lyrics, for singing faces and timing tracks.
- **New:** Open your xLights show folder and watch the plan on a preview of your own house.
- **New:** Suggest a plan and 🎲 Randomize, with feeling, intensity, colour schemes, prop mix and props to leave out.
- **New:** Lights that follow the music: louder parts brighter and fuller, the beat on one or two props, build-ups into choruses, and a fit-with-the-music score.
- **New:** Save projects, and export an .xsq for xLights with Beats, Bars, Song Parts and Lyrics timing tracks.
- **New:** Free and open source (GPLv3). Everything runs in your browser; nothing is uploaded.
