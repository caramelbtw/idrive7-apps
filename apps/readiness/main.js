'use strict';
/**
 * Readiness - emissions readiness monitors and emission faults, and the driving that completes what's left.
 *
 * Pages (header tabs):
 *   Readiness   a verdict (READY / NOT READY / check engine lamp on), a progress bar with a segment per monitor this
 *               car has, the check engine lamp and fault count, how far / how many warm-ups since faults were
 *               cleared; the monitors (misfire, fuel system, components, catalyst, heated catalyst, evaporative
 *               system, secondary air, A/C refrigerant, oxygen sensor, oxygen sensor heater, EGR) as complete /
 *               incomplete / not supported; and the driving style to complete the rest.
 *   Faults      the engine unit(s)' and gearbox's fault memory as BMW's own tools show it: BMW hex codes (140300 ...)
 *               from UDS 19 02 with BMW's text (bmw.js), the readiness monitor each one belongs to and its state
 *               (active, check engine lamp, stored, pending). Faults that belong to a monitor come first. Any
 *               generic OBD-II codes (P0xxx: services 03 / 07 / 0A) the car also reports are listed with them.
 *   Drive plan  the steps that complete the incomplete monitors, in the order to do them (monitors.js plan()).
 *
 * Heated catalyst, secondary air and A/C refrigerant are optional: the first answer the car gives says whether it
 * has them, and the ones it lacks are left out from then on. Any other monitor it lacks is shown "not supported" and
 * not counted.
 *
 * READ ONLY by construction: every request goes through link.js, which refuses anything but OBD-II 01 (a fixed list
 * of PIDs), 03, 07 and 0A, UDS 19 02 (read fault memory), 22 F1 50 (unit type), 22 F4 <PID> (the PIDs of 01 as UDS
 * identifiers: how BMW engine units answer them) and 10 03 (extended diagnostic session, for units that lock the F4xx
 * DIDs behind it), to the engine unit(s) and gearbox. No clear, no write, no routine, no
 * actuation, and no car signal is set. It asks only while its screen is shown: readiness every 10 s, the rest every
 * 30 s, and everything again on Refresh. Nothing is stored on disk.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { fitText } = require('./kit/text-layout');
const { ReadinessLink, UNITS, ALL } = require('./link');
const M = require('./monitors');
const DEMO = require('./demo');
const BMW = require('./bmw');
const TP = require('./transport-probe');

const W = 1600, H = 520;
const GO = '#2fd27a';
const ENGINES = [0x12, 0x13];
const READ_MS = 10000, SLOW_MS = 30000;
const BMW_MASK = 0x0C;            // 19 02 status mask: pending and confirmed (stored) faults, as Fault Scanner's "Current"
const TABS = ['Readiness', 'Faults', 'Drive plan', 'Probe', 'Sweep', 'Transport'];
const PLAN_PER_PAGE = 4;
const PROBE_PER_PAGE = 14;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const link = new ReadinessLink(ctx.signals, log);
        link.init().catch((e) => log.warn('diagnostic link: ' + e));
        const useDemo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !link.available);

        /* ---------- state ---------- */
        let S = fresh();
        function fresh(demo) {
            return {
                demo: !!demo,
                phase: 'idle',             // idle | connecting | ok | noanswer | error
                units: {},                 // engine address -> { pids: Set, via: 'uds' (22 F4xx) | 'obd' (01) }
                why: {},                   // address -> { request: what it replied } (shown when nothing answers)
                gearbox: true,             // asked for faults until it doesn't answer
                since: null, cycle: null,  // merged readiness: since faults cleared (01) / this drive (41)
                keep: null,                // the optional monitors this car has (fixed at the first answer)
                stats: {},                 // warmups, dist (km), mins: since faults were cleared
                types: {},                 // address -> unit type (DME8FF_R ...) or '' (22 F1 50 once; picks BMW texts)
                faults: null,              // [{ code, text, system, systemName, unit, label, sev, bmw }] (see readFaults)
                readAt: 0, slowAt: 0, error: '',
                probe: null,               // { rows: [{ section, label, req, detail, err }], step, done }
                sweep: null,               // { hits: [{ did, hex, data, len }], step, done, ranges, total, scanned }
                transport: null,           // { results: [{ test, ok, detail, error, raw }], step, done, summary }
            };
        }
        let page = 0, planPage = 0, probePage = 0, version = 0, busy = false, forced = false, probing = false, sweeping = false, transportProbing = false;
        const changed = () => { version++; if (loop) loop.kick(); };

        /** one request: the demo car's reply or the real unit's (null: no answer) */
        async function ask(addr, sid, data) {
            if (S.demo) { await sleep(30); return DEMO.reply(addr, sid, data); }
            try { return await link.ask(addr, sid, data); } catch (e) { log.warn('ask ' + addr.toString(16) + ': ' + e.message); return null; }
        }
        /** the same to every unit at once (as an OBD-II scan tool asks): Map(address -> reply) */
        async function askAll(sid, data, want) {
            if (S.demo) { await sleep(30); const m = new Map(), r = DEMO.reply(0x12, sid, data); if (r) m.set(0x12, r); return m; }
            try { return await link.askAll(sid, data, want); } catch (e) { log.warn('ask all: ' + e.message); return new Map(); }
        }
        const NRC = { 0x10: 'rejected', 0x11: 'service not supported', 0x12: 'not supported', 0x13: 'bad length', 0x21: 'busy',
            0x22: 'conditions not correct', 0x31: 'not available', 0x7E: 'not in this session', 0x7F: 'not in this session' };
        const note = (addr, what, u) => {
            (S.why[addr] || (S.why[addr] = {}))[what] = !u ? 'no reply' : u[0] === 0x7F ? 'refused (' + (NRC[u[2]] || 'NRC ' + u[2].toString(16).toUpperCase()) + ')' : 'unexpected reply';
        };
        const why = (addr) => Object.keys(S.why[addr] || {}).map((k) => k + ': ' + S.why[addr][k]).join(' · ');
        const h2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

        /**
         * One OBD-II PID from an engine unit: its data bytes (after the PID), or null. BMW engine units usually give
         * OBD data as UDS identifiers (22 F4 <PID>) over this link; others answer 01; some answer neither when asked
         * on their own, only when every unit is asked at once as an OBD-II scan tool does ('all-obd' / 'all-uds', for
         * the engine unit only). 'via' fixes the one that answered; until then each is tried in turn.
         */
        const VIAS = { 0x12: ['uds', 'obd', 'all-obd', 'all-uds', 'ext-uds', 'ext-obd'] };
        async function pid(addr, p, via) {
            for (const v of via ? [via] : VIAS[addr] || ['uds', 'obd']) {
                if (v.startsWith('ext-')) await link.session(addr);
                const uds = v === 'uds' || v === 'all-uds' || v === 'ext-uds', sid = uds ? 0x22 : 0x01, req = uds ? [0xF4, p] : [p];
                let u;
                if (v.startsWith('all-')) {
                    const m = await askAll(sid, req, addr);
                    // the engine unit's answer; else the first positive one from a unit other than the gearbox
                    u = m.get(addr) || [...m].filter(([a, r]) => a !== 0x18 && r[0] !== 0x7F).map(([, r]) => r)[0] || null;
                } else u = await ask(addr, sid, req);
                if (uds && u && u[0] === 0x62 && u[1] === 0xF4 && u[2] === p) return { via: v, data: u.slice(3) };
                if (!uds && u && u[0] === 0x41 && u[1] === p) return { via: v, data: u.slice(2) };
                const prefix = v.startsWith('all-') ? 'all ' : v.startsWith('ext-') ? 'ext ' : '';
                note(addr, prefix + (uds ? '22 F4' + h2(p) : '01 ' + h2(p)), u);
                if (!u && addr !== 0x12) break;            // silence from a second engine unit: there is none (no 2 s more)
            }
            return null;
        }

        /** which engine units give readiness, how (22 F4xx or 01), and the PIDs each one supports (00 -> 20 -> 40) */
        async function discover() {
            S.units = {};
            S.why = {};
            for (const addr of ENGINES) {
                // readiness itself first (some units don't list their PIDs), then the PIDs it has, asked the same way
                const r = await pid(addr, 0x01, null);
                if (!r || r.data.length < 4) continue;
                const pids = new Set([0x01]);
                for (let base = 0x00; base <= 0x40; base += 0x20) {
                    if (base && !pids.has(base)) break;
                    const m = await pid(addr, base, r.via);
                    if (!m || m.data.length < 4) break;
                    for (let i = 0; i < 32; i++) if (m.data[i >> 3] & (0x80 >> (i & 7))) pids.add(base + i + 1);
                }
                S.units[addr] = { pids, via: r.via };
            }
            // trying every way isn't the unit being asleep: its fault memory is still asked for right after
            link.wake();
            const by = { uds: '22 F4xx', obd: '01', 'all-obd': '01 to all units', 'all-uds': '22 F4xx to all units' };
            Object.keys(S.units).forEach((a) => log.info('unit ' + Number(a).toString(16) + ': readiness by ' + by[S.units[a].via]));
            if (!S.units[0x12]) log.info('engine unit: no readiness (' + why(0x12) + ')');
            return Object.keys(S.units).length > 0;
        }

        async function readReadiness() {
            const since = [], cycle = [];
            for (const a of Object.keys(S.units).map(Number)) {
                const u = S.units[a];
                const r = await pid(a, 0x01, u.via);
                if (r && r.data.length >= 4) since.push(M.readiness(r.data));
                if (u.pids.has(0x41)) {
                    const c = await pid(a, 0x41, u.via);
                    if (c && c.data.length >= 4) cycle.push(M.readiness(c.data));
                }
            }
            if (!since.length) return false;
            S.since = M.merge(since);
            S.cycle = M.merge(cycle);
            if (!S.keep) { S.keep = M.optionalPresent(S.since); log.info('optional monitors on this car: ' + (S.keep.join(', ') || 'none')); }
            S.readAt = Date.now();
            return true;
        }

        async function readStats() {
            const u = S.units[0x12] || S.units[0x13];
            if (!u) return;
            const addr = S.units[0x12] ? 0x12 : 0x13, st = {};
            const num = async (p, n) => {
                if (!u.pids.has(p)) return null;
                const r = await pid(addr, p, u.via);
                return r && r.data.length >= n ? (n === 2 ? (r.data[0] << 8) | r.data[1] : r.data[0]) : null;
            };
            st.warmups = await num(0x30, 1);
            st.dist = await num(0x31, 2);
            st.mins = await num(0x4E, 2);
            S.stats = st;
        }

        /** the unit type of each unit, once (its BMW fault texts depend on it) */
        async function identify(addrs) {
            for (const a of addrs) {
                if (S.types[a] !== undefined) continue;
                const r = await ask(a, 0x22, [0xF1, 0x50]);
                if (!r) continue;                                      // no answer: asked again next time
                const idx = r[0] === 0x62 && r.length >= 6 ? ((r[3] << 16) | (r[4] << 8) | r[5]).toString(16).toUpperCase().padStart(6, '0') : '';
                S.types[a] = BMW.variant(a, idx) || '';
                log.info('unit ' + a.toString(16) + ': type ' + (S.types[a] || 'unknown') + (idx ? ' (' + idx + ')' : ''));
            }
        }

        /**
         * Fault memory: BMW's (19 02: what BMW's tools show) and the generic OBD-II one (03 / 07 / 0A), from the engine
         * unit(s) and the gearbox. Each fault: { code, text, system (monitor key or null), systemName, unit, label, sev
         * ('crit' | 'warn'), bmw }. Kept as it was when no unit answered at all.
         */
        async function readFaults() {
            // the engine unit(s) that give readiness; the engine unit anyway when none does (its fault memory still answers)
            const engines = Object.keys(S.units).map(Number);
            const out = [], units = (engines.length ? engines : [0x12]).concat(S.gearbox ? [0x18] : []);
            let answered = false;
            await identify(units);
            for (const addr of units) {
                // BMW fault memory
                const r = await ask(addr, 0x19, [0x02, BMW_MASK]);
                if (addr === 0x18 && r === null) { S.gearbox = false; continue; }
                const list = BMW.parse(r);
                if (!list) note(addr, '19 02', r);
                if (list) {
                    answered = true;
                    list.forEach((d) => {
                        const st = BMW.status(d.status);
                        if (st.kind === 'history') return;
                        const text = BMW.text(addr, d.code, S.types[addr]), sys = BMW.system(text);
                        out.push({ code: d.code, text: text || 'BMW fault ' + d.code, system: sys, systemName: sys ? M.monitorName(sys) : 'Other',
                            unit: UNITS[addr], label: st.label, sev: st.sev, bmw: true });
                    });
                }
                // generic OBD-II codes, where the unit gives any
                for (const [sid, label, sev] of [[0x03, 'CONFIRMED', 'crit'], [0x07, 'PENDING', 'warn'], [0x0A, 'PERMANENT', 'crit']]) {
                    const codes = M.dtcs(await ask(addr, sid, []), sid);
                    if (!codes) continue;
                    answered = true;
                    codes.forEach((c) => {
                        const k = M.classify(c);
                        out.push({ code: c, text: k.text, system: k.system === 'other' ? null : k.system, systemName: k.systemName, unit: UNITS[addr], label, sev, bmw: false });
                    });
                }
            }
            if (answered) {
                // what belongs to a monitor first, then the worse state, then BMW's codes before OBD's
                const rank = (f) => (f.system ? 0 : 4) + (f.sev === 'crit' ? 0 : 2) + (f.bmw ? 0 : 1);
                S.faults = out.sort((a, b) => rank(a) - rank(b));
            }
        }

        /** one pass: whatever is due (all of it after Refresh) */
        async function poll() {
            if (busy || probing || sweeping || !ui.isVisible('MAIN')) return;
            busy = true;
            try {
                const demo = useDemo();
                if (demo !== S.demo) { S = fresh(demo); }
                const now = Date.now();
                if (forced) { forced = false; S.readAt = 0; S.slowAt = 0; link.wake(); if (S.phase !== 'ok') S.phase = 'idle'; S.gearbox = true; }
                if (S.phase === 'idle' || S.phase === 'noanswer' || S.phase === 'error') {
                    if (S.phase === 'noanswer' && now - S.readAt < SLOW_MS && S.readAt) return;
                    if (S.phase === 'noanswer') link.wake();          // try again every 30 s (ignition may be on now)
                    S.phase = 'connecting'; changed();
                    if (!S.demo && !link.ready) {
                        if (link.failed) { S.phase = 'error'; S.error = 'No diagnostic link on this head unit (' + link.failed + ')'; S.readAt = now; }
                        else S.phase = 'idle';                          // still connecting: next second
                        return;
                    }
                    if (await discover()) S.phase = 'ok';
                    else { S.phase = 'noanswer'; S.readAt = now; }
                }
                if (S.phase === 'ok' && now - S.readAt >= READ_MS) {
                    if (!(await readReadiness())) { S.phase = 'noanswer'; S.readAt = now; }
                    changed();
                }
                if (now - S.slowAt >= SLOW_MS) {
                    S.slowAt = now;
                    if (S.phase === 'ok') { await readStats(); changed(); }
                    await readFaults(); changed();
                }
            } catch (e) {
                log.warn('poll: ' + e);
            } finally { busy = false; changed(); }
        }
        setInterval(poll, 1000);

        /* ---------- derived ---------- */
        const units = () => settings.get('units') || 'kmh';
        const dist = (km) => (units() === 'mph' ? Math.round(km / 1.609) + ' mi' : km + ' km');
        const view = () => {
            const rows = M.rows(S.since, S.cycle, S.keep), pr = M.progress(rows);
            // a stored or active fault of a readiness system keeps its monitor (and ones that depend on it) from running
            const blocking = (S.faults || []).filter((f) => f.system && f.label !== 'PENDING').length;
            const faultsOn = (S.since ? S.since.count > 0 : false) || blocking > 0;
            return { rows, pr, faultsOn, plan: M.plan(rows, faultsOn, units()) };
        };
        function verdict(t, v) {
            if (S.phase === 'error') return { text: 'NO LINK', col: t.dim };
            if (!S.since) return { text: S.phase === 'noanswer' ? 'NO ANSWER' : 'READING...', col: t.dim };
            if (S.since.mil) return { text: 'CHECK ENGINE ON', col: t.crit };
            if (!v.pr.pending.length) return { text: 'READY', col: GO };
            if (v.pr.pending.length === 1) return { text: 'ALMOST READY', col: t.warn };
            return { text: 'NOT READY', col: t.warn };
        }
        const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 5 ? 'just now' : s < 90 ? s + ' s ago' : Math.round(s / 60) + ' min ago'; };

        /* ---------- drawing ---------- */
        function wrap(cv, text, size, width, opts) {
            const out = [];
            let line = '';
            String(text).split(' ').forEach((w) => {
                const next = line ? line + ' ' + w : w;
                if (line && cv.textWidth(next, size, opts) > width) { out.push(line); line = w; } else line = next;
            });
            if (line) out.push(line);
            return out;
        }

        /** status mark: a filled disc with a tick (done), a ring (pending), a dash (not supported) */
        function mark(cv, t, cx, cy, state) {
            if (state === 'done') {
                cv.circle(cx, cy, 13, GO);
                cv.line(cx - 6, cy + 1, cx - 2, cy + 5, 3, t.bg);
                cv.line(cx - 2, cy + 5, cx + 6, cy - 4, 3, t.bg);
            } else if (state === 'pending') {
                cv.arc(cx, cy, 9.5, 13, 0, 360, t.warn);
                cv.circle(cx, cy, 3.5, t.warn);
            } else {
                cv.arc(cx, cy, 11, 13, 0, 360, withAlpha(t.dim, 0.6));
                cv.fillRect(cx - 6, cy - 1.5, 12, 3, t.dim);
            }
        }

        function progressBar(cv, t, x, y, w, h, rows) {
            const sup = rows.filter((r) => r.state !== 'na');
            if (!sup.length) { cv.roundRect(x, y, w, h, h / 2, t.track); return; }
            const gap = 6, sw = (w - gap * (sup.length - 1)) / sup.length;
            // done first, then the rest: the bar fills from the left
            sup.slice().sort((a, b) => (a.state === 'done' ? 0 : 1) - (b.state === 'done' ? 0 : 1)).forEach((r, i) => {
                const sx = x + i * (sw + gap);
                if (r.state === 'done') cv.roundRect(sx, y, sw, h, 6, GO);
                else { cv.roundRect(sx, y, sw, h, 6, t.track); cv.strokeRoundRect(sx, y, sw, h, 6, 1.5, withAlpha(t.warn, 0.55)); }
            });
        }

        function drawSummary(cv, t, v) {
            const p = G.panel(cv, t, 24, 44, 1552, 132, null), vd = verdict(t, v);
            cv.text(vd.text, 48, 104, vd.text.length > 12 ? 36 : 44, vd.col, { font: 'bold', spacing: 2 });
            const sub = S.since ? v.pr.done + ' of ' + v.pr.total + ' monitors complete'
                : S.phase === 'error' ? S.error : S.phase === 'noanswer' ? 'Engine unit not answering' : 'Asking the engine unit...';
            cv.text(sub, 48, 146, 24, t.dim);

            // progress
            const bx = 540, bw = 640;
            cv.text('READINESS', bx, 76, 18, t.dim, { font: 'bold', spacing: 1.5 });
            progressBar(cv, t, bx, 88, bw, 26, v.rows);
            const pct = v.pr.total ? Math.round(v.pr.done / v.pr.total * 100) : null;
            cv.text(G.isNum(pct) ? pct + '%' : '--', bx + bw + 130, 116, 40, G.isNum(pct) ? (pct === 100 ? GO : t.text) : t.dim, { font: 'num', align: 'right' });
            const st = S.stats, bits = [];
            if (G.isNum(st.dist)) bits.push(dist(st.dist));
            if (G.isNum(st.warmups)) bits.push(st.warmups + ' warm-ups');
            if (G.isNum(st.mins)) bits.push(Math.floor(st.mins / 60) + ' h ' + (st.mins % 60) + ' min');
            cv.text(bits.length ? 'Since faults cleared: ' + bits.join(' · ') : S.since ? 'Updated ' + ago(S.readAt) : '', bx, 148, 20, t.dim);

            // check engine lamp + faults
            const mil = S.since ? S.since.mil : null, mc = mil ? t.crit : mil === false ? GO : t.dim;
            G.pill(cv, t, 1360, 66, 192, 40, mil ? 'MIL ON' : mil === false ? 'MIL OFF' : 'MIL --', { color: mc, size: 20 });
            // faults of the readiness systems (the rest: Faults page)
            const em = S.faults ? S.faults.filter((f) => f.system) : null;
            const n = em ? em.filter((f) => f.label !== 'PENDING').length : null, pend = em ? em.length - n : 0;
            const ft = n === null ? 'Faults --' : n ? n + (n === 1 ? ' emission fault' : ' emission faults') : pend ? pend + ' pending' : 'No emission faults';
            cv.text(ft, 1552, 148, 22, n ? t.crit : pend ? t.warn : n === 0 ? GO : t.dim, { align: 'right', font: 'bold' });
            return p;
        }

        function drawMonitors(cv, t, v) {
            const p = G.panel(cv, t, 24, 192, 1000, 320, 'Monitors');
            if (!v.rows.length) {
                const msg = S.phase === 'error' ? 'This head unit has no diagnostic link. Demo data: Settings.'
                    : S.phase === 'noanswer' ? 'The engine unit gave no readiness. Switch the ignition on (engine running is best), then Refresh.' : 'Reading...';
                const lines = wrap(cv, msg, 24, 900);
                lines.forEach((l, i) => cv.text(l, 48, 290 + i * 34, 24, t.dim));
                // what each unit said, so a refusal can be told from silence
                if (S.phase === 'noanswer') {
                    let y = 300 + lines.length * 34 + 8;
                    ENGINES.forEach((a) => {
                        if (!S.why[a]) return;
                        wrap(cv, UNITS[a] + ' · ' + why(a), 18, 940).slice(0, 2).forEach((l) => {
                            if (y < p.y + p.h - 10) cv.text(fitText(cv, l, 18, 940), 48, y, 18, t.dim);
                            y += 24;
                        });
                    });
                }
                return;
            }
            const per = Math.ceil(v.rows.length / 2), rh = Math.min(44, Math.floor((p.h - 70) / per));
            v.rows.forEach((r, i) => {
                const col = i < per ? 0 : 1, x = 44 + col * 488, y = 248 + (i % per) * rh, w = 472, h = rh - 6;
                const c = r.state === 'done' ? GO : r.state === 'pending' ? t.warn : t.dim;
                cv.roundRect(x, y, w, h, 8, withAlpha(c, r.state === 'na' ? 0.05 : 0.1));
                mark(cv, t, x + 24, y + h / 2, r.state);
                cv.text(r.name, x + 50, y + h / 2 + 8, 22, r.state === 'na' ? t.dim : t.text);
                const lbl = r.state === 'done' ? 'COMPLETE' : r.state === 'pending' ? 'INCOMPLETE' : 'NOT SUPPORTED';
                cv.text(lbl, x + w - 14, y + h / 2 + 7, 18, c, { align: 'right', font: 'bold', spacing: 1 });
            });
        }

        function drawAdvice(cv, t, v) {
            const p = G.panel(cv, t, 1040, 192, 536, 320, 'Recommended driving'), x = 1064;
            if (!S.since) { cv.text('--', x, 300, 40, t.dim, { font: 'bold' }); return; }
            const pl = v.plan;
            if (!pl.pending && !v.faultsOn) {
                cv.text('Drive normally', x, 290, 36, GO, { font: 'bold' });
                wrap(cv, 'Every monitor is complete: the car is ready for an emissions inspection.', 22, 488).forEach((l, i) => cv.text(l, x, 336 + i * 30, 22, t.dim));
                return;
            }
            cv.text('NOW', x, 262, 18, t.dim, { font: 'bold', spacing: 2 });
            cv.text(fitText(cv, pl.style ? pl.style.style : '--', 36, 488, { font: 'bold' }), x, 304, 36, v.faultsOn ? t.crit : t.accent2 || t.accent, { font: 'bold' });
            const steps = pl.steps.slice(0, 3);
            steps.forEach((s, i) => {
                const y = 344 + i * 44;
                cv.circle(x + 14, y + 10, 14, withAlpha(t.text, 0.12));
                cv.text(String(i + 1), x + 14, y + 17, 18, t.text, { font: 'bold', align: 'center' });
                cv.text(fitText(cv, s.short, 22, 450), x + 40, y + 18, 22, t.text);
            });
            const more = pl.steps.length - steps.length;
            cv.text(more > 0 ? '+' + more + ' more on Drive plan' : 'Details on Drive plan', x, p.y + p.h - 22, 18, t.dim);
        }

        function drawFaults(cv, t) {
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Engine and gearbox faults'), list = S.faults;
            cv.text('BMW fault memory · read only: this app never clears faults', 1552, 86, 18, t.dim, { align: 'right' });
            if (!list) {
                const msg = S.phase === 'noanswer' ? 'No answer. Switch the ignition on, then Refresh.' : S.phase === 'error' ? S.error : 'Reading fault memory...';
                cv.text(msg, 48, 200, 26, t.dim);
                return;
            }
            if (!list.length) {
                cv.circle(800, 250, 40, GO);
                cv.line(782, 252, 794, 264, 7, t.bg); cv.line(794, 264, 818, 238, 7, t.bg);
                cv.text('No faults stored', 800, 340, 36, GO, { font: 'bold', align: 'center' });
                cv.text('The engine and gearbox fault memories have no stored or pending faults', 800, 380, 22, t.dim, { align: 'center' });
                return;
            }
            const cols = [[48, 'CODE'], [190, 'DESCRIPTION'], [930, 'SYSTEM'], [1190, 'UNIT']];
            cols.forEach(([cx, h]) => cv.text(h, cx, 128, 18, t.dim, { font: 'bold', spacing: 1.5 }));
            const per = Math.floor((p.h - 110) / 48), shown = list.slice(0, per);
            shown.forEach((f, i) => {
                const y = 142 + i * 48, c = f.sev === 'crit' ? t.crit : t.warn;
                cv.roundRect(40, y, 1520, 42, 8, withAlpha(f.system ? c : t.dim, f.system ? 0.1 : 0.07));
                cv.fillRect(40, y, 5, 42, f.system ? c : t.dim);
                cv.text(f.code, 58, y + 30, 24, t.text, { font: 'bold', spacing: 1 });
                cv.text(fitText(cv, f.text, 22, 720), 190, y + 29, 22, t.text);
                cv.text(fitText(cv, f.systemName, 22, 240), 930, y + 29, 22, f.system ? t.text : t.dim);
                cv.text(fitText(cv, f.unit, 22, 190), 1190, y + 29, 22, t.dim);
                G.pill(cv, t, 1400, y + 6, 148, 30, f.label, { color: c, size: 16, spacing: 1 });
            });
            if (list.length > shown.length) cv.text('+' + (list.length - shown.length) + ' more', 1552, p.y + p.h - 18, 20, t.dim, { align: 'right' });
        }

        function drawPlan(cv, t, v) {
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Drive plan'), pl = v.plan;
            if (!S.since) { cv.text(S.phase === 'noanswer' ? 'No answer from the engine unit.' : 'Reading...', 48, 200, 26, t.dim); return; }
            const cyc = v.rows.filter((r) => r.state !== 'na' && r.drive === 'done').length;
            const head = (pl.pending ? pl.pending + (pl.pending === 1 ? ' monitor' : ' monitors') + ' incomplete' : 'All monitors complete') +
                (S.cycle ? ' · this drive so far: ' + cyc + ' complete' : '');
            cv.text(head, 1552, 86, 20, t.dim, { align: 'right' });
            if (!pl.steps.length) {
                cv.text('Nothing to do: drive normally.', 48, 200, 30, GO, { font: 'bold' });
                return;
            }
            const pages = Math.ceil(pl.steps.length / PLAN_PER_PAGE);
            planPage = Math.min(planPage, pages - 1);
            const steps = pl.steps.slice(planPage * PLAN_PER_PAGE, (planPage + 1) * PLAN_PER_PAGE);
            steps.forEach((s, i) => {
                const y = 112 + i * 98, n = planPage * PLAN_PER_PAGE + i + 1, fault = s.id === 'fault';
                const c = fault ? t.crit : t.accent2 || t.accent;
                cv.roundRect(40, y, 1520, 90, 10, withAlpha(c, 0.07));
                cv.circle(76, y + 32, 20, withAlpha(c, 0.25));
                cv.text(String(n), 76, y + 40, 22, t.text, { font: 'bold', align: 'center' });
                cv.text(s.style, 112, y + 34, 24, fault ? t.crit : t.text, { font: 'bold' });
                wrap(cv, s.text, 18, 1060).slice(0, 2).forEach((l, k) => cv.text(l, 112, y + 60 + k * 22, 18, t.dim));
                // the monitors it completes, as chips on the right
                let cx = 1548;
                s.covers.slice(0, 3).forEach((name) => {
                    const w = cv.textWidth(name, 16, { font: 'bold' }) + 24;
                    if (cx - w < 1190) return;
                    G.pill(cv, t, cx - w, y + 14, w, 28, name, { color: t.warn, size: 16, spacing: 0 });
                    cx -= w + 8;
                });
            });
            if (pages > 1) cv.text('Page ' + (planPage + 1) + ' of ' + pages + ' · Next page for more', 1552, p.y + p.h - 18, 18, t.dim, { align: 'right' });
        }

        /* ---------- diagnostic probe ---------- */
        const PROBE_PIDS = [0x00, 0x01, 0x20, 0x30, 0x31, 0x40, 0x41, 0x4E];
        const PID_NAMES = { 0x00: 'Supported 00-1F', 0x01: 'Monitor status', 0x20: 'Supported 20-3F', 0x30: 'Warm-ups', 0x31: 'Distance', 0x40: 'Supported 40-5F', 0x41: 'This drive', 0x4E: 'Time since clear' };

        async function runProbe() {
            if (probing) return;
            probing = true;
            link.wake();
            const p = { rows: [], step: 'Starting...', done: false };
            S.probe = p;
            changed();

            const hxr = (u, max) => u ? u.slice(0, max || 12).map((b) => h2(b)).join(' ') + (u.length > (max || 12) ? ' ..' : '') : '--';
            const nrc = (u) => !u ? null : u[0] === 0x7F ? (NRC[u[2]] || 'NRC ' + h2(u[2])) : null;
            const pos = (u) => u && u[0] !== 0x7F;
            const add = (section, label, req, detail, err) => { p.rows.push({ section, label, req, detail, err: err || '' }); changed(); };

            try {
                // functional broadcasts
                p.step = 'Broadcasting OBD...'; changed();
                const fObd = await askAll(0x01, [0x00]);
                p.step = 'Broadcasting UDS...'; changed();
                const fUds = await askAll(0x22, [0xF4, 0x00]);
                add(true, 'FUNCTIONAL BROADCAST', '', '', '');
                const fmtMap = (m) => {
                    const ok = [...m.keys()].filter((a) => pos(m.get(a)));
                    const bad = [...m.keys()].filter((a) => !pos(m.get(a)));
                    return { ok, bad, detail: ok.length ? ok.map((a) => '0x' + h2(a)).join(' ') + ' answered' : 'no replies',
                        err: bad.length ? bad.map((a) => '0x' + h2(a) + ': ' + (nrc(m.get(a)) || '?')).join(', ') : '' };
                };
                const ob = fmtMap(fObd), ub = fmtMap(fUds);
                add(false, 'OBD 01 00 to all', '01 00', ob.detail, ob.err);
                add(false, 'UDS 22 F400 to all', '22 F4 00', ub.detail, ub.err);

                // per unit: deep probe
                for (const addr of [0x12, 0x13, 0x18]) {
                    const name = UNITS[addr];
                    p.step = name + '...'; changed();

                    // identify
                    const ident = await ask(addr, 0x22, [0xF1, 0x50]);
                    if (!ident) { add(true, name + ' (0x' + h2(addr) + ')', '', 'not present — no reply', ''); continue; }
                    const idx = ident[0] === 0x62 && ident.length >= 6 ? ((ident[3] << 16) | (ident[4] << 8) | ident[5]).toString(16).toUpperCase().padStart(6, '0') : '';
                    const type = BMW.variant(addr, idx) || '';
                    const heading = type ? type + ' (' + idx + ')' : idx || 'present';
                    add(true, name + ' (0x' + h2(addr) + ')', '', heading, nrc(ident) || '');
                    add(false, 'Identify', '22 F1 50', pos(ident) ? hxr(ident) : '--', nrc(ident) || '');

                    // extended session
                    const sess = await ask(addr, 0x10, [0x03]);
                    const extOk = sess && sess[0] === 0x50;
                    add(false, 'Ext session', '10 03', extOk ? 'accepted' : '--', nrc(sess) || (!sess ? 'no reply' : ''));

                    // UDS readiness PIDs in default session
                    p.step = name + ' UDS PIDs...'; changed();
                    add(false, '— UDS (default session)', '', '', '');
                    const udsResults = {};
                    for (const pid of PROBE_PIDS) {
                        const u = await ask(addr, 0x22, [0xF4, pid]);
                        udsResults[pid] = u;
                        const ok = pos(u);
                        add(false, '  ' + PID_NAMES[pid], '22 F4 ' + h2(pid), ok ? (u.length - 3) + 'B: ' + hxr(u.slice(3), 8) : '--', nrc(u) || (!u ? 'no reply' : ''));
                    }

                    // UDS PIDs after extended session (only if ext was accepted and at least one PID failed)
                    const anyUdsFailed = PROBE_PIDS.some((pid) => !pos(udsResults[pid]));
                    if (extOk && anyUdsFailed) {
                        p.step = name + ' UDS ext...'; changed();
                        await link.session(addr);
                        add(false, '— UDS (after 10 03)', '', '', '');
                        for (const pid of PROBE_PIDS) {
                            if (pos(udsResults[pid])) continue;
                            const u = await ask(addr, 0x22, [0xF4, pid]);
                            const ok = pos(u);
                            add(false, '  ' + PID_NAMES[pid], '22 F4 ' + h2(pid), ok ? (u.length - 3) + 'B: ' + hxr(u.slice(3), 8) : '--', nrc(u) || (!u ? 'no reply' : ''));
                        }
                    }

                    // OBD PIDs
                    p.step = name + ' OBD PIDs...'; changed();
                    add(false, '— OBD', '', '', '');
                    for (const pid of PROBE_PIDS) {
                        const u = await ask(addr, 0x01, [pid]);
                        const ok = pos(u);
                        add(false, '  ' + PID_NAMES[pid], '01 ' + h2(pid), ok ? (u.length - 2) + 'B: ' + hxr(u.slice(2), 8) : '--', nrc(u) || (!u ? 'no reply' : ''));
                    }

                    // DTC services
                    p.step = name + ' faults...'; changed();
                    add(false, '— Fault services', '', '', '');

                    const f19 = await ask(addr, 0x19, [0x02, BMW_MASK]);
                    const nd = f19 && f19[0] === 0x59 ? Math.floor((f19.length - 3) / 4) : null;
                    add(false, '  BMW faults', '19 02', nd !== null ? nd + ' DTCs' : '--', nrc(f19) || (!f19 ? 'no reply' : ''));

                    for (const dtcSid of [0x03, 0x07, 0x0A]) {
                        const dtcName = { 0x03: 'Confirmed P-codes', 0x07: 'Pending P-codes', 0x0A: 'Permanent P-codes' }[dtcSid];
                        const u = await ask(addr, dtcSid, []);
                        const ok = pos(u);
                        const count = ok && u.length >= 2 ? Math.floor((u.length - 1) / 2) : null;
                        add(false, '  ' + dtcName, h2(dtcSid), ok ? (count || 0) + ' codes' : '--', nrc(u) || (!u ? 'no reply' : ''));
                    }
                }
            } catch (e) { log.warn('probe: ' + e); }

            p.step = '';
            p.done = true;
            probing = false;
            changed();
        }

        function drawProbe(cv, t) {
            const ERR_COLOR = '#e05555';
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Diagnostic Probe');
            const sub = S.probe ? (S.probe.done ? S.probe.rows.length + ' rows · Refresh to re-scan' : S.probe.step || 'Scanning...') : 'Press Refresh to scan';
            cv.text(sub, 1552, 86, 18, t.dim, { align: 'right' });

            if (!S.probe || !S.probe.rows.length) {
                cv.text(S.probe ? 'Scanning the diagnostic bus...' : 'Navigate here and press Refresh to probe the diagnostic bus.', 48, 200, 24, t.dim);
                return;
            }

            // columns: label | req | detail | error
            const rows = S.probe.rows, rh = 26, maxRows = Math.min(PROBE_PER_PAGE, Math.floor((p.h - 70) / rh));
            const pages = Math.ceil(rows.length / maxRows) || 1;
            probePage = Math.min(probePage, pages - 1);
            const shown = rows.slice(probePage * maxRows, (probePage + 1) * maxRows);

            // column headers
            cv.text('Request', 330, 100, 14, withAlpha(t.dim, 0.6), { font: 'num' });
            cv.text('Result', 530, 100, 14, withAlpha(t.dim, 0.6));
            cv.text('Error', 1050, 100, 14, withAlpha(ERR_COLOR, 0.6));

            shown.forEach((r, i) => {
                const y = 118 + i * rh;
                if (r.section) {
                    cv.text(r.label, 48, y, 18, t.text, { font: 'bold' });
                    if (r.detail) cv.text(fitText(cv, r.detail, 16, 420), 1130, y, 16, r.detail.indexOf('not present') >= 0 ? t.dim : t.text);
                    if (r.err) cv.text(fitText(cv, r.err, 14, 300), 1050, y, 14, ERR_COLOR);
                } else if (r.label.charAt(0) === '—') {
                    cv.text(r.label, 60, y, 16, withAlpha(t.text, 0.7), { font: 'bold' });
                } else {
                    cv.text(fitText(cv, r.label, 16, 240), 72, y, 16, t.dim);
                    cv.text(r.req, 330, y, 14, withAlpha(t.text, 0.45), { font: 'num' });
                    const good = r.detail !== '--' && !r.err;
                    cv.text(fitText(cv, r.detail, 15, 480), 530, y, 15, good ? GO : t.dim, { font: r.detail.indexOf('B:') >= 0 ? 'num' : undefined });
                    if (r.err) cv.text(fitText(cv, r.err, 14, 480), 1050, y, 14, ERR_COLOR);
                }
            });

            if (pages > 1) cv.text('Page ' + (probePage + 1) + ' of ' + pages, 1552, p.y + p.h - 18, 18, t.dim, { align: 'right' });
        }

        /* ---------- DID sweep ---------- */
        const SWEEP_RANGES = [
            [0xF400, 0xF4FF, 'ISO 27145 OBD-II (F4xx)'],
            [0xF150, 0xF1FF, 'Identification (F1xx)'],
            [0xD000, 0xD0FF, 'BMW live data 1 (D0xx)'],
            [0xD100, 0xD1FF, 'BMW live data 2 (D1xx)'],
            [0xD200, 0xD2FF, 'BMW live data 3 (D2xx)'],
            [0xD300, 0xD3FF, 'BMW diagnostic (D3xx)'],
            [0x1000, 0x10FF, 'Application (10xx)'],
            [0x1800, 0x18FF, 'Application (18xx)'],
            [0x2000, 0x20FF, 'Application (20xx)'],
            [0x2800, 0x28FF, 'Application (28xx)'],
            [0x3000, 0x30FF, 'Application (30xx)'],
            [0xE000, 0xE0FF, 'BMW extended (E0xx)'],
        ];
        let sweepPage = 0;
        const SWEEP_PER_PAGE = 14;
        const fs = typeof require !== 'undefined' ? (function () { try { return require('fs'); } catch (e) { return null; } })() : null;

        async function runSweep() {
            if (sweeping) return;
            sweeping = true;
            link.wake();
            const addr = 0x12;
            const total = SWEEP_RANGES.reduce((s, r) => s + r[1] - r[0] + 1, 0);
            const sw = { hits: [], step: 'Starting...', done: false, ranges: SWEEP_RANGES.map((r) => r[2]), total, scanned: 0, logLines: [] };
            S.sweep = sw;
            sweepPage = 0;
            changed();

            const h4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
            const hxr = (u, max) => u.slice(0, max || 16).map((b) => h2(b)).join(' ') + (u.length > (max || 16) ? ' ..' : '');
            const nrcName = (c) => NRC[c] || 'NRC ' + h2(c);
            const logPath = ctx.dataDir + '/sweep_' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
            const logLine = (line) => { sw.logLines.push(line); if (fs) try { fs.appendFileSync(logPath, line + '\n'); } catch (e) { /* */ } };

            logLine('# DID sweep on 0x' + h2(addr) + ' at ' + new Date().toISOString());
            logLine('# Ranges: ' + SWEEP_RANGES.map((r) => r[2] + ' ' + h4(r[0]) + '-' + h4(r[1])).join(', '));
            logLine('# Format: DID | status | len | hex data');
            logLine('#');

            try {
                // enter extended session first (some DIDs only appear after)
                sw.step = 'Entering ext session...'; changed();
                const extOk = await link.session(addr);
                logLine('# Extended session (10 03): ' + (extOk ? 'accepted' : 'refused/no reply'));

                for (const [lo, hi, label] of SWEEP_RANGES) {
                    sw.step = label + '...'; changed();
                    logLine('#');
                    logLine('# --- ' + label + ' (' + h4(lo) + '-' + h4(hi) + ') ---');

                    for (let did = lo; did <= hi; did++) {
                        // re-enter ext session every 32 DIDs to keep it alive (S3 timeout ~5s)
                        if (extOk && ((did - lo) & 0x1F) === 0 && did !== lo) await link.session(addr);

                        const u = await link.sweep(addr, did);
                        sw.scanned++;
                        if ((sw.scanned & 0x0F) === 0) changed();

                        if (!u) {
                            logLine(h4(did) + ' | no reply |   |');
                            continue;
                        }
                        if (u[0] === 0x7F) {
                            const code = u[2];
                            // only log non-trivial refusals (skip 0x31 not available, 0x11 not supported — they're the norm)
                            if (code !== 0x31 && code !== 0x11 && code !== 0x12 && code !== 0x7E && code !== 0x7F) {
                                logLine(h4(did) + ' | ' + nrcName(code).padEnd(24) + ' |   | ' + hxr(u));
                            } else {
                                logLine(h4(did) + ' | ' + nrcName(code).padEnd(24) + ' |   |');
                            }
                            continue;
                        }
                        // positive reply: 62 <DID hi> <DID lo> <data...>
                        const data = u.length > 3 ? u.slice(3) : [];
                        const hex = hxr(data, 32);
                        logLine(h4(did) + ' | POSITIVE' + ' '.repeat(16) + ' | ' + String(data.length).padStart(2) + ' | ' + hex);
                        sw.hits.push({ did, hex: h4(did), data: data.slice(), len: data.length, raw: hex, range: label });
                        changed();
                    }
                }

                // second pass: retry hits without ext session to see which need it
                if (extOk && sw.hits.length > 0) {
                    sw.step = 'Checking which need ext session...'; changed();
                    logLine('#');
                    logLine('# --- Retry hits in DEFAULT session ---');
                    // wait for ext session to expire
                    await sleep(6000);
                    for (const hit of sw.hits) {
                        const u = await link.sweep(addr, hit.did);
                        const ok = u && u[0] !== 0x7F;
                        hit.needsExt = !ok;
                        logLine(hit.hex + ' | ' + (ok ? 'also in default' : 'NEEDS ext session') + ' | ' + (ok && u.length > 3 ? u.slice(3).length : '--'));
                    }
                }
            } catch (e) { log.warn('sweep: ' + e); logLine('# ERROR: ' + e); }

            logLine('#');
            logLine('# Done. ' + sw.hits.length + ' positive replies out of ' + sw.scanned + ' scanned.');
            logLine('# Hits: ' + sw.hits.map((h) => h.hex).join(', '));
            sw.step = '';
            sw.done = true;
            sweeping = false;
            changed();
            log.info('sweep done: ' + sw.hits.length + ' hits, log at ' + logPath);
        }

        function drawSweep(cv, t) {
            const ERR_COLOR = '#e05555';
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'DID Sweep — Engine 0x12');

            const sw = S.sweep;
            if (!sw) {
                cv.text('Press Refresh to sweep all BMW DID ranges on the engine unit.', 48, 160, 22, t.dim);
                cv.text('This sends ~' + SWEEP_RANGES.reduce((s, r) => s + r[1] - r[0] + 1, 0) + ' read requests (service 22) across ' + SWEEP_RANGES.length + ' ranges.', 48, 200, 18, t.dim);
                cv.text('Replies are logged to a file for matching against MHD.', 48, 230, 18, t.dim);
                cv.text('Ranges: ' + SWEEP_RANGES.map((r) => r[2]).join(' · '), 48, 270, 16, withAlpha(t.dim, 0.6));
                return;
            }

            // progress bar
            const pct = sw.total ? Math.round(100 * sw.scanned / sw.total) : 0;
            const sub = sw.done ? sw.hits.length + ' identifiers found · ' + sw.scanned + ' scanned · Refresh to re-sweep' : sw.step + '  ' + pct + '% (' + sw.scanned + '/' + sw.total + ')';
            cv.text(sub, 1552, 86, 16, t.dim, { align: 'right' });
            if (!sw.done) {
                const bw = 500, bx = 1052, by = 68, bh = 8;
                cv.roundRect(bx, by, bw, bh, 4, withAlpha(t.dim, 0.15));
                if (pct > 0) cv.roundRect(bx, by, Math.max(8, bw * pct / 100), bh, 4, GO);
            }

            if (!sw.hits.length && !sw.done) {
                cv.text('Scanning... no positive replies yet.', 48, 200, 22, t.dim);
                return;
            }
            if (!sw.hits.length && sw.done) {
                cv.text('No positive replies found in any range.', 48, 200, 22, ERR_COLOR);
                return;
            }

            // column headers
            cv.text('DID', 48, 108, 14, withAlpha(t.dim, 0.6), { font: 'num' });
            cv.text('Range', 130, 108, 14, withAlpha(t.dim, 0.6));
            cv.text('Len', 430, 108, 14, withAlpha(t.dim, 0.6));
            cv.text('Data', 490, 108, 14, withAlpha(t.dim, 0.6), { font: 'num' });
            cv.text('Ext?', 1100, 108, 14, withAlpha(t.dim, 0.6));
            cv.text('Readiness?', 1250, 108, 14, withAlpha(t.dim, 0.6));

            const hits = sw.hits, rh = 26, maxRows = Math.min(SWEEP_PER_PAGE, Math.floor((p.h - 90) / rh));
            const pages = Math.ceil(hits.length / maxRows) || 1;
            sweepPage = Math.min(sweepPage, pages - 1);
            const shown = hits.slice(sweepPage * maxRows, (sweepPage + 1) * maxRows);

            shown.forEach((h, i) => {
                const y = 130 + i * rh;
                cv.text(h.hex, 48, y, 16, GO, { font: 'num' });
                cv.text(fitText(cv, h.range, 14, 280), 130, y, 14, t.dim);
                cv.text(String(h.len), 430, y, 14, t.text, { font: 'num' });
                cv.text(fitText(cv, h.raw, 14, 580, { font: 'num' }), 490, y, 14, withAlpha(t.text, 0.7), { font: 'num' });
                if (h.needsExt !== undefined) cv.text(h.needsExt ? 'YES' : 'no', 1100, y, 14, h.needsExt ? '#e0a030' : t.dim);
                // flag potential readiness: 4 data bytes in F4xx range, or any 4-byte result with monitor-like bit patterns
                const maybe = (h.len === 4 && h.did >= 0xF400 && h.did <= 0xF4FF) || (h.len === 4 && h.data.length === 4 && (h.data[1] & 0x07) !== 0);
                if (maybe) cv.text('likely', 1250, y, 14, '#e0a030', { font: 'bold' });
            });

            if (pages > 1) cv.text('Page ' + (sweepPage + 1) + ' of ' + pages, 1552, p.y + p.h - 18, 18, t.dim, { align: 'right' });
        }

        /* ---------- transport probe ---------- */
        let transportPage = 0;
        const TRANSPORT_PER_PAGE = 14;

        async function runTransportProbe() {
            if (transportProbing) return;
            transportProbing = true;
            const tp = { results: [], step: 'Starting transport probe...', done: false, summary: '' };
            S.transport = tp;
            transportPage = 0;
            changed();

            try {
                const r = await TP.probe(ctx.signals, log, {
                    onStep: (step, count) => { tp.step = step; changed(); },
                });
                tp.results = r.results;
                tp.summary = r.summary;
            } catch (e) {
                log.warn('transport probe: ' + e);
                tp.summary = 'Error: ' + e.message;
            }

            tp.step = '';
            tp.done = true;
            transportProbing = false;
            changed();
        }

        function drawTransport(cv, t) {
            const ERR_COLOR = '#e05555';
            const CYAN = '#40c8e0';
            const p = G.panel(cv, t, 24, 44, 1552, 468, 'Transport Probe — CAN / DoIP / TASU');

            const tp = S.transport;
            if (!tp) {
                cv.text('Press Refresh to probe for alternate diagnostic transports.', 48, 140, 22, t.dim);
                cv.text('Tests whether this head unit can reach the DME (engine ECU) through:', 48, 180, 18, t.dim);
                cv.text('1. SocketCAN — raw CAN bus (if the MGU has CAN interfaces)', 72, 216, 18, t.dim);
                cv.text('2. DoIP — Diagnostics over IP on port 13400 (vehicle Ethernet)', 72, 244, 18, t.dim);
                cv.text('3. TASU with alternate source addresses (0xF1 external tester)', 72, 272, 18, t.dim);
                cv.text('Every request is OBD-II mode 01 PID 00 (supported PIDs) — harmless, read-only.', 48, 316, 16, withAlpha(t.dim, 0.7));
                cv.text('The goal: find a transport where the DME answers readiness requests.', 48, 342, 16, withAlpha(t.dim, 0.7));
                return;
            }

            const sub = tp.done
                ? tp.results.length + ' tests · ' + tp.results.filter((r) => r.ok).length + ' passed · Refresh to re-probe'
                : tp.step || 'Probing...';
            cv.text(sub, 1552, 86, 16, t.dim, { align: 'right' });

            if (!tp.results.length && !tp.done) {
                cv.text('Probing transports...', 48, 200, 22, t.dim);
                return;
            }

            // summary banner
            if (tp.done && tp.summary) {
                const anyOk = tp.results.some((r) => r.ok && !r.test.includes('0xF2') && !r.test.includes('installed'));
                const bannerColor = anyOk ? GO : '#e0a030';
                cv.roundRect(40, 94, 900, 32, 6, withAlpha(bannerColor, 0.15));
                cv.text(fitText(cv, tp.summary, 18, 880, { font: 'bold' }), 52, 118, 18, bannerColor, { font: 'bold' });
            }

            // column headers
            const ry = tp.done && tp.summary ? 140 : 108;
            cv.text('Test', 48, ry, 14, withAlpha(t.dim, 0.6), { font: 'bold' });
            cv.text('Result', 530, ry, 14, withAlpha(t.dim, 0.6));
            cv.text('Error / Note', 1000, ry, 14, withAlpha(t.dim, 0.6));

            const rows = tp.results, rh = 28;
            const baseY = ry + 14;
            const maxRows = Math.min(TRANSPORT_PER_PAGE, Math.floor((p.y + p.h - baseY - 20) / rh));
            const pages = Math.ceil(rows.length / maxRows) || 1;
            transportPage = Math.min(transportPage, pages - 1);
            const shown = rows.slice(transportPage * maxRows, (transportPage + 1) * maxRows);

            shown.forEach((r, i) => {
                const y = baseY + 4 + i * rh;
                // status indicator
                const sc = r.ok ? GO : (r.error ? ERR_COLOR : t.dim);
                cv.circle(56, y + 2, 6, sc);
                if (r.ok) {
                    cv.line(52, y + 2, 55, y + 5, 2, t.bg);
                    cv.line(55, y + 5, 60, y - 2, 2, t.bg);
                }
                // test name
                const isTasu = r.test.startsWith('TASU');
                const isCan = r.test.startsWith('CAN');
                const isDoip = r.test.startsWith('DoIP');
                const nameColor = isTasu ? CYAN : isCan ? '#e0a030' : isDoip ? '#a080e0' : t.text;
                cv.text(fitText(cv, r.test, 16, 440), 72, y + 7, 16, nameColor);
                // detail
                const detailColor = r.ok ? GO : t.dim;
                cv.text(fitText(cv, r.detail, 15, 440), 530, y + 7, 15, detailColor, { font: r.raw ? 'num' : undefined });
                // error
                if (r.error) cv.text(fitText(cv, r.error, 14, 540), 1000, y + 7, 14, r.ok ? t.dim : ERR_COLOR);
            });

            if (pages > 1) cv.text('Page ' + (transportPage + 1) + ' of ' + pages, 1552, p.y + p.h - 18, 18, t.dim, { align: 'right' });
        }

        let drawn = -1;
        async function render(force) {
            if (!force && drawn === version) return;
            drawn = version;
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), v = view();
            if (page === 0) { drawSummary(cv, t, v); drawMonitors(cv, t, v); drawAdvice(cv, t, v); }
            else if (page === 1) drawFaults(cv, t);
            else if (page === 2) drawPlan(cv, t, v);
            else if (page === 3) drawProbe(cv, t);
            else if (page === 4) drawSweep(cv, t);
            else drawTransport(cv, t);
            const reading = S.phase === 'connecting' || busy;
            G.frame(cv, t, TABS, page, [S.demo && { text: 'DEMO' }, reading && { text: 'READING', color: 'accent2' }, probing && { text: 'PROBING', color: 'accent2' }, sweeping && { text: 'SWEEPING', color: 'accent2' }, transportProbing && { text: 'TESTING', color: 'accent2' }]);
            await ui.image('MAIN_GFX', cv);
        }

        ui.onClick('BTN_REFRESH', () => { if (page === 5) { runTransportProbe(); } else if (page === 4) { runSweep(); } else if (page === 3) { runProbe(); } else { forced = true; poll(); } changed(); });
        ui.onClick('BTN_PAGE', () => {
            const pl = view().plan, pages = Math.ceil(pl.steps.length / PLAN_PER_PAGE);
            if (page === 2 && planPage + 1 < pages) planPage++;
            else if (page === 3 && S.probe) { const pp = Math.ceil(S.probe.rows.length / PROBE_PER_PAGE) || 1; if (probePage + 1 < pp) { probePage++; changed(); return; } else { page = (page + 1) % TABS.length; probePage = 0; } }
            else if (page === 4 && S.sweep && S.sweep.hits.length) { const sp = Math.ceil(S.sweep.hits.length / SWEEP_PER_PAGE) || 1; if (sweepPage + 1 < sp) { sweepPage++; changed(); return; } else { page = (page + 1) % TABS.length; sweepPage = 0; } }
            else if (page === 5 && S.transport && S.transport.results.length) { const tp = Math.ceil(S.transport.results.length / TRANSPORT_PER_PAGE) || 1; if (transportPage + 1 < tp) { transportPage++; changed(); return; } else { page = 0; transportPage = 0; } }
            else { page = (page + 1) % TABS.length; planPage = 0; probePage = 0; sweepPage = 0; transportPage = 0; }
            changed();
        });
        ctx.onTab((i) => {
            if (i === page && i === 2) { const pages = Math.ceil(view().plan.steps.length / PLAN_PER_PAGE) || 1; planPage = (planPage + 1) % pages; }
            else if (i === page && i === 3 && S.probe) { const pp = Math.ceil(S.probe.rows.length / PROBE_PER_PAGE) || 1; probePage = (probePage + 1) % pp; }
            else if (i === page && i === 4 && S.sweep && S.sweep.hits.length) { const sp = Math.ceil(S.sweep.hits.length / SWEEP_PER_PAGE) || 1; sweepPage = (sweepPage + 1) % sp; }
            else if (i === page && i === 5 && S.transport && S.transport.results.length) { const tp = Math.ceil(S.transport.results.length / TRANSPORT_PER_PAGE) || 1; transportPage = (transportPage + 1) % tp; }
            else { page = i; planPage = 0; probePage = 0; sweepPage = 0; transportPage = 0; if (i === 3 && !S.probe && !probing) runProbe(); if (i === 5 && !S.transport && !transportProbing) runTransportProbe(); }
            changed();
        });
        ctx.onLayout(changed);
        settings.onChange(() => changed());
        // every 5 s: redraw the "updated ... ago" text
        setInterval(() => { if (ui.isVisible('MAIN')) changed(); }, 5000);

        var loop = ctx.loop('MAIN', 2, () => render(false));
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) { redraw(); setTimeout(poll, 800); } });
        if (ui.onFocus) ui.onFocus((name, on) => { if (name === 'MAIN' && on) redraw(); });
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
