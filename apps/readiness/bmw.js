'use strict';
/**
 * bmw.js - BMW's own fault codes (UDS 19 02 replies: 3-byte hex codes such as 140300, with an ISO 14229 status
 * byte), their texts, and the readiness monitor each one belongs to.
 *
 * Texts come from bmw_dtc.pack (kit/tools/readiness_texts.py: the engine unit and gearbox part of Fault Scanner's
 * database): the text of exactly this engine / gearbox type (its SGBD index, 22 F1 50), else the one every type at
 * that address agrees on. A code with neither is shown as "BMW fault <code>".
 *
 * BMW texts read "<what>, <detail>: <symptom>" ("Oxygen sensor behind catalytic converter, heating: Circuit open").
 * The monitor is found from the part before the colon (<what>, <detail>), so a fault that only mentions an oxygen
 * sensor in its symptom ("Coolant temperature sensor, plausibility: implausible versus oxygen-sensor control") isn't
 * counted as an oxygen sensor fault. Bus messages and temperature sensors belong to no monitor here.
 */
const path = require('path');
const pack = require('./kit/pack');

const DB = pack.open(path.join(__dirname, 'bmw_dtc'));
const INDEX = DB.json('sgbd_index.json');
const hex = (n, w) => n.toString(16).toUpperCase().padStart(w || 2, '0');
const ascii = (s) => String(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae')
    .replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue').replace(/ß/g, 'ss').replace(/[^\x20-\x7e°·]/g, '');

/** the unit type (DME8FF_R, GSZF04GD ...) for an address and its SGBD index, or null */
function variant(addr, index) {
    const v = index ? INDEX[hex(addr) + ' ' + index] : null;
    return v && /^[A-Za-z0-9_]+$/.test(v) ? v : null;
}

/** the BMW text of a fault, or null */
function text(addr, code, type) {
    const t = (type && DB.get('tables/variant/' + type.toLowerCase() + '.json', code)) || DB.get('tables/addr/' + hex(addr) + '.json', code);
    return t ? ascii(t) : null;
}

// the monitor a fault's subject belongs to (first match wins)
// (null: belongs to no monitor, whatever else it mentions)
const RULES = [
    [/^\s*(\w+ )?(signal \(|message|faulty message|info\b)/i, null],
    [/temperature sensor/i, null],
    [/misfir/i, 'misfire'],
    [/secondary.?air/i, 'secondaryAir'],
    [/tank vent|tank-vent|tank leak|leak diagnos|dm-?tl|evaporat|purge|activated.?charcoal|carbon canister|fuel tank/i, 'evap'],
    [/refrigerant|a\/c compressor|air.?condition/i, 'ac'],
    [/electrically heated cat/i, 'heatedCat'],
    [/(oxygen|lambda|o2)[^:]*heat/i, 'o2Heater'],
    [/\bnox\b|\bscr\b|urea|adblue|reducing agent/i, 'nox'],
    [/oxygen|lambda|\bo2\b|exhaust.?gas sensor/i, 'o2'],
    [/particulate filter/i, 'pm'],
    [/catalytic converter|catalyst/i, 'catalyst'],
    [/exhaust.?gas recirc|\begr\b/i, 'egr'],
    [/mixture|fuel trim|fuel-air|lean|rich|fuel system/i, 'fuel'],
];
/** the monitor key for a BMW fault text, or null (not one of the readiness systems) */
function system(t) {
    if (!t) return null;
    const what = String(t).split(':')[0];
    const hit = RULES.find((r) => r[0].test(what));
    return hit ? hit[1] : null;
}

/** status byte -> { kind, label, sev }: active now, check engine lamp on, stored (confirmed), pending, or history */
function status(b) {
    if (b & 0x01) return { kind: 'active', label: 'ACTIVE', sev: 'crit' };
    if (b & 0x80) return { kind: 'lamp', label: 'MIL ON', sev: 'crit' };
    if (b & 0x08) return { kind: 'stored', label: 'STORED', sev: 'warn' };
    if (b & 0x04) return { kind: 'pending', label: 'PENDING', sev: 'warn' };
    return { kind: 'history', label: 'HISTORY', sev: 'dim' };
}

/** a 19 02 reply -> [{ code: '140300', status }], or null (refused / not this reply) */
function parse(uds) {
    if (!uds || uds[0] !== 0x59 || uds[1] !== 0x02) return null;
    const out = [];
    for (let i = 3; i + 4 <= uds.length; i += 4) out.push({ code: hex(((uds[i] << 16) | (uds[i + 1] << 8) | uds[i + 2]) >>> 0, 6), status: uds[i + 3] });
    return out;
}

module.exports = { variant, text, system, status, parse, hasTexts: Object.keys(INDEX).length > 0 };
