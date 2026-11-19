'use strict';
/**
 * link.js - the head unit's diagnostic link (kit/diag.js) narrowed to the few READS this app needs.
 *
 * The Diag underneath is private to this module (a WeakMap the app can't reach), and every request passes
 * check() before it is queued, so nothing else can leave the head unit. Allowed, and nothing more:
 *
 *   01 <PID>     OBD-II current data (SAE J1979 service 01), one PID out of PIDS below:
 *                supported-PID maps (00 20 40), monitor status since faults cleared (01), this drive
 *                cycle (41), warm-ups / distance / time since faults cleared (30 31 4E)
 *   03           confirmed emission faults (service 03: a READ - clearing is service 04, not allowed)
 *   07           pending emission faults
 *   0A           permanent emission faults
 *   19 02 <mask> BMW's own fault memory (UDS ReadDTCInformation, reportDTCByStatusMask): the BMW hex codes
 *                (140300 ...) BMW's tools show. Only sub-function 02; 19 has no sub-function that changes
 *                anything, and clearing (14) is a different service, not allowed.
 *   22 F1 50     the unit's SGBD index (which engine / gearbox type it is: picks its fault texts).
 *   22 F4 <PID>  the same OBD-II data as 01 <PID>, as a UDS identifier (ISO 27145): what most BMW engine units
 *                answer over the head unit's link (01 is often refused with NRC 11). Same PIDs as 01 only.
 *   10 03        DiagnosticSessionControl - ExtendedDiagnosticSession: some engine units expose the F4xx DIDs (or
 *                answer 01) only after entering extended session. No data is modified; the session reverts after S3
 *                timeout (~5 s of inactivity). Only sub-function 03 is allowed; default (01) and programming (02)
 *                are not.
 *
 * Physically only to the units in UNITS (engine unit, second engine unit, gearbox). To all units at once (functional,
 * 0xDF: how an OBD-II scan tool asks) only 01 <PID> and 22 F4 <PID> with the PIDs above, for engine units that don't
 * answer them physically over this link (askAll()).
 * No session change, no tester present, no clear (04 / 14), no other 22 identifier, no 2E / 2F / 31 / anything
 * else: check() throws.
 *
 * Pacing: one request at a time, at least gapMs (40) apart; a unit that didn't answer silentAfter (4) times
 * in a row is skipped until wake().
 */
const { Diag } = require('./kit/diag');

const PIDS = Object.freeze([0x00, 0x01, 0x20, 0x30, 0x31, 0x40, 0x41, 0x4E]);
const DTC_SIDS = Object.freeze([0x03, 0x07, 0x0A]);
const UNITS = Object.freeze({ 0x12: 'Engine unit', 0x13: 'Engine unit 2', 0x18: 'Gearbox' });
const ALL = 0xDF;
const LINKS = new WeakMap();

const byte = (b) => Number.isInteger(b) && b >= 0 && b <= 0xFF;
const hx = (n) => (Number.isInteger(n) ? n.toString(16).toUpperCase().padStart(2, '0') : String(n));

/** Throws unless the request is one of the reads above. Exported for the tests. */
function check(target, sid, data) {
    if (!Array.isArray(data) || !data.every(byte)) throw new Error('read-only: bad request bytes');
    if (target === ALL) {
        const ok = (sid === 0x01 && data.length === 1 && PIDS.indexOf(data[0]) >= 0)
            || (sid === 0x22 && data.length === 2 && data[0] === 0xF4 && PIDS.indexOf(data[1]) >= 0);
        if (!ok) throw new Error('read-only: only 01 <PID> and 22 F4 <PID> may go to all units');
        return;
    }
    if (!byte(target) || !UNITS[target]) throw new Error('read-only: unit ' + hx(target) + ' is not allowed');
    if (sid === 0x01) {
        if (data.length !== 1 || PIDS.indexOf(data[0]) < 0) throw new Error('read-only: 01 ' + data.map(hx).join(' ') + ' is not allowed');
        return;
    }
    if (DTC_SIDS.indexOf(sid) >= 0) {
        if (data.length !== 0) throw new Error('read-only: ' + hx(sid) + ' takes no data');
        return;
    }
    if (sid === 0x19) {
        if (data.length !== 2 || data[0] !== 0x02) throw new Error('read-only: 19 ' + data.map(hx).join(' ') + ' is not allowed (only 19 02 <mask>)');
        return;
    }
    if (sid === 0x22) {
        const ok = data.length === 2 && ((data[0] === 0xF1 && data[1] === 0x50) || (data[0] === 0xF4 && PIDS.indexOf(data[1]) >= 0));
        if (!ok) throw new Error('read-only: 22 ' + data.map(hx).join(' ') + ' is not allowed (only 22 F1 50 and 22 F4 <PID>)');
        return;
    }
    if (sid === 0x10) {
        if (data.length !== 1 || data[0] !== 0x03) throw new Error('read-only: 10 ' + data.map(hx).join(' ') + ' is not allowed (only 10 03 extended session)');
        return;
    }
    throw new Error('read-only: service ' + hx(sid) + ' is not allowed');
}

/** the reply to this request (every app gets every frame from a unit): positive echo, or a refusal of this service */
function accepts(sid, data) {
    // 01 echoes its PID, 19 its sub-function, 22 its identifier
    const echo = sid === 0x22 ? 2 : sid === 0x01 || sid === 0x10 || sid === 0x19 ? 1 : 0;
    return (u) => (u[0] === sid + 0x40 && data.slice(0, echo).every((b, i) => u[i + 1] === b)) || (u[0] === 0x7F && u[1] === sid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ReadinessLink {
    constructor(signals, log, opts) {
        const diag = new Diag(signals, log);
        diag.quiet = true;
        diag.busyMs = 100;
        diag.busyLog = false;
        LINKS.set(this, diag);
        this.log = log;
        this.gapMs = (opts && opts.gapMs) || 40;
        // the engine unit can take longer than 2 s over this link while other apps and BMW's services use it too
        this.timeoutMs = Object.assign({ 0x12: 3000 }, opts && opts.timeoutMs);
        this.allMs = (opts && opts.allMs) || 2500;
        this.silentAfter = (opts && opts.silentAfter) || 4;
        this.misses = {};
        this.stats = { sent: 0, replies: 0, missed: 0, blocked: 0 };
        this.chain = Promise.resolve();
        this.next = 0;
    }

    async init() { await LINKS.get(this).init(); return this; }
    get available() { return LINKS.get(this).available; }
    /** the transport proxy is there (false while init runs, or when the head unit has none: see failed) */
    get ready() { return !!LINKS.get(this).p; }
    get failed() { return LINKS.get(this).error; }
    silent(target) { return (this.misses[target] || 0) >= this.silentAfter; }
    wake(target) { if (target === undefined) this.misses = {}; else delete this.misses[target]; }

    /** Enter extended diagnostic session (10 03) on one ECU: true if accepted, false if refused or no answer. */
    async session(target) {
        try {
            const r = await this.ask(target, 0x10, [0x03]);
            return !!(r && r[0] === 0x50);
        } catch (e) { return false; }
    }

    /** One allowed request: the unit's reply bytes (41 .. / 43 .. / 7F ..), or null (no answer / skipped). */
    ask(target, sid, data) {
        const d = Array.isArray(data) ? data.slice() : [];       // checked = sent
        try { check(target, sid, d); if (target === ALL) throw new Error('read-only: 0xDF only through askAll()'); } catch (e) {
            this.stats.blocked++;
            this.log.error('blocked a diagnostic request: ' + e.message);
            return Promise.reject(e);
        }
        if (this.silent(target)) return Promise.resolve(null);
        const run = async () => {
            const wait = Math.max(0, this.next - Date.now());
            if (wait) await sleep(wait);
            try {
                this.stats.sent++;
                const uds = await LINKS.get(this).physical(target, sid, d, this.timeoutMs[target] || 2000, accepts(sid, d));
                if (!uds) { this.stats.missed++; this.misses[target] = (this.misses[target] || 0) + 1; return null; }
                this.misses[target] = 0;
                this.stats.replies++;
                if (uds[0] === 0x7F && uds[2] === 0x21) this.next = Math.max(this.next, Date.now() + 1000);   // busy
                return uds;
            } finally { this.next = Math.max(this.next, Date.now() + this.gapMs); }
        };
        return this.queue(run);
    }

    /**
     * One allowed request to every unit at once (01 <PID> / 22 F4 <PID> only): Map(address -> reply bytes) of the
     * units that answered it (positive or refused), empty when none did. Done as soon as unit 'want' has answered,
     * else after allMs. Doesn't count towards silent().
     */
    askAll(sid, data, want) {
        const d = Array.isArray(data) ? data.slice() : [];
        try { if (!Array.isArray(data)) throw new Error('read-only: bad request bytes'); check(ALL, sid, d); } catch (e) {
            this.stats.blocked++;
            this.log.error('blocked a diagnostic request: ' + e.message);
            return Promise.reject(e);
        }
        const run = async () => {
            const wait = Math.max(0, this.next - Date.now());
            if (wait) await sleep(wait);
            const diag = LINKS.get(this), ok = accepts(sid, d), out = new Map();
            let finish, timer;
            const done = new Promise((r) => { finish = r; });
            // only this request's answers: other apps' replies arrive here too ('response pending' isn't one)
            const onFrame = (f) => {
                if (!ok(f.uds) || (f.uds[0] === 0x7F && f.uds[2] === 0x78)) return;
                out.set(f.ecu, f.uds);
                if (f.ecu === want) finish();
            };
            diag.on('frame', onFrame);
            try {
                this.stats.sent++;
                diag._check(await diag.send(ALL, sid, d));
                timer = setTimeout(finish, this.allMs);        // from when the transport took it
                await done;
                this.stats.replies += out.size;
                return out;
            } finally { clearTimeout(timer); diag.removeListener('frame', onFrame); this.next = Math.max(this.next, Date.now() + this.gapMs); }
        };
        return this.queue(run);
    }

    queue(run) {
        const p = this.chain.then(run, run);
        this.chain = p.catch(() => {});
        return p;
    }
}

module.exports = { ReadinessLink, check, PIDS, DTC_SIDS, UNITS, ALL };
