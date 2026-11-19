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
const S = require('./strobe');

const W = 1600, H = 520;
const TABS = ['Strobe', 'DRL'];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diagLink = new CoderLink(ctx.signals, log);
        var linkInited = false;

        async function ensureLink() {
            if (!linkInited) {
                linkInited = true;
                await diagLink.init();
                log.info('TASU init done: ready=' + diagLink.ready + ' available=' + diagLink.available + ' failed=' + diagLink.failed);
            }
            return diagLink.ready;
        }
        ensureLink();
        const link = function () { return diagLink; };

        /* ---------- state ---------- */
        var page = 0, version = 0;
        var blocks = {};           // 'ecu:did' -> byte[]
        var phase = 'idle';        // idle | reading | ready | error
        var bdcOk = false;         // BDC reachable (strobe can work)
        var flmOk = false;         // FLM reachable (DRL coding works)
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

        /* ---------- probe + read ---------- */
        async function probeAndRead() {
            if (phase === 'reading') return;
            phase = 'reading'; changed();
            var linked = await ensureLink();
            var L = link();
            if (!linked) {
                phase = 'error';
                statusMsg = L.failed ? 'TASU: ' + L.failed : 'TASU not ready';
                statusAt = Date.now();
                lastRead = Date.now();
                changed();
                return;
            }

            // probe BDC
            if (!bdcOk) {
                try {
                    var bdcId = await L.identify(0x40);
                    bdcOk = !!bdcId;
                    if (bdcOk) log.info('BDC reached: ' + bdcId);
                } catch (e) {}
            }

            // probe + read FLM
            var ecus = [C.ECU.FLM_L, C.ECU.FLM_R];
            var ok = 0;
            for (var i = 0; i < ecus.length; i++) {
                var ecu = ecus[i];
                try {
                    await L.ask(ecu, 0x10, [0x03]);
                    var block = await L.readDid(ecu, '3100');
                    if (block) { blocks[ecu + ':3100'] = block; ok++; }
                    await L.ask(ecu, 0x10, [0x01]);
                } catch (e) {
                    log.warn('FLM ' + ecu.toString(16) + ': ' + e);
                }
            }
            flmOk = ok > 0;

            if (bdcOk || flmOk) {
                phase = 'ready';
            } else {
                phase = 'error';
                statusMsg = 'No ECU reachable'; statusAt = Date.now();
            }
            if (bdcOk && !flmOk) {
                statusMsg = 'FLM not routable via TASU'; statusAt = Date.now();
            }
            lastRead = Date.now();
            changed();
        }

        async function poll() {
            if (!ui.isVisible('MAIN')) return;
            if (phase === 'reading') return;
            if (sequencer.running) return;
            if (phase === 'idle' || (phase === 'error' && Date.now() - lastRead > 8000) || Date.now() - lastRead > 30000) {
                await probeAndRead();
            }
        }
        setInterval(poll, 4000);

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
            if (!pat || !bdcOk) return;
            var L = link();
            sequencer.link = L;
            var hex = function(r) { return r ? Array.from(r).map(function(b){return b.toString(16).toUpperCase().padStart(2,'0')}).join(' ') : 'null'; };

            status('Session 10 03...');
            var sess = await L.ask(0x40, 0x10, [0x03]);
            log.info('BDC 10 03 -> ' + hex(sess));
            if (!sess || sess[0] === 0x7F) {
                status('Session refused: ' + hex(sess));
                return;
            }

            // test: turn on DRL L and hold 2s so user can see it
            status('Test: DRL L on...');
            var test = await L.ask(0x40, 0x2F, [0x61, 0x01, 0x03, 0x01]);
            log.info('BDC 2F 6101 03 01 -> ' + hex(test));
            status('2F resp: ' + hex(test));
            await new Promise(function(r){ setTimeout(r, 2000); });

            // restore test light
            var restore = await L.ask(0x40, 0x2F, [0x61, 0x01, 0x00]);
            log.info('BDC 2F 6101 00 -> ' + hex(restore));

            if (!test || test[0] === 0x7F) {
                status('IOControl refused: ' + hex(test));
                await L.ask(0x40, 0x10, [0x01]).catch(function(){});
                return;
            }

            await sequencer.start(pat, strobeSpeed);
            changed();
        }

        async function stopStrobe() {
            await sequencer.stop();
            activeOnIds = [];
            try { await link().ask(0x40, 0x10, [0x01]); } catch (e) {}
            changed();
        }

        /* ---------- drawing ---------- */

        function drawHeader(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 52, null);
            var title = page === 0 ? 'LIGHT SHOW' : 'DRL CONTROL';
            cv.text(title, 48, 80, 24, t.text, { font: 'bold', spacing: 2 });

            var conn, connColor;
            if (phase === 'reading' || phase === 'idle') {
                conn = phase === 'reading' ? 'READING...' : 'CONNECTING...';
                connColor = t.dim;
            } else if (page === 0) {
                conn = bdcOk ? 'BDC CONNECTED' : 'NO LINK';
                connColor = bdcOk ? '#2fd27a' : t.crit;
            } else {
                conn = flmOk ? 'FLM CONNECTED' : bdcOk ? 'FLM UNAVAILABLE' : 'NO LINK';
                connColor = flmOk ? '#2fd27a' : t.crit;
            }
            cv.text(conn, 1552, 80, 15, connColor, { align: 'right', font: 'bold', spacing: 1 });
        }

        // ---- Strobe page ----

        var patternTapTargets = [];
        var controlTapTargets = [];

        function drawStrobePage(cv, t) {
            patternTapTargets = [];
            controlTapTargets = [];

            cv.text('PATTERNS', 48, 128, 15, t.dim, { font: 'bold', spacing: 1 });
            for (var i = 0; i < S.PATTERNS.length; i++) {
                var pat = S.PATTERNS[i];
                var y = 142 + i * 44;
                var isActive = sequencer.running && sequencer.pattern && sequencer.pattern.id === pat.id;
                var isSelected = i === selectedPattern;

                var bg = isActive ? withAlpha(t.accent2 || t.accent, 0.2) : isSelected ? withAlpha(t.text, 0.08) : withAlpha(t.text, 0.03);
                cv.roundRect(40, y, 500, 38, 7, bg);
                if (isActive) cv.fillRect(40, y, 3, 38, t.accent2 || t.accent);
                else if (isSelected) cv.fillRect(40, y, 3, 38, t.dim);

                cv.text(pat.name, 56, y + 22, 17, isActive ? (t.accent2 || t.accent) : t.text, { font: isActive ? 'bold' : 'normal' });
                cv.text(pat.description, 56, y + 35, 11, t.dim);

                patternTapTargets.push({ index: i, y: y, h: 38 });
            }

            var cx = 600, cy = 142;

            var btnW = 200, btnH = 44;
            var canPlay = bdcOk && phase === 'ready';
            var btnColor = sequencer.running ? t.crit : canPlay ? (t.accent2 || t.accent) : withAlpha(t.dim, 0.3);
            cv.roundRect(cx, cy, btnW, btnH, 8, btnColor);
            var btnLabel = sequencer.running ? 'STOP' : 'PLAY';
            cv.text(btnLabel, cx + btnW / 2, cy + 30, 20, '#FFFFFF', { align: 'center', font: 'bold' });
            controlTapTargets.push({ id: 'play_stop', x: cx, y: cy, w: btnW, h: btnH });

            cy += 60;
            cv.text('SPEED', cx, cy + 14, 13, t.dim, { font: 'bold', spacing: 1 });
            var speeds = [
                { label: '2x', value: 0.5 },
                { label: '1.5x', value: 0.67 },
                { label: '1x', value: 1.0 },
                { label: '0.75x', value: 1.33 },
                { label: '0.5x', value: 2.0 },
            ];
            for (var si = 0; si < speeds.length; si++) {
                var sx = cx + si * 76;
                var sy = cy + 24;
                var isCur = Math.abs(strobeSpeed - speeds[si].value) < 0.05;
                var pillBg = isCur ? (t.accent2 || t.accent) : withAlpha(t.text, 0.08);
                var pillTxt = isCur ? '#FFFFFF' : t.text;
                cv.roundRect(sx, sy, 66, 28, 6, pillBg);
                cv.text(speeds[si].label, sx + 33, sy + 19, 14, pillTxt, { align: 'center', font: isCur ? 'bold' : 'normal' });
                controlTapTargets.push({ id: 'speed_' + si, x: sx, y: sy, w: 66, h: 28, speedValue: speeds[si].value });
            }

            cy += 72;
            cv.text('LIVE', cx, cy + 14, 13, t.dim, { font: 'bold', spacing: 1 });
            drawLightViz(cv, t, cx, cy + 24);
        }

        function drawLightViz(cv, t, ox, oy) {
            // draw a simplified car outline with light indicators
            var carW = 440, carH = 180;
            cv.roundRect(ox, oy, carW, carH, 12, withAlpha(t.text, 0.04));
            cv.roundRect(ox + 1, oy + 1, carW - 2, carH - 2, 12, 'transparent');

            cv.text('G01', ox + carW / 2, oy + carH / 2 + 5, 18, withAlpha(t.dim, 0.3), { align: 'center', font: 'bold' });

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
                cv.text('Tap a pattern and press PLAY', ox + carW / 2, oy + carH + 18, 12, withAlpha(t.dim, 0.5), { align: 'center' });
            } else {
                var pat = sequencer.pattern;
                cv.text(pat ? pat.name : '', ox + carW / 2, oy + carH + 18, 13, t.accent2 || t.accent, { align: 'center', font: 'bold' });
            }
        }

        // ---- DRL page ----

        var drlTapTargets = [];

        function drawDrlPage(cv, t) {
            drlTapTargets = [];
            var accent = t.accent2 || t.accent;
            var cx = 800;
            var baseY = 140;

            cv.text('DRL BRIGHTNESS', cx, baseY, 20, t.text, { align: 'center', font: 'bold', spacing: 2 });
            cv.text('Daytime running light LED intensity', cx, baseY + 24, 13, t.dim, { align: 'center' });

            if (!flmOk && phase !== 'reading' && phase !== 'idle') {
                cv.text('FLM modules not reachable', cx, baseY + 90, 20, t.crit, { align: 'center', font: 'bold' });
                cv.text('TASU on BDC2 cannot route to FLM 0x43 / 0x44', cx, baseY + 116, 13, t.dim, { align: 'center' });
                cv.text('DRL coding requires direct diagnostic access to the headlight modules.', cx, baseY + 140, 12, withAlpha(t.dim, 0.6), { align: 'center' });
                cv.text('Use ISTA or BimmerCode for DRL brightness on this vehicle.', cx, baseY + 160, 12, withAlpha(t.dim, 0.6), { align: 'center' });
                return;
            }

            var opt = C.OPTIONS[0];
            var key = C.ECU.FLM_L + ':3100';
            var block = blocks[key];
            var raw = block ? C.readBits(block, opt) : null;
            var curLabel = raw !== null ? C.label(opt, raw) : '--';

            // large readout
            cv.text(curLabel, cx, baseY + 100, 44, accent, { align: 'center', font: 'bold' });
            cv.fillRect(cx - 50, baseY + 114, 100, 2, withAlpha(accent, 0.25));

            // brightness bar
            var barTrackW = 540, barH = 10;
            var barX = cx - barTrackW / 2;
            var barY = baseY + 140;
            var pctVal = raw !== null ? raw : 0;
            var barW = Math.round(barTrackW * pctVal / 100);
            cv.roundRect(barX, barY, barTrackW, barH, 5, withAlpha(t.dim, 0.1));
            if (barW > 0) cv.roundRect(barX, barY, barW, barH, 5, withAlpha(accent, 0.5));

            // quick-select pills
            var choices = opt.choices;
            var pillW = 100, pillH = 40, pillGap = 14;
            var totalW = choices.length * pillW + (choices.length - 1) * pillGap;
            var startX = cx - totalW / 2;
            var pillY = baseY + 174;

            for (var i = 0; i < choices.length; i++) {
                var px = startX + i * (pillW + pillGap);
                var isCur = raw === choices[i].value;
                var bg = isCur ? accent : withAlpha(t.text, 0.06);
                cv.roundRect(px, pillY, pillW, pillH, 8, bg);
                if (isCur) {
                    cv.roundRect(px - 1, pillY - 1, pillW + 2, pillH + 2, 9, withAlpha(accent, 0.3));
                    cv.roundRect(px, pillY, pillW, pillH, 8, accent);
                }
                var label = choices[i].value + '%';
                cv.text(label, px + pillW / 2, pillY + 27, 17, isCur ? '#FFFFFF' : t.text, { align: 'center', font: isCur ? 'bold' : 'normal' });
                drlTapTargets.push({ index: i, x: px, y: pillY, w: pillW, h: pillH, value: choices[i].value });
            }

            cv.text('Applies to both FLM headlight modules', cx, pillY + pillH + 24, 12, withAlpha(t.dim, 0.5), { align: 'center' });
        }

        function drawStatus(cv, t) {
            if (!statusMsg || Date.now() - statusAt > 5000) return;
            var fade = Math.max(0, 1 - (Date.now() - statusAt - 3000) / 2000);
            var alpha = Math.min(1, fade);
            var bg = writing ? withAlpha(t.warn, 0.15 * alpha) : withAlpha(t.text, 0.08 * alpha);
            cv.roundRect(40, H - 56, 1520, 40, 8, bg);
            cv.text(statusMsg, 800, H - 28, 16, withAlpha(t.text, alpha), { align: 'center' });
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
            var badges = [];
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
                for (var k = 0; k < drlTapTargets.length; k++) {
                    var dt = drlTapTargets[k];
                    if (x >= dt.x && x < dt.x + dt.w && y >= dt.y && y < dt.y + dt.h) {
                        writeDrl(dt.value);
                        return;
                    }
                }
            }
        });

        ui.onClick('BTN_REFRESH', function () {
            phase = 'idle';
            bdcOk = false;
            flmOk = false;
            blocks = {};
            linkInited = false;
            diagLink.wake();
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
            changed();
        });

        var loop = ctx.loop('MAIN', 2, function () { return render(false); });
        var redraw = function () { changed(); setTimeout(changed, 600); };
        ui.onVisible(function (name, on) { if (name === 'MAIN' && on) { redraw(); setTimeout(poll, 800); } });
        if (ui.onFocus) ui.onFocus(function (name, on) { if (name === 'MAIN' && on) redraw(); });
        render(true).then(function () { log.info('first frame done'); }).catch(function (e) { log.warn('first render: ' + e); });
    },
});
