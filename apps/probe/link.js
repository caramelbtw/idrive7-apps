'use strict';
/**
 * link.js - diagnostic link for Probe.
 *
 * Unlike the other apps' links this one is intentionally broad: it needs to reach
 * every ECU on the bus with read-only services so the user can discover what is
 * connected and watch what changes.
 *
 * Allowed services (read-only - no write, no actuation, no clear):
 *   0x10  DiagnosticSessionControl (01 default, 03 extended) - needed to read some DIDs
 *   0x22  ReadDataByIdentifier     - any DID (identification, status, coding reads)
 *   0x19  ReadDTCInformation       - sub-function 02 only (read, never clear)
 *   0x3E  TesterPresent            - keep-alive / probe if ECU is there
 *
 * Target: any single ECU address 0x00-0x7F, or functional 0xDF.
 */
const { Diag, replyTo } = require('./kit/diag');

/* well-known BMW G-series diagnostic addresses */
const KNOWN_ECUS = Object.freeze({
    0x01: 'ACSM airbag',
    0x02: 'ZGW central gateway',
    0x03: 'TBOX telematics',
    0x05: 'EDME electric DME',
    0x06: 'ICAM cameras',
    0x07: 'SME HV battery',
    0x08: 'SRR corner radar FL',
    0x09: 'TRSVC',
    0x0A: 'BDC_BODY2',
    0x0D: 'HKFM tailgate',
    0x0E: 'EME2 e-motor rear',
    0x10: 'BDC gateway',
    0x11: 'VGSG transfer case',
    0x12: 'DME engine',
    0x13: 'DME 2',
    0x14: 'OBC charger',
    0x15: 'OBD',
    0x18: 'EGS gearbox',
    0x19: 'SMG sequential gearbox',
    0x1A: 'EWS immobiliser',
    0x1B: 'RDC tyre pressure',
    0x1C: 'SZL steering column',
    0x1D: 'TFM fuel tank',
    0x1E: 'MFL multifunction wheel',
    0x20: 'SRR corner radar FR',
    0x21: 'FRR front radar',
    0x22: 'SINE crash sensor L',
    0x23: 'SAS assist sensors',
    0x24: 'HKL trunk lift',
    0x25: 'EDCE damper control',
    0x26: 'SHD sunroof',
    0x27: 'LCM light module',
    0x28: 'SRR corner radar RL',
    0x29: 'DSC brakes',
    0x2A: 'SRR corner radar RR',
    0x2B: 'REM rear electrics',
    0x2C: 'USS park sensors',
    0x2D: 'SGM safety gateway',
    0x2F: 'ACC adaptive cruise',
    0x30: 'EPS steering',
    0x31: 'AMP amplifier',
    0x32: 'CID display',
    0x34: 'NAVC navigation',
    0x35: 'TEL telephone',
    0x36: 'RAD radio',
    0x37: 'RAM audio',
    0x38: 'VTG xDrive',
    0x39: 'DSC brake booster',
    0x3A: 'EME e-motor',
    0x3C: 'KAFAS2',
    0x3D: 'BDC_K2X',
    0x3F: 'TVF',
    0x40: 'BDC body',
    0x41: 'BDC_BODY3',
    0x42: 'FEM_BODY2',
    0x43: 'FLM headlight L',
    0x44: 'FLM headlight R',
    0x45: 'DCS driver camera',
    0x46: 'AHL headlight leveling',
    0x47: 'SFZ satellite module',
    0x48: 'EPS2 steering',
    0x49: 'SPEG',
    0x4A: 'TPMS2',
    0x4B: 'HSR rear steering',
    0x4D: 'RFK rear camera',
    0x4E: 'SURROUNDVIEW',
    0x4F: 'RSE rear entertainment',
    0x50: 'ICM connectivity',
    0x51: 'COMBOX',
    0x52: 'HKA heating',
    0x53: 'FEM front electrics',
    0x55: 'CAS access system',
    0x56: 'FZD roof',
    0x58: 'HU_NBT head unit',
    0x59: 'DAB tuner',
    0x5A: 'WLAN',
    0x5C: 'HUD head up display',
    0x5D: 'KAFAS camera',
    0x5E: 'GWS gear selector',
    0x5F: 'TCB telematics',
    0x60: 'KOMBI cluster',
    0x61: 'ATM telematics',
    0x62: 'STVL',
    0x63: 'Head unit',
    0x64: 'PDC parking',
    0x65: 'SPNM',
    0x66: 'NIVI night vision',
    0x67: 'ZBE controller',
    0x68: 'FKA',
    0x69: 'FLEL fan module',
    0x6A: 'REM rear module',
    0x6B: 'SM seat FL',
    0x6C: 'SM seat FR',
    0x6D: 'SM seat module',
    0x6E: 'SM seat RL',
    0x6F: 'SM seat RR',
    0x70: 'CAS central access',
    0x72: 'AHM trailer module',
    0x73: 'EKPS fuel pump',
    0x74: 'GS gearshift',
    0x75: 'ELV steering lock',
    0x76: 'VDP dampers',
    0x77: 'PKE passive entry',
    0x78: 'IHKA climate',
    0x79: 'IHKS climate 2',
});

/** Full sweep: every diagnostic address 0x00-0x7F for maximum coverage. */
const SCAN_ADDRS = Object.freeze((function () { var a = []; for (var i = 0; i <= 0x7F; i++) a.push(i); return a; })());

/** Identification DIDs to read from each discovered ECU. */
const ID_DIDS = Object.freeze([
    { did: 'F150', name: 'SGBD index' },
    { did: 'F17C', name: 'Serial number' },
    { did: 'F187', name: 'Part number (spare)' },
    { did: 'F189', name: 'SW version' },
    { did: 'F18B', name: 'Build date' },
    { did: 'F18C', name: 'Supplier ECU HW' },
    { did: 'F190', name: 'VIN' },
    { did: 'F191', name: 'HW version' },
    { did: 'F192', name: 'SW version (system)' },
    { did: 'F194', name: 'SW version (data)' },
    { did: 'F197', name: 'System name' },
    { did: 'F19E', name: 'ASAM/ODX identifier' },
    { did: 'F1A2', name: 'SGBM identifier' },
    { did: 'F1A5', name: 'HWEL identifier' },
    { did: 'F1AB', name: 'Fingerprint' },
    { did: 'F1DF', name: 'Programming date' },
]);

/** Status DIDs to monitor during logging — broad coverage across common ranges. */
const LOG_DIDS = Object.freeze([
    '1000', '1001', '1002', '1003', '1004', '1005', '1006', '1007',
    '1008', '1009', '100A', '100B', '100C', '100D', '100E', '100F',
    '2000', '2001', '2002', '2003', '2004', '2005', '2006', '2007',
    '2008', '2009', '200A', '200B', '200C', '200D', '200E', '200F',
    '3000', '3001', '3002', '3003', '3004', '3005', '3006', '3007',
    '3100', '3101', '3102', '3103',
    '6000', '6001', '6002', '6003', '6004', '6005', '6006', '6007',
    '60FD', '60FE', '60FF', '6100', '6101', '6102', '6103', '6104',
    '6105', '6106', '6107', '6108', '6109', '610A',
    'D000', 'D001', 'D002', 'D003', 'D004', 'D005', 'D006', 'D007',
    'D100', 'D101', 'D102', 'D103',
    'F190', 'F40C', 'F411', 'F441', 'F446',
]);

const LINKS = new WeakMap();
var byte = function (b) { return Number.isInteger(b) && b >= 0 && b <= 0xFF; };
var hx = function (n) { return Number.isInteger(n) ? n.toString(16).toUpperCase().padStart(2, '0') : String(n); };

function check(target, sid, data) {
    if (!Array.isArray(data) || !data.every(byte)) throw new Error('bad request bytes');
    if (target !== 0xDF && (!Number.isInteger(target) || target < 0x00 || target > 0x7F))
        throw new Error('target ' + hx(target) + ' out of range');

    if (sid === 0x3E) {
        if (data.length > 1) throw new Error('3E too long');
        return;
    }
    if (sid === 0x10) {
        if (data.length !== 1 || (data[0] !== 0x01 && data[0] !== 0x03))
            throw new Error('10 ' + data.map(hx).join(' ') + ' not allowed');
        return;
    }
    if (sid === 0x22) {
        if (data.length < 2) throw new Error('22 needs at least 2 bytes');
        return; // any DID is allowed for reading
    }
    if (sid === 0x19) {
        if (data.length < 1 || data[0] !== 0x02) throw new Error('19 only sub-function 02 allowed');
        return;
    }
    throw new Error('service ' + hx(sid) + ' is not allowed (read-only)');
}

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

class ProbeLink {
    constructor(signals, log, opts) {
        var diag = new Diag(signals, log);
        diag.quiet = true;
        diag.busyMs = 200;
        diag.busyLog = false;
        LINKS.set(this, diag);
        this.log = log;
        this.gapMs = (opts && opts.gapMs) || 40;
        this.timeoutMs = (opts && opts.timeoutMs) || 3000;
        this.scanTimeoutMs = (opts && opts.scanTimeoutMs) || 800;
        this.silentAfter = (opts && opts.silentAfter) || 3;
        this.misses = {};
        this.stats = { sent: 0, replies: 0, missed: 0, blocked: 0 };
        this.chain = Promise.resolve();
        this.next = 0;

        // logging state
        this._logging = false;
        this._logEntries = [];
        this._snapshot = {};   // 'addr:did' -> hex string of bytes at log start
    }

    async init() { await LINKS.get(this).init(); return this; }
    get available() { return LINKS.get(this).available; }
    get ready() { return !!LINKS.get(this).p; }
    get failed() { return LINKS.get(this).error; }
    silent(target) { return (this.misses[target] || 0) >= this.silentAfter; }
    wake(target) { if (target === undefined) this.misses = {}; else delete this.misses[target]; }

    /**
     * Send one allowed read-only request and return the UDS reply bytes, or null.
     * Optional timeoutMs overrides the default for this single request.
     */
    ask(target, sid, data, timeoutMs) {
        var d = Array.isArray(data) ? data.slice() : [];
        try { check(target, sid, d); } catch (e) {
            this.stats.blocked++;
            this.log.error('blocked: ' + e.message);
            return Promise.reject(e);
        }
        if (this.silent(target)) return Promise.resolve(null);
        var self = this;
        var ms = timeoutMs || self.timeoutMs;
        var run = async function () {
            var wait = Math.max(0, self.next - Date.now());
            if (wait) await sleep(wait);
            try {
                self.stats.sent++;
                var uds = await LINKS.get(self).physical(
                    target, sid, d,
                    ms,
                    replyTo(sid, d)
                );
                if (!uds) { self.stats.missed++; self.misses[target] = (self.misses[target] || 0) + 1; return null; }
                self.misses[target] = 0;
                self.stats.replies++;
                if (uds[0] === 0x7F && uds[2] === 0x21) self.next = Math.max(self.next, Date.now() + 1000);
                return uds;
            } finally { self.next = Math.max(self.next, Date.now() + self.gapMs); }
        };
        return this.queue(run);
    }

    /**
     * Read a DID (hex string like 'F150') from an ECU. Returns data bytes after the echo, or null.
     */
    async readDid(ecu, did) {
        var d1 = parseInt(did.slice(0, 2), 16), d2 = parseInt(did.slice(2, 4), 16);
        var r = await this.ask(ecu, 0x22, [d1, d2]);
        if (!r || r[0] !== 0x62 || r[1] !== d1 || r[2] !== d2) return null;
        return Array.prototype.slice.call(r, 3);
    }

    /**
     * Send tester present to an ECU. Returns true if it answered.
     * Uses the faster scanTimeoutMs for quick sweeps.
     */
    async ping(ecu) {
        var r = await this.ask(ecu, 0x3E, [0x00], this.scanTimeoutMs);
        return r !== null && r[0] !== 0x7F;
    }

    /**
     * Identify an ECU: read F150 and return the SGBD index string, or ''.
     */
    async identify(ecu) {
        var r = await this.ask(ecu, 0x22, [0xF1, 0x50]);
        if (!r || r[0] !== 0x62 || r.length < 6) return '';
        return ((r[3] << 16) | (r[4] << 8) | r[5]).toString(16).toUpperCase().padStart(6, '0');
    }

    /**
     * Scan all 128 diagnostic addresses (0x00-0x7F): returns an array of { addr, name, sgbd, online }.
     * Optional onProgress(scanned, total, found) callback for UI updates during the sweep.
     */
    async scan(onProgress) {
        var results = [];
        for (var i = 0; i < SCAN_ADDRS.length; i++) {
            var addr = SCAN_ADDRS[i];
            this.wake(addr);
            var alive = await this.ping(addr);
            if (onProgress) onProgress(i + 1, SCAN_ADDRS.length, results.length);
            if (!alive) continue;
            var sgbd = await this.identify(addr);
            results.push({
                addr: addr,
                name: KNOWN_ECUS[addr] || 'Unknown 0x' + hx(addr),
                sgbd: sgbd,
                online: true,
            });
            if (onProgress) onProgress(i + 1, SCAN_ADDRS.length, results.length);
        }
        return results;
    }

    /**
     * Read all identification DIDs from an ECU. Returns array of { did, name, hex, ascii }.
     */
    async readIdDids(ecu) {
        var out = [];
        // enter extended session so more DIDs are accessible
        await this.ask(ecu, 0x10, [0x03]).catch(function () {});
        for (var i = 0; i < ID_DIDS.length; i++) {
            var d = ID_DIDS[i];
            var bytes = await this.readDid(ecu, d.did);
            if (!bytes) continue;
            var hexStr = bytes.map(function (b) { return hx(b); }).join(' ');
            var ascii = bytes.map(function (b) { return b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.'; }).join('');
            out.push({ did: d.did, name: d.name, hex: hexStr, ascii: ascii });
        }
        // return to default session
        this.ask(ecu, 0x10, [0x01]).catch(function () {});
        return out;
    }

    /* ---------- logging ---------- */

    get logging() { return this._logging; }

    /**
     * Start logging: snapshot current status DIDs from all given ECU addresses.
     */
    async startLog(ecus) {
        this._logging = true;
        this._logEntries = [];
        this._snapshot = {};
        var ts = Date.now();
        for (var i = 0; i < ecus.length; i++) {
            var addr = ecus[i];
            this.wake(addr);
            for (var j = 0; j < LOG_DIDS.length; j++) {
                var did = LOG_DIDS[j];
                var bytes = await this.readDid(addr, did);
                if (bytes) {
                    var key = hx(addr) + ':' + did;
                    var hexStr = bytes.map(function (b) { return hx(b); }).join(' ');
                    this._snapshot[key] = hexStr;
                    this._logEntries.push({ ts: ts, addr: addr, did: did, type: 'snapshot', hex: hexStr });
                }
            }
        }
    }

    /**
     * Poll all ECUs during logging: read the same DIDs and record any changes.
     */
    async pollLog(ecus) {
        if (!this._logging) return;
        var ts = Date.now();
        for (var i = 0; i < ecus.length; i++) {
            var addr = ecus[i];
            this.wake(addr);
            for (var j = 0; j < LOG_DIDS.length; j++) {
                var did = LOG_DIDS[j];
                var key = hx(addr) + ':' + did;
                if (!(key in this._snapshot)) continue; // only track DIDs that existed at start
                var bytes = await this.readDid(addr, did);
                if (!bytes) continue;
                var hexStr = bytes.map(function (b) { return hx(b); }).join(' ');
                if (hexStr !== this._snapshot[key]) {
                    this._logEntries.push({
                        ts: ts, addr: addr, did: did, type: 'change',
                        before: this._snapshot[key], after: hexStr,
                    });
                    this._snapshot[key] = hexStr; // update snapshot so we track incremental changes
                }
            }
        }
    }

    /**
     * Stop logging, return the diff: entries that changed between start and now.
     */
    stopLog() {
        this._logging = false;
        return this._logEntries.filter(function (e) { return e.type === 'change'; });
    }

    /**
     * Return all log entries (snapshots + changes).
     */
    getLog() {
        return this._logEntries.slice();
    }

    queue(run) {
        var p = this.chain.then(run, run);
        this.chain = p.catch(function () {});
        return p;
    }
}

module.exports = { ProbeLink, check, KNOWN_ECUS, SCAN_ADDRS, ID_DIDS, LOG_DIDS };
