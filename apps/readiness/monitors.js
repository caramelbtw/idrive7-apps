'use strict';
/**
 * monitors.js - what the engine unit's OBD-II answers mean (SAE J1979 / ISO 15031-5, public standards).
 *
 *   readiness(data)   service 01 PID 01 (since faults cleared) or PID 41 (this drive cycle), 4 data bytes A B C D:
 *                     A bit 7 = check engine lamp, bits 0-6 = confirmed emission faults;
 *                     B bits 0-2 = misfire / fuel system / components monitored, bits 4-6 = not complete yet,
 *                     bit 3 = compression ignition (diesel); C = the non-continuous monitors this engine has,
 *                     D = the ones not complete yet (bit 0 catalyst ... bit 7 EGR, below).
 *   merge(list)       two engine units (V8 / V12): a monitor is there when either has it, complete only when every
 *                     unit that has it says so
 *   rows(r, opts)     the rows to show: optional monitors this car lacks are left out; a core one it lacks stays,
 *                     "not supported", and doesn't count
 *   dtcs(uds, sid)    a service 03 / 07 / 0A reply -> ['P0420', ...]
 *   classify(code)    the monitor (system) a generic P-code belongs to, and its standard description where known
 *   plan(rows, ...)   the driving that completes what is still incomplete, in the order to do it
 */

// petrol (spark ignition) monitors, in the order they're shown. byte: 'B' or 'C'/'D' bits; optional: some cars have it
const SPARK = [
    { key: 'misfire', name: 'Misfire', bit: 0, cont: true },
    { key: 'fuel', name: 'Fuel system', bit: 1, cont: true },
    { key: 'components', name: 'Components', bit: 2, cont: true },
    { key: 'catalyst', name: 'Catalyst', bit: 0 },
    { key: 'heatedCat', name: 'Heated catalyst', bit: 1, optional: true },
    { key: 'evap', name: 'Evaporative system', bit: 2 },
    { key: 'secondaryAir', name: 'Secondary air system', bit: 3, optional: true },
    { key: 'ac', name: 'A/C refrigerant', bit: 4, optional: true },
    { key: 'o2', name: 'Oxygen sensor', bit: 5 },
    { key: 'o2Heater', name: 'Oxygen sensor heater', bit: 6 },
    { key: 'egr', name: 'EGR system', bit: 7 },
];
// the same bits on a diesel (compression ignition) mean other monitors
const DIESEL = [
    { key: 'misfire', name: 'Misfire', bit: 0, cont: true },
    { key: 'fuel', name: 'Fuel system', bit: 1, cont: true },
    { key: 'components', name: 'Components', bit: 2, cont: true },
    { key: 'catalyst', name: 'NMHC catalyst', bit: 0 },
    { key: 'nox', name: 'NOx / SCR aftertreatment', bit: 1, optional: true },
    { key: 'boost', name: 'Boost pressure', bit: 3, optional: true },
    { key: 'o2', name: 'Exhaust gas sensor', bit: 5 },
    { key: 'pm', name: 'Particulate filter', bit: 6, optional: true },
    { key: 'egr', name: 'EGR / VVT system', bit: 7 },
];

/** PID 01 / 41 data (the 4 bytes after 41 01) -> { mil, count, diesel, mon: { key: { has, done } } }, or null */
function readiness(data) {
    if (!data || data.length < 4) return null;
    const [A, B, C, D] = data, diesel = !!(B & 0x08), list = diesel ? DIESEL : SPARK, mon = {};
    list.forEach((m) => {
        if (m.cont) mon[m.key] = { has: !!(B & (1 << m.bit)), done: !(B & (0x10 << m.bit)) };
        else mon[m.key] = { has: !!(C & (1 << m.bit)), done: !(D & (1 << m.bit)) };
    });
    return { mil: !!(A & 0x80), count: A & 0x7F, diesel, mon };
}

/** Several engine units' readiness as one (see the top of the file). */
function merge(list) {
    const rs = list.filter(Boolean);
    if (!rs.length) return null;
    const out = { mil: rs.some((r) => r.mil), count: rs.reduce((a, r) => a + r.count, 0), diesel: rs[0].diesel, mon: {} };
    (out.diesel ? DIESEL : SPARK).forEach((m) => {
        const have = rs.map((r) => r.mon[m.key]).filter((x) => x && x.has);
        out.mon[m.key] = { has: have.length > 0, done: have.every((x) => x.done) };
    });
    return out;
}

/**
 * The rows to show: [{ key, name, state: 'done' | 'pending' | 'na', drive: 'done' | 'pending' | null }].
 * r = since faults cleared (PID 01), cycle = this drive (PID 41, or null).
 * keep = the optional monitors found when the app first read this car (they stay, or stay gone, after that).
 */
function rows(r, cycle, keep) {
    if (!r) return [];
    return (r.diesel ? DIESEL : SPARK).filter((m) => !m.optional || (keep ? keep.indexOf(m.key) >= 0 : r.mon[m.key].has)).map((m) => {
        const x = r.mon[m.key], c = cycle && cycle.mon[m.key];
        return {
            key: m.key, name: m.name, cont: !!m.cont,
            state: !x.has ? 'na' : x.done ? 'done' : 'pending',
            drive: x.has && c && c.has ? (c.done ? 'done' : 'pending') : null,
        };
    });
}
/** the optional monitors this car has (rows() keeps exactly these afterwards) */
const optionalPresent = (r) => (r ? (r.diesel ? DIESEL : SPARK).filter((m) => m.optional && r.mon[m.key].has).map((m) => m.key) : []);

/** { done, total, pending: [row] } over the monitors this car supports */
function progress(list) {
    const sup = list.filter((x) => x.state !== 'na');
    return { done: sup.filter((x) => x.state === 'done').length, total: sup.length, pending: sup.filter((x) => x.state === 'pending') };
}

/* ---------- emission faults ---------- */

/** one 2-byte fault (J2012): P0420 etc. */
function code(b0, b1) {
    return 'PCBU'[b0 >> 6] + ((b0 >> 4) & 3) + [b0 & 0xF, b1 >> 4, b1 & 0xF].map((n) => n.toString(16).toUpperCase()).join('');
}

/**
 * A service 03 / 07 / 0A reply -> fault codes. On CAN the reply is 43 <count> <2 bytes each>; the older form is
 * 43 and pairs padded with 00 00. null: not a reply to this service (refused or none).
 */
function dtcs(uds, sid) {
    if (!uds || uds[0] !== sid + 0x40) return null;
    let b = uds.slice(1);
    if (b.length % 2 === 1 && b[0] * 2 === b.length - 1) b = b.slice(1);
    else if (b.length % 2 === 1) b = b.slice(0, b.length - 1);
    const out = [];
    for (let i = 0; i + 1 < b.length; i += 2) {
        if (!b[i] && !b[i + 1]) continue;
        const c = code(b[i], b[i + 1]);
        if (out.indexOf(c) < 0) out.push(c);
    }
    return out;
}

// SAE J2012 generic descriptions (the public, manufacturer-independent part) for common emission faults
const TEXT = {
    P0010: 'Camshaft actuator circuit, bank 1', P0011: 'Camshaft timing over-advanced, bank 1', P0012: 'Camshaft timing over-retarded, bank 1',
    P0101: 'Air mass flow sensor range / performance', P0106: 'Manifold pressure sensor range / performance', P0128: 'Coolant below thermostat temperature',
    P0130: 'O2 sensor circuit, bank 1 sensor 1', P0133: 'O2 sensor slow response, bank 1 sensor 1', P0135: 'O2 sensor heater circuit, bank 1 sensor 1',
    P0136: 'O2 sensor circuit, bank 1 sensor 2', P0141: 'O2 sensor heater circuit, bank 1 sensor 2', P0150: 'O2 sensor circuit, bank 2 sensor 1',
    P0153: 'O2 sensor slow response, bank 2 sensor 1', P0155: 'O2 sensor heater circuit, bank 2 sensor 1', P0156: 'O2 sensor circuit, bank 2 sensor 2',
    P0161: 'O2 sensor heater circuit, bank 2 sensor 2', P0171: 'System too lean, bank 1', P0172: 'System too rich, bank 1',
    P0174: 'System too lean, bank 2', P0175: 'System too rich, bank 2', P0300: 'Random / multiple cylinder misfire',
    P0401: 'EGR flow insufficient', P0402: 'EGR flow excessive', P0411: 'Secondary air incorrect flow',
    P0420: 'Catalyst efficiency below threshold, bank 1', P0424: 'Heated catalyst temperature below threshold, bank 1', P0430: 'Catalyst efficiency below threshold, bank 2',
    P0441: 'Evaporative system incorrect purge flow', P0442: 'Evaporative system small leak', P0455: 'Evaporative system large leak',
    P0456: 'Evaporative system very small leak', P0496: 'Evaporative system high purge flow', P0505: 'Idle air control system',
    P0530: 'A/C refrigerant pressure sensor circuit', P0597: 'Thermostat heater control circuit open',
};
const MONITOR_NAME = {};
SPARK.concat(DIESEL).forEach((m) => { if (!MONITOR_NAME[m.key]) MONITOR_NAME[m.key] = m.name; });

// generic P0 / P2 code ranges -> the monitor they belong to (first match wins)
const RANGES = [
    [0x0300, 0x0312, 'misfire'],
    [0x0170, 0x0175, 'fuel'], [0x2177, 0x2180, 'fuel'], [0x2187, 0x2190, 'fuel'],
    [0x0424, 0x0424, 'heatedCat'], [0x0434, 0x0434, 'heatedCat'], [0x0420, 0x0439, 'catalyst'],
    [0x0410, 0x0419, 'secondaryAir'], [0x2440, 0x2445, 'secondaryAir'],
    [0x0440, 0x0459, 'evap'], [0x0496, 0x0499, 'evap'], [0x2400, 0x2422, 'evap'],
    [0x0530, 0x0534, 'ac'],
    [0x0030, 0x0064, 'o2Heater'], [0x0135, 0x0135, 'o2Heater'], [0x0141, 0x0141, 'o2Heater'], [0x0147, 0x0147, 'o2Heater'],
    [0x0155, 0x0155, 'o2Heater'], [0x0161, 0x0161, 'o2Heater'], [0x0167, 0x0167, 'o2Heater'],
    [0x0130, 0x0167, 'o2'], [0x2195, 0x2198, 'o2'], [0x2270, 0x2273, 'o2'],
    [0x0400, 0x0409, 'egr'], [0x0486, 0x0489, 'egr'], [0x2413, 0x2413, 'egr'],
];

/** { code, system: monitor key, systemName, text } for one fault code */
function classify(c) {
    const out = { code: c, system: 'components', systemName: 'Components', text: TEXT[c] || '' };
    if (/^P[02]/.test(c)) {
        const n = parseInt(c.slice(1), 16), hit = RANGES.find((r) => n >= r[0] && n <= r[1]);
        if (hit) out.system = hit[2];
        if (!out.text && n >= 0x0301 && n <= 0x0312) out.text = 'Cylinder ' + parseInt(c.slice(3), 10) + ' misfire';
    } else if (c[0] !== 'P') { out.system = 'other'; }
    out.systemName = out.system === 'other' ? 'Body / chassis / network' : MONITOR_NAME[out.system] || 'Components';
    if (!out.text) out.text = /^P[13]/.test(c) ? 'Manufacturer-specific fault' : c[0] === 'U' ? 'Network communication fault' : 'Emission-related fault';
    return out;
}

/* ---------- the driving that completes the rest ---------- */

/**
 * Drive-cycle steps, in the order to do them. covers = monitor keys; text(sp) = the instruction, speeds in the unit
 * the settings name. Generic guidance (the exact enable conditions are the manufacturer's and vary by engine).
 */
const STEPS = [
    {
        id: 'cold', style: 'Cold start', covers: ['o2Heater', 'secondaryAir', 'heatedCat'],
        short: 'Cold start, then idle 2 min',
        text: () => 'Let the car stand for 8 hours or more, so the coolant is at outside temperature. Start it and let it idle for ' +
            '2 minutes with no throttle, lights and A/C off. Don\'t switch it off again right away.',
    },
    {
        id: 'warm', style: 'Gentle mixed driving', covers: ['misfire', 'fuel', 'components'],
        short: 'Gentle mixed driving, 15 min',
        text: (sp) => 'Drive normally for about 15 minutes until the engine is fully warm: city and suburban roads with ' +
            'smooth throttle, some steady stretches at ' + sp(50) + ' and a little idling at lights.',
    },
    {
        id: 'cruise', style: 'Steady cruise', covers: ['catalyst', 'heatedCat', 'o2', 'egr', 'nox', 'boost'],
        short: 'Steady cruise {70}-{90} {u}, 10 min',
        text: (sp, num) => 'With the engine warm, hold a steady ' + num(70) + ' to ' + sp(90) + ' on light, constant throttle for ' +
            '5 to 10 minutes. No hard acceleration, no sudden lifts; cruise control helps.',
    },
    {
        id: 'coast', style: 'Coast-downs', covers: ['o2', 'egr', 'fuel'],
        short: 'Coast {90} to {50} {u}, no brakes, 4x',
        text: (sp) => 'From about ' + sp(90) + ', take your foot off completely and coast down to ' + sp(50) + ' in gear, without ' +
            'braking or shifting. Do it 3 to 5 times, with half a minute of steady cruising in between.',
    },
    {
        id: 'pm', style: 'Highway run', covers: ['pm'],
        short: 'Highway run, 20 min',
        text: (sp) => 'A continuous 20-minute run above ' + sp(80) + ' lets the particulate filter heat up and regenerate. ' +
            'Don\'t switch off while it regenerates (higher idle, fan running).',
    },
    {
        id: 'ac', style: 'Run the A/C', covers: ['ac'],
        short: 'A/C on, 10 min, warm engine',
        text: () => 'With the engine warm, run the air conditioning for 10 minutes or more (outside temperature above about 15 °C).',
    },
    {
        id: 'park', style: 'Park overnight', covers: ['evap'],
        short: 'Tank 1/4-3/4, park 6 h+',
        text: () => 'Keep the fuel tank between 1/4 and 3/4 full and don\'t refuel just before. Then park with the ignition off ' +
            'and the car locked for 6 hours or more (overnight is best): on many cars, BMW\'s with the DM-TL pump among them, ' +
            'the leak test runs after the engine is switched off.',
    },
];

/**
 * The steps that complete what's still pending: { steps: [{ id, style, short, text, covers: [names] }], style, pending }.
 * style: the way to drive now (the driving step covering the most pending monitors; ties: the earlier one). faults: emission
 * faults are stored (they can keep their monitors from running at all). units: 'kmh' or 'mph'.
 */
function plan(list, faults, units) {
    const mph = units === 'mph';
    const num = (kmh) => String(mph ? Math.round(kmh / 1.609 / 5) * 5 : kmh);
    const unit = mph ? 'mph' : 'km/h';
    const sp = (kmh) => num(kmh) + ' ' + unit;
    const pending = list.filter((x) => x.state === 'pending'), keys = pending.map((x) => x.key);
    const names = {};
    list.forEach((x) => { names[x.key] = x.name; });
    const steps = [];
    if (faults) {
        steps.push({
            id: 'fault', style: 'Fix the fault first', short: 'Have the stored fault repaired first', covers: [],
            text: () => 'An emission fault is stored. Its monitor (and others that depend on it) may not run until it is ' +
                'repaired, so driving alone may not make the car ready.',
        });
    }
    STEPS.forEach((s) => {
        const c = s.covers.filter((k) => keys.indexOf(k) >= 0);
        if (c.length) steps.push(Object.assign({}, s, { covers: c }));
    });
    const fill = (str) => str.replace(/\{u\}/g, unit).replace(/\{(\d+)\}/g, (m, n) => num(Number(n)));
    const out = steps.map((s) => ({ id: s.id, style: s.style, short: fill(s.short), text: s.text(sp, num), covers: s.covers.map((k) => names[k] || k) }));
    // the style to drive in: a driving step (a cold start or parking is a step, not a way to drive) unless only those are left
    const driving = out.filter((s) => ['fault', 'cold', 'park'].indexOf(s.id) < 0);
    const best = driving.reduce((b, s) => (!b || s.covers.length > b.covers.length ? s : b), null) || out.find((s) => s.id === 'cold') || out.find((s) => s.id === 'park') || null;
    return { steps: out, style: faults ? out[0] : best, pending: pending.length };
}

const monitorName = (key) => MONITOR_NAME[key] || key;

module.exports = { monitorName, SPARK, DIESEL, readiness, merge, rows, optionalPresent, progress, code, dtcs, classify, plan, STEPS };
