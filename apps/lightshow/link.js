'use strict';
/**
 * link.js - diagnostic link for LightShow.
 *
 * Services:
 *   0x10  DiagnosticSessionControl (01 default, 03 extended)
 *   0x22  ReadDataByIdentifier  (FLM DRL coding block)
 *   0x2E  WriteDataByIdentifier (FLM DRL coding block)
 *   0x2F  InputOutputControlByIdentifier (BDC light outputs for strobe)
 *   0x22 F150  ECU identification
 *
 * Only the ECUs and DIDs in TARGETS / ALLOWED are permitted.
 */
const { Diag, replyTo } = require('./kit/diag');

const TARGETS = Object.freeze({
    0x40: 'BDC body',
    0x43: 'FLM headlight L',
    0x44: 'FLM headlight R',
});

// coding DIDs (0x22 / 0x2E)
const CODING_DIDS = Object.freeze({
    0x43: ['3100'],
    0x44: ['3100'],
});

// IOControl DIDs (0x2F) - BDC light outputs
const IO_DIDS = Object.freeze({
    0x40: [
        '60FD', '60FE', '60FF', '6100', '6101', '6102',
        '6103', '6104', '6105', '6106', '6107', '6108',
        '6109', '610A',
    ],
});

const LINKS = new WeakMap();
const byte = function (b) { return Number.isInteger(b) && b >= 0 && b <= 0xFF; };
const hx = function (n) { return Number.isInteger(n) ? n.toString(16).toUpperCase().padStart(2, '0') : String(n); };

function check(target, sid, data) {
    if (!Array.isArray(data) || !data.every(byte)) throw new Error('bad request bytes');
    if (!TARGETS[target]) throw new Error('unit ' + hx(target) + ' is not allowed');

    if (sid === 0x10) {
        if (data.length !== 1 || (data[0] !== 0x01 && data[0] !== 0x03))
            throw new Error('10 ' + data.map(hx).join(' ') + ' not allowed');
        return;
    }
    if (sid === 0x22) {
        if (data.length < 2) throw new Error('22 needs at least 2 bytes');
        if (data[0] === 0xF1 && data[1] === 0x50) return;
        var did = hx(data[0]) + hx(data[1]);
        var allowed = CODING_DIDS[target] || [];
        if (allowed.indexOf(did) < 0) throw new Error('22 ' + did + ' not allowed for ' + hx(target));
        return;
    }
    if (sid === 0x2E) {
        if (data.length < 3) throw new Error('2E needs DID + at least 1 data byte');
        var did2 = hx(data[0]) + hx(data[1]);
        var allowed2 = CODING_DIDS[target] || [];
        if (allowed2.indexOf(did2) < 0) throw new Error('2E ' + did2 + ' not allowed for ' + hx(target));
        return;
    }
    if (sid === 0x2F) {
        if (data.length < 3) throw new Error('2F needs DID + control param');
        var did3 = hx(data[0]) + hx(data[1]);
        var ioDids = IO_DIDS[target] || [];
        if (ioDids.indexOf(did3) < 0) throw new Error('2F ' + did3 + ' not allowed for ' + hx(target));
        var cp = data[2];
        if (cp !== 0x00 && cp !== 0x03) throw new Error('2F control param ' + hx(cp) + ' not allowed');
        return;
    }
    throw new Error('service ' + hx(sid) + ' is not allowed');
}

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

class CoderLink {
    constructor(signals, log, opts) {
        var diag = new Diag(signals, log);
        diag.quiet = true;
        diag.busyMs = 200;
        diag.busyLog = false;
        LINKS.set(this, diag);
        this.log = log;
        this.gapMs = (opts && opts.gapMs) || 40;
        this.timeoutMs = (opts && opts.timeoutMs) || 4000;
        this.silentAfter = (opts && opts.silentAfter) || 3;
        this.misses = {};
        this.stats = { sent: 0, replies: 0, missed: 0, blocked: 0, writes: 0, io: 0 };
        this.chain = Promise.resolve();
        this.next = 0;
    }

    async init() { await LINKS.get(this).init(); return this; }
    get available() { return LINKS.get(this).available; }
    get ready() { return !!LINKS.get(this).p; }
    get failed() { return LINKS.get(this).error; }
    silent(target) { return (this.misses[target] || 0) >= this.silentAfter; }
    wake(target) { if (target === undefined) this.misses = {}; else delete this.misses[target]; }

    ask(target, sid, data) {
        var d = Array.isArray(data) ? data.slice() : [];
        try { check(target, sid, d); } catch (e) {
            this.stats.blocked++;
            this.log.error('blocked: ' + e.message);
            return Promise.reject(e);
        }
        if (this.silent(target)) return Promise.resolve(null);
        var self = this;
        var run = async function () {
            var wait = Math.max(0, self.next - Date.now());
            if (wait) await sleep(wait);
            try {
                self.stats.sent++;
                if (sid === 0x2E) self.stats.writes++;
                if (sid === 0x2F) self.stats.io++;
                var uds = await LINKS.get(self).physical(
                    target, sid, d,
                    sid === 0x2F ? 2000 : (sid === 0x2E ? 6000 : self.timeoutMs),
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

    async readDid(ecu, did) {
        var d1 = parseInt(did.slice(0, 2), 16), d2 = parseInt(did.slice(2, 4), 16);
        var r = await this.ask(ecu, 0x22, [d1, d2]);
        if (!r || r[0] !== 0x62 || r[1] !== d1 || r[2] !== d2) return null;
        return Array.prototype.slice.call(r, 3);
    }

    async writeDid(ecu, did, block) {
        var d1 = parseInt(did.slice(0, 2), 16), d2 = parseInt(did.slice(2, 4), 16);
        var sess = await this.ask(ecu, 0x10, [0x03]);
        if (!sess || sess[0] === 0x7F) {
            this.log.warn('write ' + did + ': session refused');
            return false;
        }
        var payload = [d1, d2].concat(Array.isArray(block) ? block : Array.prototype.slice.call(block));
        var w = await this.ask(ecu, 0x2E, payload);
        this.ask(ecu, 0x10, [0x01]).catch(function () {});
        if (!w || w[0] === 0x7F) {
            this.log.warn('write ' + did + ': refused');
            return false;
        }
        return true;
    }

    /** IOControl: shortTermAdjustment (on/off) for a light output. */
    async ioControl(ecu, did, on) {
        var d1 = parseInt(did.slice(0, 2), 16), d2 = parseInt(did.slice(2, 4), 16);
        var r = await this.ask(ecu, 0x2F, [d1, d2, 0x03, on ? 0x01 : 0x00]);
        return r && r[0] === 0x6F;
    }

    /** IOControl: return control to ECU for a light output. */
    async ioRestore(ecu, did) {
        var d1 = parseInt(did.slice(0, 2), 16), d2 = parseInt(did.slice(2, 4), 16);
        var r = await this.ask(ecu, 0x2F, [d1, d2, 0x00]);
        return r && r[0] === 0x6F;
    }

    async identify(ecu) {
        var r = await this.ask(ecu, 0x22, [0xF1, 0x50]);
        if (!r || r[0] !== 0x62 || r.length < 6) return '';
        return ((r[3] << 16) | (r[4] << 8) | r[5]).toString(16).toUpperCase().padStart(6, '0');
    }

    queue(run) {
        var p = this.chain.then(run, run);
        this.chain = p.catch(function () {});
        return p;
    }
}

module.exports = { CoderLink, check, TARGETS, CODING_DIDS, IO_DIDS };
