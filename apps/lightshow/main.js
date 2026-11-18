'use strict';
/**
 * LightShow - BMW light show sequencer + DRL brightness control.
 *
 * Pages (header tabs):
 *   Strobe    pattern picker, play/stop, speed control, live light visualisation
 *   DRL       DRL brightness coding (FLM left + right)
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { fitText } = require('./kit/text-layout');
const C = require('./coding');
const { CoderLink, TARGETS } = require('./link');
const { DemoLink, ecuName } = require('./demo');
const S = require('./strobe');

const W = 1600, H = 520;
const TABS = ['Strobe', 'DRL'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const realLink = new CoderLink(ctx.signals, log);
        realLink.init().catch(function (e) { log.warn('diagnostic link: ' + e); });
        const demoLink = new DemoLink(log);
        const useDemo = function () { return settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !realLink.available); };
        const link = function () { return useDemo() ? demoLink : realLink; };

        /* ---------- state ---------- */
        var page = 0, version = 0;
        var blocks = {};           // 'ecu:did' -> byte[]
        var phase = 'idle';        // idle | reading | ready | error
        var statusMsg = '';
        var statusAt = 0;
        var writing = false;
        var lastRead = 0;

        // strobe state
        var selectedPattern = 0;
        var strobeSpeed = 1.0;     // 1.0 = normal, <1 = faster, >1 = slower
        var sequencer = new S.Sequencer(link(), log);
        var activeOnIds = [];
        sequencer.onStep = function (step, onIds) {
            activeOnIds = onIds || [];
            changed();
        };

        const changed = function () { version++; if (loop) loop.kick(); };
        const status = function (msg) { statusMsg = msg; statusAt = Date.now(); changed(); };

        /* ---------- DRL reads ---------- */
        async function readDrl() {
            if (phase === 'reading') return;
            phase = 'reading'; changed();
            var L = link();
            if (!useDemo() && !L.ready) {
                if (L.failed) { phase = 'error'; statusMsg = 'No diagnostic link (' + L.failed + ')'; }
                else phase = 'idle';
                changed();
                return;
            }
            var ok = 0;
            var ecus = [C.ECU.FLM_L, C.ECU.FLM_R];
            for (var i = 0; i < ecus.length; i++) {
                var ecu = ecus[i];
                var block = await L.readDid(ecu, '3100');
                if (block) {
                    blocks[ecu + ':3100'] = block;
                    ok++;
                }
            }
            phase = ok > 0 ? 'ready' : 'error';
            if (!ok) statusMsg = 'No FLM answered';
            lastRead = Date.now();
            changed();
        }

        async function poll() {
            if (!ui.isVisible('MAIN')) return;
            if (phase === 'reading') return;
            if (phase === 'idle' || phase === 'error' || Date.now() - lastRead > 60000) {
                await readDrl();
            }
        }
        setInterval(poll, 2000);

        /* ---------- DRL write ---------- */
        async function writeDrl(newValue) {
            if (writing) return;
            writing = true;
            status('Writing DRL brightness...');
            changed();
            var L = link();
            var opt = C.OPTIONS[0];
            var ok = true;
            var ecus = [C.ECU.FLM_L, C.ECU.FLM_R];
            for (var i = 0; i < ecus.length; i++) {
                var ecu = ecus[i];
                var key = ecu + ':3100';
                var block = blocks[key];
                if (!block) { ok = false; continue; }
                var updated = C.writeBits(block, opt, newValue);
                var wrote = await L.writeDid(ecu, '3100', updated);
                if (wrote) {
                    blocks[key] = updated;
                } else {
                    ok = false;
                }
            }
            status(ok ? 'DRL: ' + C.label(opt, newValue) : 'Write failed');
            writing = false;
            changed();
        }

        /* ---------- strobe controls ---------- */
        async function startStrobe() {
            var pat = S.PATTERNS[selectedPattern];
            if (!pat) return;
            // update sequencer link in case demo mode changed
            sequencer.link = link();
            await sequencer.start(pat, strobeSpeed);
            changed();
        }

        async function stopStrobe() {
            await sequencer.stop();
            activeOnIds = [];
            changed();
        }

        /* ---------- drawing ---------- */

        function drawHeader(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 56, null);
            var title = page === 0 ? 'LIGHT SHOW' : 'DRL CONTROL';
            cv.text(title, 48, 82, 28, t.text, { font: 'bold', spacing: 2 });

            // connection status
            var demo = useDemo();
            var conn = phase === 'ready' ? (demo ? 'DEMO' : 'CONNECTED') : phase === 'reading' ? 'READING...' : phase === 'error' ? 'NO LINK' : 'CONNECTING...';
            var connColor = phase === 'ready' ? (demo ? t.warn : '#2fd27a') : phase === 'error' ? t.crit : t.dim;
            cv.text(conn, 1552, 82, 18, connColor, { align: 'right', font: 'bold', spacing: 1 });
        }

        // ---- Strobe page ----

        var patternTapTargets = [];
        var controlTapTargets = [];

        function drawStrobePage(cv, t) {
            patternTapTargets = [];
            controlTapTargets = [];

            // pattern list (left column)
            cv.text('PATTERNS', 48, 132, 18, t.dim, { font: 'bold', spacing: 1 });
            for (var i = 0; i < S.PATTERNS.length; i++) {
                var pat = S.PATTERNS[i];
                var y = 148 + i * 42;
                var isActive = sequencer.running && sequencer.pattern && sequencer.pattern.id === pat.id;
                var isSelected = i === selectedPattern;

                var bg = isActive ? withAlpha(t.accent2 || t.accent, 0.2) : isSelected ? withAlpha(t.text, 0.08) : withAlpha(t.text, 0.03);
                cv.roundRect(40, y, 500, 36, 8, bg);
                if (isActive) cv.fillRect(40, y, 4, 36, t.accent2 || t.accent);
                else if (isSelected) cv.fillRect(40, y, 4, 36, t.dim);

                cv.text(pat.name, 56, y + 24, 20, isActive ? (t.accent2 || t.accent) : t.text, { font: isActive ? 'bold' : 'normal' });
                cv.text(pat.description, 56, y + 36, 13, t.dim);

                patternTapTargets.push({ index: i, y: y, h: 36 });
            }

            // controls (right side)
            var cx = 620, cy = 148;

            // play / stop button
            var btnW = 200, btnH = 48;
            var btnColor = sequencer.running ? t.crit : (t.accent2 || t.accent);
            cv.roundRect(cx, cy, btnW, btnH, 10, btnColor);
            var btnLabel = sequencer.running ? 'STOP' : 'PLAY';
            cv.text(btnLabel, cx + btnW / 2, cy + 32, 24, '#FFFFFF', { align: 'center', font: 'bold' });
            controlTapTargets.push({ id: 'play_stop', x: cx, y: cy, w: btnW, h: btnH });

            // speed control
            cy += 70;
            cv.text('SPEED', cx, cy + 16, 16, t.dim, { font: 'bold', spacing: 1 });
            var speeds = [
                { label: '2x', value: 0.5 },
                { label: '1.5x', value: 0.67 },
                { label: '1x', value: 1.0 },
                { label: '0.75x', value: 1.33 },
                { label: '0.5x', value: 2.0 },
            ];
            for (var si = 0; si < speeds.length; si++) {
                var sx = cx + si * 80;
                var sy = cy + 28;
                var isCur = Math.abs(strobeSpeed - speeds[si].value) < 0.05;
                var pillBg = isCur ? (t.accent2 || t.accent) : withAlpha(t.text, 0.08);
                var pillTxt = isCur ? '#FFFFFF' : t.text;
                cv.roundRect(sx, sy, 68, 30, 6, pillBg);
                cv.text(speeds[si].label, sx + 34, sy + 21, 16, pillTxt, { align: 'center', font: isCur ? 'bold' : 'normal' });
                controlTapTargets.push({ id: 'speed_' + si, x: sx, y: sy, w: 68, h: 30, speedValue: speeds[si].value });
            }

            // live light visualisation
            cy += 80;
            cv.text('LIVE', cx, cy + 16, 16, t.dim, { font: 'bold', spacing: 1 });
            drawLightViz(cv, t, cx, cy + 28);
        }

        function drawLightViz(cv, t, ox, oy) {
            // draw a simplified car outline with light indicators
            var carW = 440, carH = 180;
            cv.roundRect(ox, oy, carW, carH, 12, withAlpha(t.text, 0.04));
            cv.roundRect(ox + 1, oy + 1, carW - 2, carH - 2, 12, 'transparent');

            // car label
            cv.text('G01', ox + carW / 2, oy + carH / 2 + 6, 20, withAlpha(t.dim, 0.3), { align: 'center', font: 'bold' });

            var onSet = {};
            for (var a = 0; a < activeOnIds.length; a++) onSet[activeOnIds[a]] = true;

            var lights = [
                // front row
                { id: 'high_l',  x: 30,  y: 20,  w: 36, h: 14 },
                { id: 'low_l',   x: 30,  y: 38,  w: 36, h: 14 },
                { id: 'drl_l',   x: 30,  y: 56,  w: 36, h: 10 },
                { id: 'fog_l',   x: 30,  y: 70,  w: 36, h: 10 },
                { id: 'turn_l',  x: 72,  y: 20,  w: 24, h: 10 },
                { id: 'high_r',  x: carW - 66, y: 20,  w: 36, h: 14 },
                { id: 'low_r',   x: carW - 66, y: 38,  w: 36, h: 14 },
                { id: 'drl_r',   x: carW - 66, y: 56,  w: 36, h: 10 },
                { id: 'fog_r',   x: carW - 66, y: 70,  w: 36, h: 10 },
                { id: 'turn_r',  x: carW - 96, y: 20,  w: 24, h: 10 },
                // rear row
                { id: 'tail_l',  x: 30,  y: carH - 42, w: 36, h: 14 },
                { id: 'tail_r',  x: carW - 66, y: carH - 42, w: 36, h: 14 },
                { id: 'plate',   x: carW / 2 - 30, y: carH - 32, w: 60, h: 10 },
                { id: 'rear_fog', x: carW / 2 - 20, y: carH - 18, w: 40, h: 10 },
            ];

            for (var li = 0; li < lights.length; li++) {
                var l = lights[li];
                var isOn = !!onSet[l.id];
                var color = isOn ? '#FFD700' : withAlpha(t.dim, 0.15);
                if (isOn && (l.id.indexOf('tail') >= 0 || l.id === 'rear_fog')) color = '#FF3333';
                if (isOn && l.id.indexOf('turn') >= 0) color = '#FFA500';
                cv.roundRect(ox + l.x, oy + l.y, l.w, l.h, 3, color);
            }

            // light labels (tiny, below the viz)
            if (!sequencer.running) {
                cv.text('Tap a pattern and press PLAY', ox + carW / 2, oy + carH + 18, 14, withAlpha(t.dim, 0.5), { align: 'center' });
            } else {
                var pat = sequencer.pattern;
                cv.text(pat ? pat.name : '', ox + carW / 2, oy + carH + 18, 14, t.accent2 || t.accent, { align: 'center', font: 'bold' });
            }
        }

        // ---- DRL page ----

        var drlTapTargets = [];

        function drawDrlPage(cv, t) {
            drlTapTargets = [];
            var opt = C.OPTIONS[0];
            var key = C.ECU.FLM_L + ':3100';
            var block = blocks[key];
            var raw = block ? C.readBits(block, opt) : null;
            var curLabel = raw !== null ? C.label(opt, raw) : '--';

            cv.text('DRL BRIGHTNESS', 48, 140, 20, t.dim, { font: 'bold', spacing: 1 });
            cv.text('Daytime running light LED brightness (both sides)', 48, 162, 16, t.dim);

            // current value display
            G.panel(cv, t, 40, 180, 500, 80, null);
            cv.text('Current:', 64, 220, 20, t.dim);
            cv.text(curLabel, 200, 224, 28, t.accent2 || t.accent, { font: 'bold' });

            // brightness options as cards
            var choices = opt.choices;
            for (var i = 0; i < choices.length; i++) {
                var y = 280 + i * 44;
                var isCur = raw === choices[i].value;
                var bg = isCur ? withAlpha(t.accent2 || t.accent, 0.15) : withAlpha(t.text, 0.04);
                cv.roundRect(40, y, 500, 38, 8, bg);
                if (isCur) cv.fillRect(40, y, 4, 38, t.accent2 || t.accent);

                cv.text(choices[i].label, 64, y + 26, 22, isCur ? (t.accent2 || t.accent) : t.text, { font: isCur ? 'bold' : 'normal' });

                // brightness bar
                var pct = choices[i].value;
                var barW = Math.round(200 * pct / 100);
                cv.roundRect(320, y + 10, 200, 18, 4, withAlpha(t.dim, 0.15));
                if (barW > 0) {
                    cv.roundRect(320, y + 10, barW, 18, 4, isCur ? (t.accent2 || t.accent) : withAlpha(t.text, 0.3));
                }

                drlTapTargets.push({ index: i, y: y, h: 38, value: choices[i].value });
            }
        }

        function drawStatus(cv, t) {
            if (!statusMsg || Date.now() - statusAt > 5000) return;
            var fade = Math.max(0, 1 - (Date.now() - statusAt - 3000) / 2000);
            var alpha = Math.min(1, fade);
            var bg = writing ? withAlpha(t.warn, 0.15 * alpha) : withAlpha(t.text, 0.08 * alpha);
            cv.roundRect(40, H - 56, 1520, 40, 8, bg);
            cv.text(statusMsg, 800, H - 28, 20, withAlpha(t.text, alpha), { align: 'center' });
        }

        var drawn = -1;
        async function render(force) {
            if (!force && drawn === version) return;
            drawn = version;
            var t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            drawHeader(cv, t);
            if (page === 0) drawStrobePage(cv, t);
            else drawDrlPage(cv, t);
            drawStatus(cv, t);
            var badges = [useDemo() && { text: 'DEMO' }];
            if (sequencer.running) badges.push({ text: 'PLAYING', color: 'accent2' });
            if (writing) badges.push({ text: 'WRITING', color: 'accent2' });
            G.frame(cv, t, TABS, page, badges);
            await ui.image('MAIN_GFX', cv);
        }

        // tap handling
        ctx.onTap(function (x, y) {
            if (page === 0) {
                // pattern selection
                for (var i = 0; i < patternTapTargets.length; i++) {
                    var pt = patternTapTargets[i];
                    if (y >= pt.y && y < pt.y + pt.h && x >= 40 && x < 540) {
                        selectedPattern = pt.index;
                        changed();
                        return;
                    }
                }
                // controls
                for (var j = 0; j < controlTapTargets.length; j++) {
                    var ct = controlTapTargets[j];
                    if (x >= ct.x && x < ct.x + ct.w && y >= ct.y && y < ct.y + ct.h) {
                        if (ct.id === 'play_stop') {
                            if (sequencer.running) stopStrobe();
                            else startStrobe();
                        } else if (ct.speedValue !== undefined) {
                            strobeSpeed = ct.speedValue;
                            if (sequencer.running) {
                                sequencer.speedScale = strobeSpeed;
                            }
                            changed();
                        }
                        return;
                    }
                }
            } else if (page === 1) {
                // DRL brightness selection
                for (var k = 0; k < drlTapTargets.length; k++) {
                    var dt = drlTapTargets[k];
                    if (y >= dt.y && y < dt.y + dt.h && x >= 40 && x < 540) {
                        writeDrl(dt.value);
                        return;
                    }
                }
            }
        });

        ui.onClick('BTN_REFRESH', function () {
            phase = 'idle';
            blocks = {};
            realLink.wake();
            poll();
            changed();
        });
        ui.onClick('BTN_STOP', function () {
            if (sequencer.running) stopStrobe();
        });
        ctx.onTab(function (i) {
            if (i !== page) {
                page = i;
                changed();
            }
        });
        ctx.onLayout(changed);
        settings.onChange(function () {
            if (sequencer.running) stopStrobe();
            blocks = {};
            phase = 'idle';
            sequencer.link = link();
            changed();
        });

        var loop = ctx.loop('MAIN', 2, function () { return render(false); });
        var redraw = function () { changed(); setTimeout(changed, 600); };
        ui.onVisible(function (name, on) { if (name === 'MAIN' && on) { redraw(); setTimeout(poll, 800); } });
        if (ui.onFocus) ui.onFocus(function (name, on) { if (name === 'MAIN' && on) redraw(); });
        render(true).then(function () { log.info('first frame done'); }).catch(function (e) { log.warn('first render: ' + e); });
    },
});
