'use strict';
/**
 * Demo link: simulates FLM coding reads and BDC IOControl for the strobe.
 * Changes stay in memory (not persisted).
 */

const BLOCKS = {
    // FLM L 0x43, DID 3100: byte 0 = DRL brightness (0x64 = 100%)
    '43:3100': [0x64, 0x00, 0x00, 0x00],
    // FLM R 0x44, DID 3100
    '44:3100': [0x64, 0x00, 0x00, 0x00],
};

const ECUS = {
    0x40: { index: '0F4800', name: 'BDC_G01' },
    0x43: { index: '0F5A00', name: 'FLM_LEFT' },
    0x44: { index: '0F5A01', name: 'FLM_RIGHT' },
};

class DemoLink {
    constructor(log) {
        this.log = log;
        this.blocks = {};
        Object.keys(BLOCKS).forEach(function (k) { this.blocks[k] = BLOCKS[k].slice(); }.bind(this));
        this.ioState = {}; // 'ecu:did' -> true/false
        this.available = true;
        this.ready = true;
        this.failed = null;
        this.stats = { sent: 0, replies: 0, missed: 0, blocked: 0, writes: 0, io: 0 };
    }

    async init() { return this; }
    silent() { return false; }
    wake() {}

    async readDid(ecu, did) {
        var key = ecu.toString(16) + ':' + did;
        var block = this.blocks[key];
        if (!block) return null;
        this.stats.sent++; this.stats.replies++;
        return block.slice();
    }

    async writeDid(ecu, did, block) {
        var key = ecu.toString(16) + ':' + did;
        if (!this.blocks[key]) return false;
        this.blocks[key] = block.slice();
        this.stats.sent++; this.stats.replies++; this.stats.writes++;
        this.log.info('demo write ' + key + ': ' + block.map(function (b) { return b.toString(16).toUpperCase().padStart(2, '0'); }).join(' '));
        return true;
    }

    async ioControl(ecu, did, on) {
        var key = ecu.toString(16) + ':' + did;
        this.ioState[key] = on;
        this.stats.sent++; this.stats.replies++; this.stats.io++;
        return true;
    }

    async ioRestore(ecu, did) {
        var key = ecu.toString(16) + ':' + did;
        delete this.ioState[key];
        this.stats.sent++; this.stats.replies++;
        return true;
    }

    async identify(ecu) {
        var e = ECUS[ecu];
        return e ? e.index : '';
    }
}

function ecuName(ecu) {
    var e = ECUS[ecu];
    return e ? e.name : '';
}

module.exports = { DemoLink, BLOCKS, ECUS, ecuName };
