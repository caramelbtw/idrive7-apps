'use strict';
/**
 * coding.js - DRL brightness control for G01 X3.
 *
 * Only the FLM (headlight module) DRL brightness option is kept.
 * Both left and right FLMs are written together.
 */

const ECU = {
    FLM_L: 0x43,
    FLM_R: 0x44,
};

const OPTIONS = [
    {
        id: 'drl_brightness',
        name: 'DRL brightness',
        ecu: ECU.FLM_L,
        did: '3100',
        byte: 0,
        bit: 0,
        width: 8,
        type: 'choice',
        choices: [
            { value: 0x64, label: '100% (stock)' },
            { value: 0x50, label: '80%' },
            { value: 0x3C, label: '60%' },
            { value: 0x28, label: '40%' },
            { value: 0x14, label: '20%' },
        ],
        description: 'Daytime running light LED brightness',
        safe: true,
    },
];

function readBits(block, opt) {
    if (!block || block.length <= opt.byte) return null;
    var mask = (1 << opt.width) - 1;
    return (block[opt.byte] >> opt.bit) & mask;
}

function writeBits(block, opt, value) {
    var out = block.slice();
    if (out.length <= opt.byte) return out;
    var mask = ((1 << opt.width) - 1) << opt.bit;
    out[opt.byte] = (out[opt.byte] & ~mask) | ((value << opt.bit) & mask);
    return out;
}

function label(opt, raw) {
    if (opt.type === 'toggle') return raw ? 'On' : 'Off';
    var c = (opt.choices || []).find(function (ch) { return ch.value === raw; });
    return c ? c.label : 'Unknown (' + raw + ')';
}

function next(opt, raw) {
    if (opt.type === 'toggle') return raw ? 0 : 1;
    var vals = (opt.choices || []).map(function (c) { return c.value; });
    var i = vals.indexOf(raw);
    return vals[(i + 1) % vals.length];
}

module.exports = { ECU, OPTIONS, readBits, writeBits, label, next };
