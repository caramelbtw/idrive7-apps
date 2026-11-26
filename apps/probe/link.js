'use strict';
/**
 * link.js - diagnostic link for Probe.
 *
 * Uses Diag directly — the same pattern as the working DTC scanner app.
 * No queue, no pacing layer, no miss tracking. The TASU transport in
 * diag.js already handles retries and backoff for busy verdicts.
 *
 * Scan: functional 0x19 02 FF to 0xDF (all ECUs answer), then physical
 * 0x22 F1 50 to each responder for SGBD identification — identical to
 * the DTC scanner's proven approach.
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

var hx = function (n) { return Number.isInteger(n) ? n.toString(16).toUpperCase().padStart(2, '0') : String(n); };

/**
 * Accept filter for physical(): matches this service's positive reply
 * (echoes the DID/sub-function) or its negative reply.
 */
function accept(sid, data) {
    return function (u) {
        if (u[0] === 0x7F && u[1] === sid) return true;
        if (u[0] !== sid + 0x40) return false;
        if (sid === 0x22 && data.length >= 2) return u[1] === data[0] && u[2] === data[1];
        if (sid === 0x10 && data.length >= 1) return u[1] === data[0];
        if (sid === 0x19 && data.length >= 1) return u[1] === data[0];
        return true;
    };
}

/**
 * ProbeLink — thin wrapper around Diag.
 * Calls diag.functional() and diag.physical() directly, the same way
 * the working DTC scanner does. No queue, no pacing, no miss tracking.
 */
class ProbeLink {
    constructor(signals, log) {
        this._diag = new Diag(signals, log);
        this._diag.quiet = true;
        this.log = log;

        // logging state
        this._logging = false;
        this._logEntries = [];
        this._snapshot = {};
    }

    async init() {
        await this._diag.init();
        return this;
    }
    get available() { return this._diag.available; }
    get ready() { return !!this._diag.p; }
    get failed() { return this._diag.error; }

    /**
     * Physical request to one ECU. Returns the UDS reply bytes, or null.
     */
    async physical(target, sid, data, timeoutMs) {
        try {
            return await this._diag.physical(target, sid, data, timeoutMs || 3000, accept(sid, data));
        } catch (e) {
            this.log.warn('physical 0x' + hx(target) + ' sid ' + hx(sid) + ': ' + e.message);
            return null;
        }
    }

    /**
     * Read a DID (hex string like 'F150') from an ECU. Returns data bytes after the echo, or null.
     */
    async readDid(ecu, did) {
        var d1 = parseInt(did.slice(0, 2), 16), d2 = parseInt(did.slice(2, 4), 16);
        var r = await this.physical(ecu, 0x22, [d1, d2]);
        if (!r || r[0] !== 0x62 || r[1] !== d1 || r[2] !== d2) return null;
        return Array.prototype.slice.call(r, 3);
    }

    /**
     * Discover all online ECUs using functional 0x19 02 FF — the same approach
     * the working DTC scanner uses. Returns Map(ecuAddress -> udsReply).
     */
    async broadcast(onReply) {
        this.log.info('broadcast: functional 19 02 FF to 0xDF (all ECUs)');
        try {
            var replies = await this._diag.functional(0x19, [0x02, 0xFF], {
                onReply: onReply || function () {},
            });
            this.log.info('broadcast: ' + replies.size + ' ECUs responded');
            return replies;
        } catch (e) {
            this.log.warn('broadcast failed: ' + e.message);
            return new Map();
        }
    }

    /**
     * Scan for all online ECUs.
     *   Phase 1: functional broadcast discovers responding addresses
     *   Phase 2: physical 22 F1 50 identifies each responder
     *
     * Returns array of { addr, name, sgbd, online }.
     */
    async scan(onProgress) {
        var results = [];

        if (onProgress) onProgress('broadcast', { found: 0 });
        var replies = await this.broadcast(function (ecu, count) {
            if (onProgress) onProgress('broadcast', { found: count });
        });
        var addrs = [];
        replies.forEach(function (uds, ecu) { addrs.push(ecu); });
        addrs.sort(function (a, b) { return a - b; });

        this.log.info('identify: reading SGBD from ' + addrs.length + ' ECUs');
        for (var i = 0; i < addrs.length; i++) {
            var addr = addrs[i];
            if (onProgress) onProgress('identify', { current: i + 1, total: addrs.length, found: results.length });
            var sgbd = '';
            try {
                var r = await this._diag.physical(addr, 0x22, [0xF1, 0x50], 3000,
                    function (u) { return (u[0] === 0x62 && u[1] === 0xF1 && u[2] === 0x50) || (u[0] === 0x7F && u[1] === 0x22); });
                if (r && r[0] === 0x62 && r.length >= 6) {
                    sgbd = ((r[3] << 16) | (r[4] << 8) | r[5]).toString(16).toUpperCase().padStart(6, '0');
                }
            } catch (e) { this.log.warn('identify 0x' + hx(addr) + ': ' + e.message); }
            results.push({
                addr: addr,
                name: KNOWN_ECUS[addr] || 'Unknown 0x' + hx(addr),
                sgbd: sgbd,
                online: true,
            });
        }

        return results;
    }

    /**
     * Read all identification DIDs from an ECU. Returns array of { did, name, hex, ascii }.
     */
    async readIdDids(ecu) {
        var out = [];
        await this.physical(ecu, 0x10, [0x03], 3000);
        for (var i = 0; i < ID_DIDS.length; i++) {
            var d = ID_DIDS[i];
            var bytes = await this.readDid(ecu, d.did);
            if (!bytes) continue;
            var hexStr = bytes.map(function (b) { return hx(b); }).join(' ');
            var ascii = bytes.map(function (b) { return b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.'; }).join('');
            out.push({ did: d.did, name: d.name, hex: hexStr, ascii: ascii });
        }
        this.physical(ecu, 0x10, [0x01], 3000);
        return out;
    }

    /**
     * Probe which UDS services an ECU supports.
     */
    async discoverServices(ecu) {
        var services = [
            { sid: 0x10, name: 'DiagnosticSessionControl', data: [0x01] },
            { sid: 0x11, name: 'ECUReset', data: [0x01] },
            { sid: 0x14, name: 'ClearDTC', data: [0xFF, 0xFF, 0xFF] },
            { sid: 0x19, name: 'ReadDTCInformation', data: [0x02, 0xFF] },
            { sid: 0x22, name: 'ReadDataByIdentifier', data: [0xF1, 0x50] },
            { sid: 0x23, name: 'ReadMemoryByAddress', data: [0x14, 0x00, 0x00, 0x00, 0x01] },
            { sid: 0x27, name: 'SecurityAccess', data: [0x01] },
            { sid: 0x28, name: 'CommunicationControl', data: [0x00, 0x01] },
            { sid: 0x2E, name: 'WriteDataByIdentifier', data: [0x00, 0x00] },
            { sid: 0x2F, name: 'InputOutputControl', data: [0x00, 0x00, 0x00] },
            { sid: 0x31, name: 'RoutineControl', data: [0x01, 0x00, 0x00] },
            { sid: 0x34, name: 'RequestDownload', data: [0x00, 0x11, 0x00, 0x00] },
            { sid: 0x36, name: 'TransferData', data: [0x01] },
            { sid: 0x37, name: 'RequestTransferExit', data: [] },
            { sid: 0x3E, name: 'TesterPresent', data: [0x00] },
            { sid: 0x85, name: 'ControlDTCSetting', data: [0x01] },
        ];
        var out = [];
        for (var i = 0; i < services.length; i++) {
            var s = services[i];
            var r = await this.physical(ecu, s.sid, s.data, 2000);
            var supported = false, nrc = null;
            if (r) {
                if (r[0] === 0x7F && r[1] === s.sid) {
                    nrc = r[2];
                    supported = nrc !== 0x11;
                } else {
                    supported = true;
                }
            }
            out.push({ sid: s.sid, name: s.name, supported: supported, nrc: nrc });
        }
        return out;
    }

    /**
     * Sweep a DID range on an ECU.
     * Returns array of { did (hex string), bytes (data length), hex (preview) }.
     */
    async scanDidRange(ecu, startDid, endDid, onProgress) {
        var out = [];
        var total = endDid - startDid + 1;
        await this.physical(ecu, 0x10, [0x03], 3000);
        for (var did = startDid; did <= endDid; did++) {
            var d1 = (did >> 8) & 0xFF, d2 = did & 0xFF;
            var didHex = hx(d1) + hx(d2);
            var bytes = await this.readDid(ecu, didHex);
            if (onProgress) onProgress(did - startDid + 1, total, out.length);
            if (!bytes || bytes.length === 0) continue;
            var preview = bytes.slice(0, 16).map(function (b) { return hx(b); }).join(' ');
            if (bytes.length > 16) preview += ' ...';
            out.push({ did: didHex, bytes: bytes.length, hex: preview });
        }
        this.physical(ecu, 0x10, [0x01], 3000);
        return out;
    }

    /**
     * Read fault memory (19 02 FF) from an ECU.
     */
    async readFaults(ecu) {
        var r = await this.physical(ecu, 0x19, [0x02, 0xFF]);
        if (!r || r[0] !== 0x59 || r[1] !== 0x02) return null;
        var out = [];
        var i = 3;
        while (i + 3 < r.length) {
            var code = hx(r[i]) + hx(r[i + 1]) + hx(r[i + 2]);
            var st = r[i + 3];
            var bits = [];
            if (st & 0x01) bits.push('testFailed');
            if (st & 0x02) bits.push('currentDTC');
            if (st & 0x04) bits.push('confirmedDTC');
            if (st & 0x08) bits.push('testNotCompleted');
            if (st & 0x10) bits.push('testFailedSinceLastClear');
            if (st & 0x20) bits.push('testNotCompletedSinceLastClear');
            if (st & 0x40) bits.push('testNotCompletedThisOp');
            if (st & 0x80) bits.push('warningIndicatorRequested');
            out.push({ code: code, status: st, statusBits: bits });
            i += 4;
        }
        return out;
    }

    /* ---------- logging ---------- */

    get logging() { return this._logging; }

    /**
     * Start logging: snapshot current status DIDs from selected ECU addresses.
     * Skips the rest of a DID range after 3 consecutive misses.
     */
    async startLog(ecus) {
        this._logging = true;
        this._logEntries = [];
        this._snapshot = {};
        var ts = Date.now();
        for (var i = 0; i < ecus.length; i++) {
            var addr = ecus[i];
            var misses = 0;
            var lastPrefix = '';
            for (var j = 0; j < LOG_DIDS.length; j++) {
                var did = LOG_DIDS[j];
                var prefix = did.substring(0, 2);
                if (prefix !== lastPrefix) { misses = 0; lastPrefix = prefix; }
                if (misses >= 3) continue;
                var bytes = await this.readDid(addr, did);
                if (bytes) {
                    misses = 0;
                    var key = hx(addr) + ':' + did;
                    var hexStr = bytes.map(function (b) { return hx(b); }).join(' ');
                    this._snapshot[key] = hexStr;
                    this._logEntries.push({ ts: ts, addr: addr, did: did, type: 'snapshot', hex: hexStr });
                } else {
                    misses++;
                }
            }
        }
    }

    async pollLog(ecus) {
        if (!this._logging) return;
        var ts = Date.now();
        for (var i = 0; i < ecus.length; i++) {
            var addr = ecus[i];
            for (var j = 0; j < LOG_DIDS.length; j++) {
                var did = LOG_DIDS[j];
                var key = hx(addr) + ':' + did;
                if (!(key in this._snapshot)) continue;
                var bytes = await this.readDid(addr, did);
                if (!bytes) continue;
                var hexStr = bytes.map(function (b) { return hx(b); }).join(' ');
                if (hexStr !== this._snapshot[key]) {
                    this._logEntries.push({
                        ts: ts, addr: addr, did: did, type: 'change',
                        before: this._snapshot[key], after: hexStr,
                    });
                    this._snapshot[key] = hexStr;
                }
            }
        }
    }

    stopLog() {
        this._logging = false;
        return this._logEntries.filter(function (e) { return e.type === 'change'; });
    }

    getLog() {
        return this._logEntries.slice();
    }
}

/** Well-known DID ranges for the DID scanner page. */
const DID_RANGES = Object.freeze([
    { label: '0x1000-0x10FF  Status', start: 0x1000, end: 0x10FF },
    { label: '0x2000-0x20FF  Measurement', start: 0x2000, end: 0x20FF },
    { label: '0x3000-0x31FF  Coding / NCD', start: 0x3000, end: 0x31FF },
    { label: '0x6000-0x610F  IOControl status', start: 0x6000, end: 0x610F },
    { label: '0xD000-0xD1FF  Dynamic data', start: 0xD000, end: 0xD1FF },
    { label: '0xF100-0xF1FF  Identification', start: 0xF100, end: 0xF1FF },
    { label: '0xF400-0xF4FF  OBD as UDS', start: 0xF400, end: 0xF4FF },
]);

/** NRC code names for display. */
const NRC_NAMES = Object.freeze({
    0x10: 'generalReject', 0x11: 'serviceNotSupported', 0x12: 'subFunctionNotSupported',
    0x13: 'incorrectMessageLength', 0x14: 'responseTooLong', 0x21: 'busyRepeatRequest',
    0x22: 'conditionsNotCorrect', 0x24: 'requestSequenceError', 0x25: 'noResponseFromSubnet',
    0x26: 'failurePreventsExecution', 0x31: 'requestOutOfRange', 0x33: 'securityAccessDenied',
    0x35: 'invalidKey', 0x36: 'exceededNumberOfAttempts', 0x37: 'requiredTimeDelayNotExpired',
    0x70: 'uploadDownloadNotAccepted', 0x71: 'transferDataSuspended', 0x72: 'generalProgrammingFailure',
    0x73: 'wrongBlockSequenceCounter', 0x78: 'requestCorrectlyReceivedResponsePending',
    0x7E: 'subFunctionNotSupportedInActiveSession', 0x7F: 'serviceNotSupportedInActiveSession',
});

module.exports = { ProbeLink, KNOWN_ECUS, ID_DIDS, LOG_DIDS, DID_RANGES, NRC_NAMES };
