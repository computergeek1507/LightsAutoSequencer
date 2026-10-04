'use strict';

// The effect library. Each effect has two halves that must agree:
//   * render(): an approximation drawn in the browser preview
//   * settings(): the xLights settings string written into the .xsq
// The settings strings are lifted from working effects in real sequences
// (an invented settings string renders nothing in xLights, silently).
//
// Renderers work in each row's buffer: every node has u,v in 0..1 (left->right,
// bottom->top) and its order k along the row. out[] receives r,g,b 0..255.
const Effects = (() => {
    const ADD = ',T_CHOICE_LayerMethod=Additive';

    const frac = x => x - Math.floor(x);
    const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
    function hash(n) {
        n = (n ^ 61) ^ (n >>> 16);
        n = Math.imul(n, 9);
        n ^= n >>> 4;
        n = Math.imul(n, 0x27d4eb2d);
        n ^= n >>> 15;
        return (n >>> 0) / 4294967296;
    }

    // Smoothly through the palette; f in [0, n)
    function palBlend(pal, f, out, o, b = 1) {
        const n = pal.length;
        const i = ((Math.floor(f) % n) + n) % n, j = (i + 1) % n, w = f - Math.floor(f);
        const a = pal[i], c = pal[j];
        out[o] = (a[0] + (c[0] - a[0]) * w) * b;
        out[o + 1] = (a[1] + (c[1] - a[1]) * w) * b;
        out[o + 2] = (a[2] + (c[2] - a[2]) * w) * b;
    }
    function palPick(pal, i, out, o, b = 1) {
        const c = pal[((i % pal.length) + pal.length) % pal.length];
        out[o] = c[0] * b; out[o + 1] = c[1] * b; out[o + 2] = c[2] * b;
    }

    const fadeOf = (p, fin, fout) => {
        let b = 1;
        if (fin > 0) b = Math.min(b, p.sec / fin);
        if (fout > 0) b = Math.min(b, (p.dur - p.sec) / fout);
        return clamp01(b);
    };

    const fades = o => (o.fadeIn ? `,T_TEXTCTRL_Fadein=${o.fadeIn}` : '') + (o.fadeOut ? `,T_TEXTCTRL_Fadeout=${o.fadeOut}` : '');

    const CHASE_DIRS = ['Left-Right', 'Right-Left', 'From Middle', 'To Middle', 'Bounce from Left'];

    const LIST = [
        {
            id: 'on', label: 'Solid colour', xl: 'On', use: ['part', 'hit'],
            // start/end: brightness at the start and end of the effect (a ramp when they differ)
            options: { fadeIn: 0, fadeOut: 0, start: 100, end: 100 },
            settings: o => `E_TEXTCTRL_Eff_On_End=${o.end ?? 100},E_TEXTCTRL_Eff_On_Start=${o.start ?? 100}` + fades(o),
            render(p, N, out) {
                const s0 = p.o.start ?? 100, s1 = p.o.end ?? 100;
                const b = fadeOf(p, p.o.fadeIn, p.o.fadeOut) * (s0 + (s1 - s0) * p.t) / 100;
                for (let k = 0; k < N.n; k++) palPick(p.pal, 0, out, 3 * k, b);
            },
        },
        {
            // hitColour: each hit takes the next palette colour (written per effect in the .xsq)
            id: 'pulse', label: 'Flash and fade', xl: 'On', use: ['hit'], hitColour: true,
            options: {},
            settings: () => 'E_TEXTCTRL_Eff_On_End=0,E_TEXTCTRL_Eff_On_Start=100',
            render(p, N, out) {
                const b = 1 - p.t;
                for (let k = 0; k < N.n; k++) palPick(p.pal, p.index, out, 3 * k, b);
            },
        },
        {
            id: 'wash', label: 'Colour wash', xl: 'Color Wash', use: ['part'],
            options: { cycles: 1 },
            settings: o => `E_TEXTCTRL_ColorWash_Cycles=${(+o.cycles).toFixed(1)}`,
            render(p, N, out) {
                const f = p.t * p.o.cycles * p.pal.length;
                for (let k = 0; k < N.n; k++) palBlend(p.pal, f, out, 3 * k);
            },
        },
        {
            id: 'chase', label: 'Chase', xl: 'SingleStrand', use: ['part', 'hit'],
            options: { direction: 'Left-Right', chases: 1, rotations: 1, size: 33 },
            choices: { direction: CHASE_DIRS },
            settings: o => `E_CHECKBOX_Chase_Group_All=0,E_CHOICE_Chase_Type1=${o.direction},E_CHOICE_Fade_Type=From Head,E_CHOICE_SingleStrand_Colors=Palette,E_CHOICE_Skips_Direction=Left,E_NOTEBOOK_SSEFFECT_TYPE=Chase,E_SLIDER_Color_Mix1=${o.size},E_SLIDER_Number_Chases=${o.chases},E_SLIDER_Skips_Advance=0,E_SLIDER_Skips_BandSize=1,E_SLIDER_Skips_SkipSize=1,E_SLIDER_Skips_StartPos=1,E_TEXTCTRL_Chase_Rotations=${(+o.rotations).toFixed(1)}`,
            render(p, N, out) {
                const o = p.o, size = Math.max(0.02, o.size / 100);
                let pos = frac(p.t * o.rotations);
                for (let k = 0; k < N.n; k++) {
                    let u = N.u[k];
                    if (o.direction === 'Right-Left') u = 1 - u;
                    else if (o.direction === 'From Middle') u = Math.abs(u - 0.5) * 2;
                    else if (o.direction === 'To Middle') u = 1 - Math.abs(u - 0.5) * 2;
                    let best = 0, ci = 0;
                    for (let c = 0; c < o.chases; c++) {
                        let head = frac(pos + c / o.chases);
                        if (o.direction === 'Bounce from Left') head = 1 - Math.abs(1 - 2 * frac(p.t * o.rotations / 2 + c / o.chases));
                        const d = head - u;
                        const dd = d < 0 ? d + 1 : d;
                        if (dd <= size) { const b = 1 - dd / size; if (b > best) { best = b; ci = c; } }
                    }
                    palPick(p.pal, ci, out, 3 * k, best);
                }
            },
        },
        {
            id: 'bars', label: 'Bars', xl: 'Bars', use: ['part', 'hit'],
            options: { direction: 'up', bars: 3, cycles: 1 },
            choices: { direction: ['up', 'down', 'Left', 'Right', 'expand', 'compress'] },
            settings: o => `E_CHECKBOX_Bars_3D=0,E_CHECKBOX_Bars_Gradient=0,E_CHECKBOX_Bars_Highlight=0,E_CHOICE_Bars_Direction=${o.direction},E_SLIDER_Bars_BarCount=${o.bars},E_TEXTCTRL_Bars_Cycles=${(+o.cycles).toFixed(1)}`,
            render(p, N, out) {
                const o = p.o, n = p.pal.length, bands = Math.max(1, o.bars) * n;
                const shift = p.t * o.cycles;
                for (let k = 0; k < N.n; k++) {
                    let c;
                    switch (o.direction) {
                        case 'down': c = N.v[k] + shift; break;
                        case 'Left': c = N.u[k] + shift; break;
                        case 'Right': c = N.u[k] - shift; break;
                        case 'expand': c = Math.abs(N.v[k] - 0.5) - shift; break;
                        case 'compress': c = Math.abs(N.v[k] - 0.5) + shift; break;
                        default: c = N.v[k] - shift;
                    }
                    palPick(p.pal, Math.floor(frac(c) * bands), out, 3 * k);
                }
            },
        },
        {
            id: 'spirals', label: 'Spirals', xl: 'Spirals', use: ['part'],
            options: { count: 3, rotation: 20, thickness: 40 },
            settings: o => `E_CHECKBOX_Spirals_3D=0,E_CHECKBOX_Spirals_Blend=0,E_CHECKBOX_Spirals_Grow=0,E_CHECKBOX_Spirals_Shrink=0,E_SLIDER_Spirals_Count=${o.count},E_SLIDER_Spirals_Rotation=${o.rotation},E_SLIDER_Spirals_Thickness=${o.thickness},E_TEXTCTRL_Spirals_Movement=${(o.rotation >= 0 ? 1 : -1).toFixed(1)}`,
            render(p, N, out) {
                const o = p.o, n = p.pal.length;
                const twist = o.rotation / 10;
                const strands = Math.max(1, o.count) * n;
                for (let k = 0; k < N.n; k++) {
                    const ph = (N.u[k] + N.v[k] * twist / strands * n) * strands + p.t * strands * Math.sign(o.rotation || 1);
                    const inBand = frac(ph) < o.thickness / 100 + 0.25;
                    palPick(p.pal, Math.floor(ph), out, 3 * k, inBand ? 1 : 0);
                }
            },
        },
        {
            id: 'pinwheel', label: 'Pinwheel', xl: 'Pinwheel', use: ['part'],
            options: { arms: 3, speed: 10, twist: 0 },
            settings: o => `E_CHECKBOX_Pinwheel_Rotation=0,E_CHOICE_Pinwheel_3D=None,E_CHOICE_Pinwheel_Style=New Render Method,E_SLIDER_PinwheelXC=0,E_SLIDER_PinwheelYC=0,E_SLIDER_Pinwheel_ArmSize=100,E_SLIDER_Pinwheel_Arms=${o.arms},E_SLIDER_Pinwheel_Offset=0,E_SLIDER_Pinwheel_Speed=${o.speed},E_SLIDER_Pinwheel_Thickness=20,E_SLIDER_Pinwheel_Twist=${o.twist}`,
            render(p, N, out) {
                const o = p.o;
                const rot = p.sec * o.speed / 10;
                for (let k = 0; k < N.n; k++) {
                    const dx = N.u[k] - 0.5, dy = N.v[k] - 0.5;
                    const r = Math.hypot(dx, dy);
                    const a = (Math.atan2(dy, dx) / (2 * Math.PI) + rot + r * o.twist / 100) * o.arms;
                    const w = frac(a);
                    palPick(p.pal, Math.floor(a), out, 3 * k, w < 0.45 ? 1 - w / 0.45 * 0.6 : 0);
                }
            },
        },
        {
            id: 'twinkle', label: 'Twinkle', xl: 'Twinkle', use: ['part'],
            options: { count: 20, steps: 30 },
            settings: o => `E_CHECKBOX_Twinkle_ReRandom=1,E_CHECKBOX_Twinkle_Strobe=0,E_CHOICE_Twinkle_Style=New Render Method,E_SLIDER_Twinkle_Count=${o.count},E_SLIDER_Twinkle_Steps=${o.steps}`,
            render(p, N, out) {
                const o = p.o, period = Math.max(2, o.steps) * 0.025;
                for (let k = 0; k < N.n; k++) {
                    const s = N.seed[k];
                    const x = p.sec / period + hash(s) * 7;
                    const cyc = Math.floor(x);
                    const on = hash(s * 31 + cyc * 7919) < o.count / 100;
                    const b = on ? 1 - Math.abs(frac(x) * 2 - 1) : 0;
                    palPick(p.pal, Math.floor(hash(s + cyc) * 97), out, 3 * k, b);
                }
            },
        },
        {
            id: 'shockwave', label: 'Shockwave', xl: 'Shockwave', use: ['hit', 'part'], hitColour: true,
            options: { width: 30 },
            settings: o => `E_CHECKBOX_Shockwave_Blend_Edges=1,E_CHECKBOX_Shockwave_Scale=1,E_NOTEBOOK_Shockwave=Position,E_SLIDER_Shockwave_Accel=0,E_SLIDER_Shockwave_CenterX=50,E_SLIDER_Shockwave_CenterY=50,E_SLIDER_Shockwave_Cycles=1,E_SLIDER_Shockwave_End_Radius=100,E_SLIDER_Shockwave_End_Width=${o.width},E_SLIDER_Shockwave_Start_Radius=1,E_SLIDER_Shockwave_Start_Width=${o.width}`,
            render(p, N, out) {
                const w = Math.max(0.05, p.o.width / 100) * 0.7, R = p.t * 0.75;
                for (let k = 0; k < N.n; k++) {
                    const r = Math.hypot(N.u[k] - 0.5, N.v[k] - 0.5);
                    const b = clamp01(1 - Math.abs(r - R) / w);
                    palPick(p.pal, p.index, out, 3 * k, b);
                }
            },
        },
        {
            id: 'marquee', label: 'Marquee', xl: 'Marquee', use: ['part'],
            options: { band: 3, skip: 2, speed: 3 },
            settings: o => `E_CHECKBOX_Marquee_PixelOffsets=0,E_CHECKBOX_Marquee_Reverse=0,E_CHECKBOX_Marquee_WrapX=0,E_NOTEBOOK_Marquee=Settings,E_SLIDER_MarqueeXC=0,E_SLIDER_MarqueeYC=0,E_SLIDER_Marquee_Band_Size=${o.band},E_SLIDER_Marquee_ScaleX=100,E_SLIDER_Marquee_ScaleY=100,E_SLIDER_Marquee_Skip_Size=${o.skip},E_SLIDER_Marquee_Speed=${o.speed},E_SLIDER_Marquee_Stagger=0,E_SLIDER_Marquee_Start=0,E_SLIDER_Marquee_Thickness=1`,
            render(p, N, out) {
                const o = p.o, period = Math.max(1, o.band + o.skip);
                const shift = Math.floor(p.sec * o.speed * 4);
                for (let k = 0; k < N.n; k++) {
                    const pos = N.k[k] + shift;
                    const inBand = (pos % period) < o.band;
                    palPick(p.pal, Math.floor(pos / period), out, 3 * k, inBand ? 1 : 0);
                }
            },
        },
        {
            id: 'butterfly', label: 'Butterfly (colour swirl)', xl: 'Butterfly', use: ['part'],
            options: { speed: 10 },
            settings: o => `E_CHOICE_Butterfly_Colors=Palette,E_CHOICE_Butterfly_Direction=Normal,E_SLIDER_Butterfly_Chunks=1,E_SLIDER_Butterfly_Skip=2,E_SLIDER_Butterfly_Speed=${o.speed},E_SLIDER_Butterfly_Style=1`,
            render(p, N, out) {
                const s = p.sec * p.o.speed / 10;
                for (let k = 0; k < N.n; k++) {
                    const x = N.u[k] * 6, y = N.v[k] * 6;
                    const f = (Math.sin(x + s) + Math.sin(y * 1.3 - s * 0.8) + Math.sin((x + y) * 0.7 + s * 1.2) + 3) / 6;
                    palBlend(p.pal, f * p.pal.length, out, 3 * k);
                }
            },
        },
        {
            id: 'faces', label: 'Singing face', xl: 'Faces', use: ['vocal'], needsFace: true,
            options: { face: '' },
            settings: (o, ctx) => `E_CHECKBOX_Faces_Outline=1,E_CHOICE_Faces_EyeBlinkFrequency=Normal,E_CHOICE_Faces_Eyes=Auto,E_CHOICE_Faces_FaceDefinition=${o.face},E_CHOICE_Faces_TimingTrack=${ctx.lyricTrack},T_TEXTCTRL_Fadein=.2,T_TEXTCTRL_Fadeout=.3`,
            render(p, N, out) {
                // Faces are drawn per model by the renderer (it needs node numbers).
            },
        },
        {
            id: 'lyrictext', label: 'Show the words', xl: 'Text', use: ['vocal'],
            options: { size: 20 },
            // 'Use OS Fonts' is the only safe font choice: any other value goes to
            // the bitmap-font path, where an unknown name crashes xLights.
            settings: (o, ctx) => `E_CHECKBOX_TextToCenter=1,E_CHOICE_Text_Count=none,E_CHOICE_Text_Dir=none,E_CHOICE_Text_Effect=normal,E_CHOICE_Text_Font=Use OS Fonts,E_FONTPICKER_Text_Font=Arial Black ${Math.round(o.size)},E_CHECKBOX_Text_Color_PerWord=0,E_CHOICE_Text_LyricTrack=${ctx.lyricTrack} - Words,E_SLIDER_Text_XStart=0,E_SLIDER_Text_YStart=0,E_TEXTCTRL_Text=,E_TEXTCTRL_Text_Speed=0`,
            render(p, N, out) {
                const word = p.word;
                if (!word) return;
                const g = textMask(word, N.w || 96, N.h || 50, p.o.size);
                for (let k = 0; k < N.n; k++) {
                    const x = Math.min(g.w - 1, Math.floor(N.u[k] * (g.w - 1) + 0.5));
                    const y = Math.min(g.h - 1, Math.floor((1 - N.v[k]) * (g.h - 1) + 0.5));
                    const a = g.data[y * g.w + x];
                    if (a) palPick(p.pal, 0, out, 3 * k, a);
                }
            },
        },
    ];

    // ---------- moving heads (DMX) ----------
    //
    // xLights' Moving Head effect: per fixture a list of "Name: value" commands
    // (MovingHeadEffect::RenderMovingHead). The pattern maths is
    // CalculatePatternPoint / CalculatePatternPositions, ported for the preview.

    const MH_PATTERNS = ['Circle', 'Eight', 'Line', 'Diamond', 'Square', 'Leaf', 'Lissajous', 'Still'];
    function mhPatternPoint(alg, it) {
        const h = Math.PI / 2, pi = Math.PI;
        switch (alg) {
            case 'Eight': return [Math.cos(it * 2 + h), Math.cos(it)];
            case 'Line': return [Math.cos(it), Math.cos(it)];
            case 'Diamond': return [Math.cos(it - h) ** 3, Math.cos(it) ** 3];
            case 'Square':
                if (it < pi / 2) return [(it * 2 / pi) * 2 - 1, 1];
                if (it < pi) return [1, (1 - (it - pi / 2) * 2 / pi) * 2 - 1];
                if (it < pi * 1.5) return [(1 - (it - pi) * 2 / pi) * 2 - 1, -1];
                return [-1, ((it - pi * 1.5) * 2 / pi) * 2 - 1];
            case 'Leaf': return [Math.cos(it + h) ** 5, Math.cos(it)];
            case 'Lissajous': return [Math.cos(2 * it - h), Math.cos(3 * it)];
            default: return [Math.cos(it + h), Math.cos(it)];
        }
    }
    // Where a head points (degrees) at time p.t, for head number `slot` (0-based).
    function mhAim(o, t, slot) {
        if (o.pattern === 'Still') return { pan: +o.pan + (slot - 0) * 0, tilt: +o.tilt };
        let prog = t * (+o.cycles || 1) + slot * (+o.spread || 0) / 360;
        prog -= Math.floor(prog);
        const [x, y] = mhPatternPoint(o.pattern, prog * 2 * Math.PI);
        return { pan: +o.pan + x * (+o.width || 0), tilt: +o.tilt + y * (+o.height || 0) };
    }
    const hsv = hex => {
        const [r, g, b] = hexToRgb(hex).map(v => v / 255);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let h = 0;
        if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h /= 6; if (h < 0) h += 1;
        return [h, mx ? d / mx : 0, mx];
    };
    function mhCommands(o, colors, heads) {
        const f = v => (+v).toFixed(1);
        const cmds = [`Pan: ${f(o.pan)}`, `Tilt: ${f(o.tilt)}`, 'PanOffset: 0.0', 'TiltOffset: 0.0', 'Groupings: 1', `Cycles: ${f(o.cycles || 1)}`, `Heads: ${heads.join(',')}`];
        if (o.pattern !== 'Still') {
            cmds.push(`Pattern: ${o.pattern}`, `PatternWidth: ${f(o.width)}`, `PatternHeight: ${f(o.height)}`, `PatternXOffset: ${f(o.pan)}`, `PatternYOffset: ${f(o.tilt)}`, `PatternPhaseOffset: ${f(o.spread || 0)}`);
            if (o.pattern === 'Lissajous') cmds.push('PatternXFreq: 2.0', 'PatternYFreq: 3.0', 'PatternXPhase: 90.0', 'PatternYPhase: 0.0');
        }
        const cols = (colors && colors.length ? colors : ['#FFFFFF']).map(c => hsv(c).map(v => v.toFixed(6)).join(','));
        cmds.push(`Color: ${cols.join(',')}`);
        const d = Math.max(0, Math.min(1, (+o.dimmer || 0) / 100)).toFixed(6);
        cmds.push(`Dimmer: 0.000000,${d},1.000000,${d}`);
        cmds.push('Shutter: On');
        return cmds.join(';');
    }

    LIST.push({
        id: 'moving', label: 'Moving head', xl: 'Moving Head', use: ['part', 'hit'], dmx: true,
        options: { pattern: 'Circle', width: 45, height: 20, pan: 0, tilt: 0, cycles: 1, spread: 45, dimmer: 100 },
        choices: { pattern: MH_PATTERNS },
        labels: { width: 'Pattern width °', height: 'Pattern height °', cycles: 'Rounds per part' },
        // one block of commands per fixture the row reaches (xLights reads MH1..MH8)
        settings: (o, ctx) => {
            const heads = ctx.show && ctx.fx ? Show.movingHeadsIn(ctx.show, ctx.fx.target).map(m => m.mh.fixture) : [1];
            const list = [...new Set(heads.length ? heads : [1])].sort((a, b) => a - b);
            return list.map(n => `E_TEXTCTRL_MH${n}_Settings=${mhCommands(o, ctx.fx ? ctx.fx.colors : null, list).replace(/,/g, '&comma;')}`).join(',');
        },
        render(p, N, out) {
            const o = p.o;
            const n = p.pal.length;
            const f = n > 1 ? (p.t * (+o.cycles || 1) % 1) * (n - 1) : 0;
            const tmp = [0, 0, 0];
            palBlend(p.pal, f, tmp, 0);
            const d = Math.max(0, Math.min(1, (+o.dimmer || 0) / 100));
            for (let k = 0; k < N.n; k++) {
                const aim = mhAim(o, p.t, k);
                out[3 * k] = tmp[0] * d; out[3 * k + 1] = tmp[1] * d; out[3 * k + 2] = tmp[2] * d;
                mhState[N.g[k]] = { pan: aim.pan, tilt: aim.tilt, r: tmp[0] * d, g: tmp[1] * d, b: tmp[2] * d };
            }
        },
    });
    // where each moving head points this frame, by light index (read by the viewer)
    let mhState = {};

    // On a group row: shapes that belong to one prop (a pinwheel, a ring, a
    // marquee round a window) run on each model separately by default; things
    // that travel (chases, washes) run across the whole yard.
    // (moving heads too: xLights only runs the Moving Head effect on each head's own buffer)
    const PER_MODEL = new Set(['bars', 'spirals', 'pinwheel', 'shockwave', 'marquee', 'moving']);
    for (const e of LIST) e.perModel = PER_MODEL.has(e.id);

    const BY_ID = new Map(LIST.map(e => [e.id, e]));

    // Rasterised words for the Text preview, cached.
    const textCache = new Map();
    // xLights draws the font with one point per buffer cell (measured against
    // its own render of the same word on the matrix).
    function textMask(word, w, h, pt) {
        const key = word + '|' + w + 'x' + h + '|' + pt;
        let m = textCache.get(key);
        if (m) return m;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        let size = pt || h * 0.7;
        g.font = `900 ${size}px Arial Black, Arial, sans-serif`;
        const tw = g.measureText(word).width;
        if (tw > w * 0.95) { size *= w * 0.95 / tw; g.font = `900 ${size}px Arial Black, Arial, sans-serif`; }
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(word, w / 2, h / 2);
        const d = g.getImageData(0, 0, w, h).data;
        const data = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) data[i] = d[i * 4 + 3] / 255;
        m = { w, h, data };
        if (textCache.size > 300) textCache.clear();
        textCache.set(key, m);
        return m;
    }

    // ---------- colours ----------

    const DEFAULT_SCHEMES = [
        { id: 'christmas', label: 'Christmas', colors: ['#FF1414', '#14E632', '#FFFFFF'] },
        { id: 'candycane', label: 'Candy cane', colors: ['#FF1414', '#FFFFFF'] },
        { id: 'icy', label: 'Icy', colors: ['#FFFFFF', '#8FD6FF', '#2A6BAF'] },
        { id: 'warm', label: 'Warm white', colors: ['#FFF3D6', '#FF9A3C', '#FFD9A0'] },
        { id: 'gold', label: 'Gold', colors: ['#FFD166', '#FF9A3C', '#FFFFFF'] },
        { id: 'sacred', label: 'Silent night', colors: ['#FFFFFF', '#6FA8FF', '#B9A0FF'] },
        { id: 'neon', label: 'Neon', colors: ['#FF2FA0', '#19E0E0', '#FFE14D'] },
        { id: 'fire', label: 'Fire', colors: ['#FF2A00', '#FF8A00', '#FFD400'] },
        { id: 'rainbow', label: 'Rainbow', colors: ['#FF0000', '#FF8000', '#FFFF00', '#00FF00', '#0080FF', '#8000FF'] },
        { id: 'white', label: 'White', colors: ['#FFFFFF'] },
    ];

    // The user's own list of schemes (add / edit / remove), kept in the browser
    // and in project files. Rows copy the colours, so editing a scheme later
    // does not change lights already planned.
    const SCHEME_KEY = 'xlweb-schemes';
    const cloneSchemes = list => list.map(s => ({ id: s.id, label: s.label, colors: s.colors.slice() }));
    let schemes = cloneSchemes(DEFAULT_SCHEMES);
    try {
        const saved = JSON.parse(localStorage.getItem(SCHEME_KEY) || 'null');
        if (Array.isArray(saved) && saved.length && saved.every(s => s && s.id && Array.isArray(s.colors) && s.colors.length)) schemes = cloneSchemes(saved);
    } catch (e) { /* defaults */ }

    function setSchemes(list) {
        schemes = cloneSchemes(list && list.length ? list : DEFAULT_SCHEMES);
        try { localStorage.setItem(SCHEME_KEY, JSON.stringify(schemes)); } catch (e) { /* storage blocked */ }
        document.dispatchEvent(new CustomEvent('xl:schemes'));
    }
    const resetSchemes = () => setSchemes(DEFAULT_SCHEMES);

    // ---------- random colour schemes that still look deliberate ----------

    const HUE_NAMES = [[0, 'Red'], [18, 'Coral'], [32, 'Orange'], [48, 'Gold'], [60, 'Yellow'], [90, 'Lime'], [130, 'Green'], [160, 'Mint'],
        [180, 'Teal'], [195, 'Aqua'], [212, 'Sky'], [232, 'Blue'], [255, 'Indigo'], [275, 'Violet'], [300, 'Magenta'], [325, 'Pink'], [345, 'Rose'], [360, 'Red']];
    const hueName = h => { h = ((h % 360) + 360) % 360; let best = HUE_NAMES[0]; for (const n of HUE_NAMES) if (Math.abs(n[0] - h) < Math.abs(best[0] - h)) best = n; return best[1]; };
    function hsl(h, s, l) {
        h = ((h % 360) + 360) % 360 / 360;
        const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
        return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    // Harmonies: analogous, complementary, triad, split-complementary, one hue + white.
    function randomScheme(rng = Math.random) {
        const h = Math.floor(rng() * 360);
        const kinds = [
            ['analogous', [h - 30, h, h + 30]],
            ['complementary', [h, h + 180]],
            ['triad', [h, h + 120, h + 240]],
            ['split', [h, h + 150, h + 210]],
            ['mono', [h]],
        ];
        const [kind, hues] = kinds[Math.floor(rng() * kinds.length)];
        const colors = hues.map(x => hsl(x, 0.85 + rng() * 0.15, 0.48 + rng() * 0.1));
        if (kind === 'mono') colors.push(hsl(h, 0.9, 0.75));
        if (kind === 'mono' || rng() < 0.35) colors.push('#FFFFFF');
        const names = [...new Set(hues.map(hueName))];
        const label = names.length > 1 ? names.slice(0, 2).join(' & ') : `${names[0]} glow`;
        return { id: 'r' + Math.random().toString(36).slice(2, 8), label, colors };
    }

    const hexToRgb = h => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

    function paletteString(colors) {
        const slots = colors.slice(0, 8);
        while (slots.length < 8) slots.push('#000000');
        const parts = [];
        for (let i = 0; i < 8; i++) parts.push(`C_BUTTON_Palette${i + 1}=${slots[i]}`);
        for (let i = 0; i < Math.min(8, colors.length); i++) parts.push(`C_CHECKBOX_Palette${i + 1}=1`);
        return parts.sort().join(',');
    }

    const resetMovingHeads = () => { mhState = {}; };
    const movingHeadState = () => mhState;

    return {
        LIST, get: id => BY_ID.get(id), resetMovingHeads, movingHeadState, MH_PATTERNS,
        get SCHEMES() { return schemes; },
        DEFAULT_SCHEMES, setSchemes, resetSchemes, randomScheme,
        hexToRgb, paletteString, ADD,
    };
})();
