'use strict';
/**
 * Probe - scan all ECUs on the diagnostic bus, browse their identifiers, discover
 * services and DIDs, read fault memory, and log message traffic.
 *
 * Pages (header tabs):
 *   Scan       discovered ECUs with address, name, SGBD index, online status
 *   Detail     identification DIDs, supported UDS services for the selected ECU
 *   DIDs       brute-force DID range scanner for the selected ECU
 *   Faults     fault memory (19 02) from the selected ECU
 *   Log        start/stop traffic logger; shows DIDs that changed between start and stop
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { fitText } = require('./kit/text-layout');
const { ProbeLink, KNOWN_ECUS, DID_RANGES, NRC_NAMES } = require('./link');

const W = 1600, H = 520;
const TABS = ['Scan', 'Detail', 'DIDs', 'Faults', 'Log'];

var hx = function (n) { return Number.isInteger(n) ? n.toString(16).toUpperCase().padStart(2, '0') : String(n); };

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const link = new ProbeLink(ctx.signals, log);
        var linkReady = false;
        var linkPromise = null;

        async function ensureLink() {
            if (linkReady) return true;
            if (!linkPromise) {
                linkPromise = link.init().then(function () {
                    linkReady = link.ready;
                    log.info('TASU init done: ready=' + link.ready + ' available=' + link.available + ' failed=' + link.failed);
                }).catch(function (e) {
                    log.warn('TASU init failed: ' + e);
                    linkPromise = null;
                });
            }
            await linkPromise;
            return linkReady;
        }
        ensureLink();

        /* ---------- state ---------- */
        var page = 0, version = 0;
        var phase = 'idle';           // idle | scanning | ready | error
        var statusMsg = '';
        var statusAt = 0;
        var scanProgress = null;      // { phase, found } or { phase, current, total, found } during scan

        // scan state
        var ecus = [];                // [{ addr, name, sgbd, online }]
        var selectedIdx = -1;         // index into ecus[] for Detail/DIDs/Faults pages
        var ecuDetail = [];           // [{ did, name, hex, ascii }] for selected ECU
        var ecuServices = [];         // [{ sid, name, supported, nrc }] for selected ECU
        var servicesLoaded = false;

        // DID scanner state
        var didResults = [];          // [{ did, bytes, hex }] found DIDs
        var didScanRange = 0;         // index into DID_RANGES
        var didScanning = false;
        var didProgress = null;       // { scanned, total, found }

        // fault state
        var faults = null;            // [{ code, status, statusBits }] or null
        var faultsLoading = false;

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

            status('Broadcasting to all ECUs...');
            scanProgress = { phase: 'broadcast', found: 0 };
            changed();
            try {
                ecus = await link.scan(function (scanPhase, detail) {
                    if (scanPhase === 'broadcast') {
                        scanProgress = { phase: 'broadcast', found: detail.found };
                    } else {
                        scanProgress = { phase: 'identify', current: detail.current, total: detail.total, found: detail.found };
                    }
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
                status(ecuDetail.length + ' DID' + (ecuDetail.length === 1 ? '' : 's') + ' read');
            } catch (e) {
                status('Read error: ' + e.message);
                log.warn('detail error: ' + e);
            }
            changed();
        }

        async function loadServices() {
            if (selectedIdx < 0 || selectedIdx >= ecus.length) return;
            if (servicesLoaded) return;
            var ecu = ecus[selectedIdx];
            status('Probing services on 0x' + hx(ecu.addr) + '...');
            changed();
            try {
                ecuServices = await link.discoverServices(ecu.addr);
                servicesLoaded = true;
                var supported = ecuServices.filter(function (s) { return s.supported; }).length;
                status(supported + ' service' + (supported === 1 ? '' : 's') + ' supported');
            } catch (e) {
                status('Service probe error: ' + e.message);
                log.warn('service probe error: ' + e);
            }
            changed();
        }

        function selectEcu(idx) {
            if (idx === selectedIdx) return;
            selectedIdx = idx;
            ecuDetail = [];
            ecuServices = [];
            servicesLoaded = false;
            didResults = [];
            didProgress = null;
            faults = null;
        }

        /* ---------- DID scanner ---------- */
        async function startDidScan() {
            if (didScanning) return;
            if (selectedIdx < 0 || selectedIdx >= ecus.length) { status('Select an ECU first'); return; }
            var range = DID_RANGES[didScanRange];
            if (!range) return;
            didScanning = true;
            didResults = [];
            didProgress = { scanned: 0, total: range.end - range.start + 1, found: 0 };
            status('Scanning ' + range.label + '...');
            changed();
            try {
                didResults = await link.scanDidRange(ecus[selectedIdx].addr, range.start, range.end, function (scanned, total, found) {
                    didProgress = { scanned: scanned, total: total, found: found };
                    changed();
                });
                didProgress = null;
                status(didResults.length + ' DID' + (didResults.length === 1 ? '' : 's') + ' found in range');
            } catch (e) {
                didProgress = null;
                status('DID scan error: ' + e.message);
                log.warn('DID scan error: ' + e);
            }
            didScanning = false;
            changed();
        }

        /* ---------- fault reader ---------- */
        async function loadFaults() {
            if (selectedIdx < 0 || selectedIdx >= ecus.length) return;
            if (faultsLoading) return;
            faultsLoading = true;
            var ecu = ecus[selectedIdx];
            status('Reading faults from 0x' + hx(ecu.addr) + '...');
            changed();
            try {
                faults = await link.readFaults(ecu.addr);
                if (faults === null) {
                    status('No fault memory response from ' + ecu.name);
                } else {
                    status(faults.length + ' fault' + (faults.length === 1 ? '' : 's') + ' stored');
                }
            } catch (e) {
                status('Fault read error: ' + e.message);
                log.warn('fault read error: ' + e);
            }
            faultsLoading = false;
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
            cv.text('PROBE', 48, 80, 24, t.text, { font: 'bold', spacing: 2 });

            var conn, connColor;
            if (phase === 'scanning' || phase === 'idle') {
                if (scanProgress && scanProgress.phase === 'broadcast') {
                    conn = 'BROADCAST...  (' + scanProgress.found + ' found)';
                } else if (scanProgress && scanProgress.phase === 'identify') {
                    conn = 'IDENTIFY ' + scanProgress.current + '/' + scanProgress.total + '  (' + scanProgress.found + ' done)';
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

            var rbW = 180, rbH = 36, rbX = 1352, rbY = 110;
            var rbColor = phase === 'scanning' ? t.dim : accent;
            cv.roundRect(rbX, rbY, rbW, rbH, 8, rbColor);
            var rbLabel = phase === 'scanning' ? 'SCANNING...' : 'FORCE RESCAN';
            cv.text(rbLabel, rbX + rbW / 2, rbY + 25, 15, '#FFFFFF', { align: 'center', font: 'bold', spacing: 1 });
            if (phase !== 'scanning') {
                refreshTapTarget = { x: rbX, y: rbY, w: rbW, h: rbH };
            }

            if (ecus.length === 0) {
                var msg, msg2;
                if (phase === 'scanning' && scanProgress) {
                    if (scanProgress.phase === 'broadcast') {
                        msg = 'Broadcasting TesterPresent to all ECUs...';
                        msg2 = scanProgress.found > 0 ? scanProgress.found + ' responding' : 'Waiting for replies...';
                    } else {
                        msg = 'Identifying ECU ' + scanProgress.current + ' of ' + scanProgress.total + '...';
                        msg2 = scanProgress.found + ' identified';
                    }
                } else if (phase === 'scanning') {
                    msg = 'Preparing broadcast...';
                } else if (phase === 'error') {
                    msg = statusMsg || 'No ECUs found';
                } else {
                    msg = 'Press Refresh or FORCE RESCAN to scan';
                }
                cv.text(msg, 800, 290, 26, t.dim, { align: 'center' });
                if (msg2) cv.text(msg2, 800, 324, 20, withAlpha(accent, 0.7), { align: 'center' });
                if (scanProgress && scanProgress.phase === 'identify') {
                    var pct = Math.round(scanProgress.current / scanProgress.total * 100);
                    cv.roundRect(400, 345, 800, 10, 5, withAlpha(t.dim, 0.1));
                    if (pct > 0) cv.roundRect(400, 345, Math.round(800 * pct / 100), 10, 5, withAlpha(accent, 0.5));
                    cv.text(pct + '%', 800, 377, 18, t.dim, { align: 'center' });
                }
                return;
            }

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

        // ---- Detail page (identification + services) ----

        function drawDetailPage(cv, t) {
            var accent = t.accent2 || t.accent;

            if (selectedIdx < 0 || selectedIdx >= ecus.length) {
                cv.text('Select an ECU on the Scan page', 800, 300, 26, t.dim, { align: 'center' });
                return;
            }

            var ecu = ecus[selectedIdx];

            // ECU header
            cv.roundRect(40, 110, 1520, 44, 8, withAlpha(accent, 0.08));
            cv.text('0x' + hx(ecu.addr), 58, 140, 20, accent, { font: 'bold' });
            cv.text(ecu.name, 140, 140, 20, t.text, { font: 'bold' });
            cv.text('SGBD: ' + (ecu.sgbd || '--'), 500, 140, 16, t.dim);

            // left panel: identification DIDs
            var lx = 40, lw = 760;
            cv.text('IDENTIFICATION', lx + 8, 178, 13, t.dim, { font: 'bold', spacing: 1 });

            if (ecuDetail.length === 0) {
                cv.text('Tap Refresh to read', lx + 8, 220, 18, t.dim);
            } else {
                var maxRows = Math.floor((H - 200) / 28);
                var shown = ecuDetail.slice(0, maxRows);
                for (var i = 0; i < shown.length; i++) {
                    var d = shown[i];
                    var y = 190 + i * 28;
                    cv.roundRect(lx, y, lw, 24, 4, withAlpha(t.text, i % 2 === 0 ? 0.02 : 0.05));
                    cv.text(d.did, lx + 10, y + 18, 13, accent, { font: 'bold' });
                    cv.text(fitText(cv, d.name, 13, 150), lx + 60, y + 18, 13, t.text);
                    cv.text(fitText(cv, d.hex, 12, 320), lx + 220, y + 18, 12, t.text);
                    cv.text(fitText(cv, d.ascii, 12, 180), lx + 560, y + 18, 12, t.dim);
                }
            }

            // right panel: supported services
            var rx = 820, rw = 740;
            cv.text('SERVICES', rx + 8, 178, 13, t.dim, { font: 'bold', spacing: 1 });

            if (!servicesLoaded) {
                cv.text('Loading services...', rx + 8, 220, 18, t.dim);
            } else {
                var sy = 190;
                for (var j = 0; j < ecuServices.length; j++) {
                    var s = ecuServices[j];
                    var y2 = sy + j * 22;
                    if (y2 + 22 > H - 20) break;
                    var sc = s.supported ? '#2fd27a' : withAlpha(t.dim, 0.4);
                    cv.fillRect(rx + 8, y2 + 6, 8, 8, sc);
                    cv.text(hx(s.sid), rx + 24, y2 + 16, 13, s.supported ? t.text : t.dim, { font: 'bold' });
                    cv.text(fitText(cv, s.name, 13, 400), rx + 50, y2 + 16, 13, s.supported ? t.text : t.dim);
                    if (s.nrc !== null && s.nrc !== 0x11) {
                        var nrcName = NRC_NAMES[s.nrc] || hx(s.nrc);
                        cv.text(fitText(cv, nrcName, 11, 200), rx + rw - 10, y2 + 16, 11, t.dim, { align: 'right' });
                    }
                    if (s.supported) {
                        cv.text('YES', rx + rw - 10, y2 + 16, 12, '#2fd27a', { align: 'right', font: 'bold' });
                    }
                }
            }
        }

        // ---- DID Scanner page ----

        var didRangeTapTargets = [];
        var didScanBtnTarget = null;

        function drawDidsPage(cv, t) {
            didRangeTapTargets = [];
            didScanBtnTarget = null;
            var accent = t.accent2 || t.accent;

            if (selectedIdx < 0 || selectedIdx >= ecus.length) {
                cv.text('Select an ECU on the Scan page first', 800, 300, 26, t.dim, { align: 'center' });
                return;
            }

            var ecu = ecus[selectedIdx];
            cv.text('DID SCANNER', 48, 128, 15, t.dim, { font: 'bold', spacing: 1 });
            cv.text('0x' + hx(ecu.addr) + ' ' + ecu.name, 200, 128, 15, accent, { font: 'bold' });

            // range selector pills
            var px = 48, py = 140;
            for (var i = 0; i < DID_RANGES.length; i++) {
                var r = DID_RANGES[i];
                var isCur = i === didScanRange;
                var pillW = Math.min(210, cv.textWidth(r.label, 12) + 20);
                if (px + pillW > 1200) { px = 48; py += 28; }
                var pillBg = isCur ? accent : withAlpha(t.text, 0.06);
                var pillTxt = isCur ? '#FFFFFF' : t.text;
                cv.roundRect(px, py, pillW, 24, 6, pillBg);
                cv.text(r.label, px + pillW / 2, py + 17, 12, pillTxt, { align: 'center', font: isCur ? 'bold' : 'normal' });
                didRangeTapTargets.push({ index: i, x: px, y: py, w: pillW, h: 24 });
                px += pillW + 8;
            }

            // scan button
            var btnX = 1340, btnY = 140, btnW = 200, btnH = 34;
            var btnColor = didScanning ? t.dim : accent;
            cv.roundRect(btnX, btnY, btnW, btnH, 8, btnColor);
            cv.text(didScanning ? 'SCANNING...' : 'SCAN RANGE', btnX + btnW / 2, btnY + 24, 15, '#FFFFFF', { align: 'center', font: 'bold' });
            if (!didScanning) didScanBtnTarget = { x: btnX, y: btnY, w: btnW, h: btnH };

            // progress
            var tableY = py + 40;
            if (didProgress) {
                var pct = Math.round(didProgress.scanned / didProgress.total * 100);
                cv.roundRect(48, tableY, 1200, 8, 4, withAlpha(t.dim, 0.1));
                if (pct > 0) cv.roundRect(48, tableY, Math.round(1200 * pct / 100), 8, 4, withAlpha(accent, 0.5));
                cv.text(pct + '%  (' + didProgress.found + ' found)', 1270, tableY + 8, 14, t.dim);
                tableY += 20;
            }

            // results table
            if (didResults.length === 0 && !didScanning) {
                cv.text('Select a range and tap SCAN RANGE', 800, tableY + 60, 20, withAlpha(t.dim, 0.5), { align: 'center' });
                return;
            }
            if (didResults.length > 0) {
                cv.text('DID', 48, tableY + 16, 13, t.dim, { font: 'bold', spacing: 1 });
                cv.text('SIZE', 130, tableY + 16, 13, t.dim, { font: 'bold', spacing: 1 });
                cv.text('DATA', 210, tableY + 16, 13, t.dim, { font: 'bold', spacing: 1 });
                tableY += 22;

                var maxRows = Math.floor((H - tableY - 20) / 24);
                var shown2 = didResults.slice(0, maxRows);
                for (var k = 0; k < shown2.length; k++) {
                    var d = shown2[k];
                    var ry = tableY + k * 24;
                    cv.roundRect(40, ry, 1520, 20, 3, withAlpha(t.text, k % 2 === 0 ? 0.02 : 0.05));
                    cv.text(d.did, 58, ry + 15, 14, accent, { font: 'bold' });
                    cv.text(d.bytes + 'B', 130, ry + 15, 14, t.dim);
                    cv.text(fitText(cv, d.hex, 13, 1300), 210, ry + 15, 13, t.text);
                }
                if (didResults.length > maxRows) {
                    cv.text('+' + (didResults.length - maxRows) + ' more', 1552, H - 20, 14, t.dim, { align: 'right' });
                }
            }
        }

        // ---- Faults page ----

        function drawFaultsPage(cv, t) {
            var accent = t.accent2 || t.accent;

            if (selectedIdx < 0 || selectedIdx >= ecus.length) {
                cv.text('Select an ECU on the Scan page first', 800, 300, 26, t.dim, { align: 'center' });
                return;
            }

            var ecu = ecus[selectedIdx];
            cv.text('FAULT MEMORY', 48, 128, 15, t.dim, { font: 'bold', spacing: 1 });
            cv.text('0x' + hx(ecu.addr) + ' ' + ecu.name + '  ·  UDS 19 02 FF (read only)', 220, 128, 15, accent);

            if (faults === null && !faultsLoading) {
                cv.text('Tap Refresh to read fault memory', 800, 300, 22, t.dim, { align: 'center' });
                return;
            }
            if (faultsLoading) {
                cv.text('Reading fault memory...', 800, 300, 22, t.dim, { align: 'center' });
                return;
            }

            if (faults.length === 0) {
                cv.circle(800, 270, 36, '#2fd27a');
                cv.line(784, 272, 795, 283, 6, t.bg); cv.line(795, 283, 816, 258, 6, t.bg);
                cv.text('No faults stored', 800, 340, 30, '#2fd27a', { font: 'bold', align: 'center' });
                return;
            }

            cv.text('CODE', 48, 160, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('STATUS', 180, 160, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('FLAGS', 320, 160, 13, t.dim, { font: 'bold', spacing: 1 });

            var maxRows = Math.floor((H - 180) / 32);
            var shown = faults.slice(0, maxRows);
            for (var i = 0; i < shown.length; i++) {
                var f = shown[i];
                var y = 170 + i * 32;
                var active = !!(f.status & 0x01);
                var c = active ? t.crit : t.warn;
                cv.roundRect(40, y, 1520, 28, 5, withAlpha(c, 0.08));
                cv.fillRect(40, y, 4, 28, c);
                cv.text(f.code, 58, y + 20, 18, t.text, { font: 'bold', spacing: 1 });
                cv.text('0x' + hx(f.status), 180, y + 20, 16, t.text, { font: 'bold' });
                cv.text(fitText(cv, f.statusBits.join(', '), 13, 1180), 320, y + 20, 13, t.dim);
            }
            if (faults.length > maxRows) {
                cv.text('+' + (faults.length - maxRows) + ' more', 1552, H - 20, 14, t.dim, { align: 'right' });
            }
        }

        // ---- Log page ----

        function drawLogPage(cv, t) {
            var accent = t.accent2 || t.accent;

            cv.text('TRAFFIC LOGGER', 48, 128, 15, t.dim, { font: 'bold', spacing: 1 });

            var btnW = 200, btnH = 40;
            var btnColor = logging ? t.crit : accent;
            cv.roundRect(48, 140, btnW, btnH, 8, btnColor);
            var btnLabel = logging ? 'STOP LOG' : 'START LOG';
            cv.text(btnLabel, 48 + btnW / 2, 166, 18, '#FFFFFF', { align: 'center', font: 'bold' });

            cv.text(logStatus || (ecus.length === 0 ? 'Scan for ECUs first' : 'Ready to log'), 270, 166, 18, t.dim);

            if (logging) {
                var elapsed = ((Date.now() - logStartTime) / 1000).toFixed(0);
                cv.text(elapsed + 's', 1552, 166, 18, t.crit, { align: 'right', font: 'bold' });
                var liveChanges = link.getLog().filter(function (e) { return e.type === 'change'; });
                if (liveChanges.length > 0) {
                    cv.text(liveChanges.length + ' change' + (liveChanges.length === 1 ? '' : 's') + ' so far', 1552, 128, 15, t.warn, { align: 'right', font: 'bold' });
                }
            }

            if (logDiffs.length === 0 && !logging) {
                if (logStatus) {
                    cv.text('No changes detected during the logging period.', 800, 320, 22, t.dim, { align: 'center' });
                    cv.text('Try: start log, toggle a function (lights, HVAC, etc.), stop log.', 800, 352, 18, withAlpha(t.dim, 0.6), { align: 'center' });
                }
                return;
            }

            var list = logging ? link.getLog().filter(function (e) { return e.type === 'change'; }) : logDiffs;
            if (list.length === 0) return;

            var ty = 196;
            cv.text('TIME', 48, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('ECU', 160, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('DID', 310, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('BEFORE', 420, ty, 13, t.dim, { font: 'bold', spacing: 1 });
            cv.text('AFTER', 920, ty, 13, t.dim, { font: 'bold', spacing: 1 });

            var maxRows = Math.floor((H - 220) / 30);
            var shown = list.slice(-maxRows);

            for (var i = 0; i < shown.length; i++) {
                var entry = shown[i];
                var y = 206 + i * 30;
                cv.roundRect(40, y, 1520, 26, 4, withAlpha(t.warn, 0.08));
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
            else if (page === 2) drawDidsPage(cv, t);
            else if (page === 3) drawFaultsPage(cv, t);
            else drawLogPage(cv, t);
            drawStatus(cv, t);
            var badges = [];
            if (phase === 'scanning') badges.push({ text: 'SCANNING', color: 'accent2' });
            if (didScanning) badges.push({ text: 'DID SCAN', color: 'accent2' });
            if (logging) badges.push({ text: 'LOGGING', color: 'accent2' });
            G.frame(cv, t, TABS, page, badges);
            await ui.image('MAIN_GFX', cv);
        }

        // ---- tap handling ----
        ctx.onTap(function (x, y) {
            if (page === 0) {
                if (refreshTapTarget) {
                    var rt = refreshTapTarget;
                    if (x >= rt.x && x < rt.x + rt.w && y >= rt.y && y < rt.y + rt.h) {
                        phase = 'idle'; ecus = []; selectedIdx = -1; ecuDetail = [];
                        ecuServices = []; servicesLoaded = false; didResults = [];
                        faults = null; linkReady = false; linkPromise = null; link.wake();
                        doScan(); changed(); return;
                    }
                }
                for (var i = 0; i < scanTapTargets.length; i++) {
                    var st = scanTapTargets[i];
                    if (y >= st.y && y < st.y + st.h && x >= 40 && x < 1560) {
                        selectEcu(st.index);
                        loadDetail();
                        loadServices();
                        page = 1;
                        changed();
                        return;
                    }
                }
            } else if (page === 2) {
                // DID range pills
                for (var j = 0; j < didRangeTapTargets.length; j++) {
                    var dr = didRangeTapTargets[j];
                    if (x >= dr.x && x < dr.x + dr.w && y >= dr.y && y < dr.y + dr.h) {
                        didScanRange = dr.index;
                        changed();
                        return;
                    }
                }
                // scan button
                if (didScanBtnTarget) {
                    var sb = didScanBtnTarget;
                    if (x >= sb.x && x < sb.x + sb.w && y >= sb.y && y < sb.y + sb.h) {
                        startDidScan();
                        return;
                    }
                }
            } else if (page === 4) {
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
                phase = 'idle'; ecus = []; selectedIdx = -1; ecuDetail = [];
                ecuServices = []; servicesLoaded = false; didResults = [];
                faults = null; linkReady = false; linkPromise = null; link.wake();
                doScan();
            } else if (page === 1) {
                ecuDetail = []; ecuServices = []; servicesLoaded = false;
                loadDetail(); loadServices();
            } else if (page === 2) {
                startDidScan();
            } else if (page === 3) {
                faults = null;
                loadFaults();
            }
            changed();
        });

        ui.onClick('BTN_LOG', function () {
            page = 4;
            if (logging) stopLogging();
            else startLogging();
            changed();
        });

        ctx.onTab(function (i) {
            if (i !== page) {
                page = i;
                // auto-load data for selected ECU pages
                if (page === 1 && selectedIdx >= 0) {
                    if (ecuDetail.length === 0) loadDetail();
                    if (!servicesLoaded) loadServices();
                }
                if (page === 3 && selectedIdx >= 0 && faults === null) loadFaults();
                changed();
            }
        });
        ctx.onLayout(changed);
        settings.onChange(function () { changed(); });

        setTimeout(function () { doScan(); }, 1500);

        setInterval(function () {
            if ((logging || didScanning) && ui.isVisible('MAIN')) changed();
        }, 2000);

        var loop = ctx.loop('MAIN', 2, function () { return render(false); });
        var redraw = function () { changed(); setTimeout(changed, 600); };
        ui.onVisible(function (name, on) { if (name === 'MAIN' && on) redraw(); });
        if (ui.onFocus) ui.onFocus(function (name, on) { if (name === 'MAIN' && on) redraw(); });
        render(true).then(function () { log.info('first frame done'); }).catch(function (e) { log.warn('first render: ' + e); });
    },
});
