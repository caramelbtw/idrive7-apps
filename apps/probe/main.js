'use strict';
/**
 * Probe - scan all ECUs on the diagnostic bus, browse their identifiers, and
 * log message traffic to discover how controls work.
 *
 * Pages (header tabs):
 *   Scan       discovered ECUs with address, name, SGBD index, online status
 *   Detail     identification DIDs and raw hex for the selected ECU
 *   Log        start/stop traffic logger; shows DIDs that changed between start and stop
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { fitText } = require('./kit/text-layout');
const { ProbeLink, KNOWN_ECUS } = require('./link');

const W = 1600, H = 520;
const TABS = ['Scan', 'Detail', 'Log'];

var hx = function (n) { return Number.isInteger(n) ? n.toString(16).toUpperCase().padStart(2, '0') : String(n); };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const link = new ProbeLink(ctx.signals, log);
        var linkInited = false;

        async function ensureLink() {
            if (!linkInited) {
                linkInited = true;
                await link.init();
                log.info('TASU init done: ready=' + link.ready + ' available=' + link.available + ' failed=' + link.failed);
            }
            return link.ready;
        }
        ensureLink();

        /* ---------- state ---------- */
        var page = 0, version = 0;
        var phase = 'idle';           // idle | scanning | ready | error
        var statusMsg = '';
        var statusAt = 0;
        var scanProgress = null;      // { scanned, total, found } during scan

        // scan state
        var ecus = [];                // [{ addr, name, sgbd, online }]
        var selectedIdx = -1;         // index into ecus[] for Detail page
        var ecuDetail = [];           // [{ did, name, hex, ascii }] for selected ECU

        // log state
        var logging = false;
        var logStartTime = 0;
        var logDiffs = [];            // changes found
        var logStatus = '';           // status text for log page
        var logPollTimer = null;

        var changed = function () { version++; if (loop) loop.kick(); };
        var status = function (msg) { statusMsg = msg; statusAt = Date.now(); changed(); };

        /* ---------- scan ---------- */
        async function doScan() {
            if (phase === 'scanning') return;
            phase = 'scanning'; changed();
            var linked = await ensureLink();
            if (!linked) {
                phase = 'error';
                statusMsg = link.failed ? 'TASU: ' + link.failed : 'TASU not ready';
                statusAt = Date.now();
                changed();
                return;
            }

            status('Scanning 0x00-0x7F...');
            scanProgress = { scanned: 0, total: 128, found: 0 };
            changed();
            try {
                ecus = await link.scan(function (scanned, total, found) {
                    scanProgress = { scanned: scanned, total: total, found: found };
                    changed();
                });
                scanProgress = null;
                if (ecus.length > 0) {
                    phase = 'ready';
                    status(ecus.length + ' ECU' + (ecus.length === 1 ? '' : 's') + ' found on bus');
                } else {
                    phase = 'error';
                    status('No ECUs answered');
                }
            } catch (e) {
                scanProgress = null;
                phase = 'error';
                status('Scan error: ' + e.message);
                log.warn('scan error: ' + e);
            }
            changed();
        }

        /* ---------- detail ---------- */
        async function loadDetail() {
            if (selectedIdx < 0 || selectedIdx >= ecus.length) return;
            var ecu = ecus[selectedIdx];
            status('Reading DIDs from 0x' + hx(ecu.addr) + '...');
            changed();
            try {
                ecuDetail = await link.readIdDids(ecu.addr);
                status(ecuDetail.length + ' DID' + (ecuDetail.length === 1 ? '' : 's') + ' read from ' + ecu.name);
            } catch (e) {
                status('Read error: ' + e.message);
                log.warn('detail error: ' + e);
            }
            changed();
        }

        /* ---------- logging ---------- */
        async function startLogging() {
            if (logging) return;
            if (ecus.length === 0) { status('Scan first'); return; }
            logging = true;
            logDiffs = [];
            logStartTime = Date.now();
            logStatus = 'Taking initial snapshot...';
            changed();

            var addrs = ecus.map(function (e) { return e.addr; });
            try {
                await link.startLog(addrs);
                logStatus = 'Logging... perform an action, then stop.';
                changed();
                // start periodic polling
                logPollTimer = setInterval(function () {
                    if (!logging) return;
                    link.pollLog(addrs).catch(function (e) {
                        log.warn('poll log error: ' + e);
                    }).then(function () { changed(); });
                }, 2000);
            } catch (e) {
                logStatus = 'Log start error: ' + e.message;
                logging = false;
                log.warn('startLog error: ' + e);
            }
            changed();
        }

        function stopLogging() {
            if (!logging) return;
            if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
            logging = false;
            logDiffs = link.stopLog();
            var elapsed = ((Date.now() - logStartTime) / 1000).toFixed(1);
            logStatus = logDiffs.length + ' change' + (logDiffs.length === 1 ? '' : 's') + ' detected in ' + elapsed + 's';
            changed();
        }

        /* ---------- drawing ---------- */

        function drawHeader(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 52, null);
            var title = 'PROBE';
            cv.text(title, 48, 80, 24, t.text, { font: 'bold', spacing: 2 });

            var conn, connColor;
            if (phase === 'scanning' || phase === 'idle') {
                if (scanProgress) {
                    conn = 'SCANNING ' + scanProgress.scanned + '/' + scanProgress.total + '  (' + scanProgress.found + ' found)';
                } else {
                    conn = phase === 'scanning' ? 'SCANNING...' : 'CONNECTING...';
                }
                connColor = t.dim;
            } else if (phase === 'ready') {
                conn = ecus.length + ' ECUS ONLINE';
                connColor = '#2fd27a';
            } else {
                conn = 'NO LINK';
                connColor = t.crit;
            }
            cv.text(conn, 1552, 80, 15, connColor, { align: 'right', font: 'bold', spacing: 1 });
        }

        // ---- Scan page ----

        var scanTapTargets = [];

        var refreshTapTarget = null;

        function drawScanPage(cv, t) {
            scanTapTargets = [];
            refreshTapTarget = null;
            var accent = t.accent2 || t.accent;

            // force refresh button (always visible on scan page)
            var rbW = 180, rbH = 36, rbX = 1352, rbY = 110;
            var rbColor = phase === 'scanning' ? t.dim : accent;
            cv.roundRect(rbX, rbY, rbW, rbH, 8, rbColor);
            var rbLabel = phase === 'scanning' ? 'SCANNING...' : 'FORCE RESCAN';
            cv.text(rbLabel, rbX + rbW / 2, rbY + 25, 15, '#FFFFFF', { align: 'center', font: 'bold', spacing: 1 });
            if (phase !== 'scanning') {
                refreshTapTarget = { x: rbX, y: rbY, w: rbW, h: rbH };
            }

            if (ecus.length === 0) {
                var msg = phase === 'scanning' ? 'Scanning all 128 diagnostic addresses...'
                    : phase === 'error' ? (statusMsg || 'No ECUs found')
                    : 'Press Refresh or FORCE RESCAN to scan';
                cv.text(msg, 800, 300, 26, t.dim, { align: 'center' });
                if (scanProgress) {
                    var pct = Math.round(scanProgress.scanned / scanProgress.total * 100);
                    cv.roundRect(400, 330, 800, 10, 5, withAlpha(t.dim, 0.1));
                    if (pct > 0) cv.roundRect(400, 330, Math.round(800 * pct / 100), 10, 5, withAlpha(accent, 0.5));
                    cv.text(pct + '%', 800, 362, 18, t.dim, { align: 'center' });
                }
                return;
            }

            // column headers
            cv.text('ADDR', 48, 128, 15, t.dim, { font: 'bold', spacing: 1 });
            cv.text('NAME', 140, 128, 15, t.dim, { font: 'bold', spacing: 1 });
            cv.text('SGBD', 600, 128, 15, t.dim, { font: 'bold', spacing: 1 });
            cv.text('STATUS', 900, 128, 15, t.dim, { font: 'bold', spacing: 1 });

            var maxVisible = Math.floor((H - 150) / 36);
            var shown = ecus.slice(0, maxVisible);

            for (var i = 0; i < shown.length; i++) {
                var ecu = shown[i];
                var y = 138 + i * 36;
                var isSelected = i === selectedIdx;
                var bg = isSelected ? withAlpha(accent, 0.15) : withAlpha(t.text, 0.03);

                cv.roundRect(40, y, 1520, 32, 6, bg);
                if (isSelected) cv.fillRect(40, y, 3, 32, accent);

                cv.text('0x' + hx(ecu.addr), 58, y + 22, 17, t.text, { font: 'bold' });
                cv.text(fitText(cv, ecu.name, 17, 440), 140, y + 22, 17, t.text);
                cv.text(ecu.sgbd || '--', 600, y + 22, 17, ecu.sgbd ? t.text : t.dim);

                var sc = ecu.online ? '#2fd27a' : t.crit;
                G.pill(cv, t, 880, y + 3, 90, 26, ecu.online ? 'ONLINE' : 'OFFLINE', { color: sc, size: 14 });

                scanTapTargets.push({ index: i, y: y, h: 32 });
            }

            if (ecus.length > maxVisible) {
                cv.text('+' + (ecus.length - maxVisible) + ' more', 1552, H - 20, 16, t.dim, { align: 'right' });
            }
        }

        // ---- Detail page ----

        function drawDetailPage(cv, t) {
            var accent = t.accent2 || t.accent;

            if (selectedIdx < 0 || selectedIdx >= ecus.length) {
                cv.text('Select an ECU on the Scan page', 800, 300, 26, t.dim, { align: 'center' });
                return;
            }

            var ecu = ecus[selectedIdx];
            cv.text('ECU DETAIL', 48, 128, 15, t.dim, { font: 'bold', spacing: 1 });

            // ECU header info
            cv.roundRect(40, 138, 1520, 50, 8, withAlpha(accent, 0.08));
            cv.text('0x' + hx(ecu.addr), 58, 170, 22, accent, { font: 'bold' });
            cv.text(ecu.name, 160, 170, 22, t.text, { font: 'bold' });
            cv.text('SGBD: ' + (ecu.sgbd || '--'), 600, 170, 18, t.dim);

            if (ecuDetail.length === 0) {
                cv.text('Tap Refresh to read identification DIDs', 800, 300, 22, t.dim, { align: 'center' });
                return;
            }

            // DID table
            cv.text('DID', 48, 212, 14, t.dim, { font: 'bold', spacing: 1 });
            cv.text('NAME', 130, 212, 14, t.dim, { font: 'bold', spacing: 1 });
            cv.text('HEX', 460, 212, 14, t.dim, { font: 'bold', spacing: 1 });
            cv.text('ASCII', 1100, 212, 14, t.dim, { font: 'bold', spacing: 1 });

            var maxRows = Math.floor((H - 240) / 34);
            var shown = ecuDetail.slice(0, maxRows);
            for (var i = 0; i < shown.length; i++) {
                var d = shown[i];
                var y = 222 + i * 34;
                cv.roundRect(40, y, 1520, 30, 5, withAlpha(t.text, i % 2 === 0 ? 0.03 : 0.06));
                cv.text(d.did, 58, y + 21, 16, accent, { font: 'bold' });
                cv.text(fitText(cv, d.name, 16, 310), 130, y + 21, 16, t.text);
                cv.text(fitText(cv, d.hex, 14, 620), 460, y + 21, 14, t.text);
                cv.text(fitText(cv, d.ascii, 14, 440), 1100, y + 21, 14, t.dim);
            }
        }

        // ---- Log page ----

        function drawLogPage(cv, t) {
            var accent = t.accent2 || t.accent;

            // controls area
            cv.text('TRAFFIC LOGGER', 48, 128, 15, t.dim, { font: 'bold', spacing: 1 });

            var btnW = 200, btnH = 40;
            var btnColor = logging ? t.crit : accent;
            cv.roundRect(48, 140, btnW, btnH, 8, btnColor);
            var btnLabel = logging ? 'STOP LOG' : 'START LOG';
            cv.text(btnLabel, 48 + btnW / 2, 166, 18, '#FFFFFF', { align: 'center', font: 'bold' });

            // status
            cv.text(logStatus || (ecus.length === 0 ? 'Scan for ECUs first' : 'Ready to log'), 270, 166, 18, t.dim);

            if (logging) {
                var elapsed = ((Date.now() - logStartTime) / 1000).toFixed(0);
                cv.text(elapsed + 's', 1552, 166, 18, t.crit, { align: 'right', font: 'bold' });

                // show live change count
                var liveChanges = link.getLog().filter(function (e) { return e.type === 'change'; });
                if (liveChanges.length > 0) {
                    cv.text(liveChanges.length + ' change' + (liveChanges.length === 1 ? '' : 's') + ' so far', 1552, 128, 15, t.warn, { align: 'right', font: 'bold' });
                }
            }

            // diff results
            if (logDiffs.length === 0 && !logging) {
                if (logStatus) {
                    cv.text('No changes detected during the logging period.', 800, 320, 22, t.dim, { align: 'center' });
                    cv.text('Try: start log, toggle a function (lights, HVAC, etc.), stop log.', 800, 352, 18, withAlpha(t.dim, 0.6), { align: 'center' });
                }
                return;
            }

            var list = logging ? link.getLog().filter(function (e) { return e.type === 'change'; }) : logDiffs;
            if (list.length === 0) return;

            // column headers
            var ty = 196;
            cv.text('TIME', 48, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('ECU', 160, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('DID', 310, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('BEFORE', 420, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('AFTER', 920, ty, 13, t.dim, { font: 'bold', spacing: 1 });

            var maxRows = Math.floor((H - 220) / 30);
            var shown = list.slice(-maxRows);  // show most recent changes

            for (var i = 0; i < shown.length; i++) {
                var entry = shown[i];
                var y = 206 + i * 30;
                var rowBg = withAlpha(t.warn, 0.08);
                cv.roundRect(40, y, 1520, 26, 4, rowBg);

                var timeStr = '+' + ((entry.ts - logStartTime) / 1000).toFixed(1) + 's';
                var ecuName = KNOWN_ECUS[entry.addr] || '0x' + hx(entry.addr);

                cv.text(timeStr, 58, y + 19, 14, t.text);
                cv.text(fitText(cv, '0x' + hx(entry.addr) + ' ' + ecuName, 14, 140), 160, y + 19, 14, t.text);
                cv.text(entry.did, 310, y + 19, 14, accent, { font: 'bold' });
                cv.text(fitText(cv, entry.before || '--', 12, 480), 420, y + 19, 12, t.dim);
                cv.text(fitText(cv, entry.after || '--', 12, 480), 920, y + 19, 12, '#2fd27a');
            }

            if (list.length > maxRows) {
                cv.text('+' + (list.length - maxRows) + ' earlier', 1552, H - 20, 14, t.dim, { align: 'right' });
            }
        }

        function drawStatus(cv, t) {
            if (!statusMsg || Date.now() - statusAt > 5000) return;
            var fade = Math.max(0, 1 - (Date.now() - statusAt - 3000) / 2000);
            var alpha = Math.min(1, fade);
            var bg = withAlpha(t.text, 0.08 * alpha);
            cv.roundRect(40, H - 56, 1520, 40, 8, bg);
            cv.text(statusMsg, 800, H - 28, 16, withAlpha(t.text, alpha), { align: 'center' });
        }

        var drawn = -1;
        async function render(force) {
            if (!force && drawn === version) return;
            drawn = version;
            var t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            drawHeader(cv, t);
            if (page === 0) drawScanPage(cv, t);
            else if (page === 1) drawDetailPage(cv, t);
            else drawLogPage(cv, t);
            drawStatus(cv, t);
            var badges = [];
            if (phase === 'scanning') badges.push({ text: 'SCANNING', color: 'accent2' });
            if (logging) badges.push({ text: 'LOGGING', color: 'accent2' });
            G.frame(cv, t, TABS, page, badges);
            await ui.image('MAIN_GFX', cv);
        }

        // ---- tap handling ----
        ctx.onTap(function (x, y) {
            if (page === 0) {
                // force rescan button
                if (refreshTapTarget) {
                    var rt = refreshTapTarget;
                    if (x >= rt.x && x < rt.x + rt.w && y >= rt.y && y < rt.y + rt.h) {
                        phase = 'idle';
                        ecus = [];
                        selectedIdx = -1;
                        ecuDetail = [];
                        linkInited = false;
                        link.wake();
                        doScan();
                        changed();
                        return;
                    }
                }
                // ECU selection in scan list
                for (var i = 0; i < scanTapTargets.length; i++) {
                    var st = scanTapTargets[i];
                    if (y >= st.y && y < st.y + st.h && x >= 40 && x < 1560) {
                        selectedIdx = st.index;
                        ecuDetail = [];
                        loadDetail();
                        page = 1; // switch to detail view
                        changed();
                        return;
                    }
                }
            } else if (page === 2) {
                // log start/stop button
                if (x >= 48 && x < 248 && y >= 140 && y < 180) {
                    if (logging) stopLogging();
                    else startLogging();
                    return;
                }
            }
        });

        // ---- button handlers ----
        ui.onClick('BTN_REFRESH', function () {
            if (page === 0) {
                // rescan
                phase = 'idle';
                ecus = [];
                selectedIdx = -1;
                ecuDetail = [];
                linkInited = false;
                link.wake();
                doScan();
            } else if (page === 1) {
                // re-read detail for selected ECU
                loadDetail();
            }
            changed();
        });

        ui.onClick('BTN_LOG', function () {
            // switch to log page and toggle
            page = 2;
            if (logging) stopLogging();
            else startLogging();
            changed();
        });

        ctx.onTab(function (i) {
            if (i !== page) {
                page = i;
                changed();
            }
        });
        ctx.onLayout(changed);
        settings.onChange(function () { changed(); });

        // auto-scan on startup
        setTimeout(function () { doScan(); }, 500);

        // keep render loop ticking while logging
        setInterval(function () {
            if (logging && ui.isVisible('MAIN')) changed();
        }, 2000);

        var loop = ctx.loop('MAIN', 2, function () { return render(false); });
        var redraw = function () { changed(); setTimeout(changed, 600); };
        ui.onVisible(function (name, on) { if (name === 'MAIN' && on) redraw(); });
        if (ui.onFocus) ui.onFocus(function (name, on) { if (name === 'MAIN' && on) redraw(); });
        render(true).then(function () { log.info('first frame done'); }).catch(function (e) { log.warn('first render: ' + e); });
    },
});
