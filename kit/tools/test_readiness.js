'use strict';
// Readiness: the read-only guard, the OBD-II decoding, and the whole app against a fake head unit whose transport
// records every request that reaches it. No SDK or vehicle needed:
//   node kit/tools/test_readiness.js                  (PREVIEW=<dir> also saves each page as a PNG)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime'), APP = path.join(ROOT, 'apps', 'readiness');
const load = Module._load;
let mguApp = null;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu') return { run(a) { mguApp = a; } };
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { check, ReadinessLink } = require(path.join(APP, 'link'));
const M = require(path.join(APP, 'monitors'));
const DEMO = require(path.join(APP, 'demo'));

let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- the guard ---------- */
test('guard allows only the listed reads', () => {
    [[0x12, 0x01, [0x01]], [0x12, 0x01, [0x41]], [0x13, 0x01, [0x00]], [0x12, 0x01, [0x4E]],
        [0x12, 0x03, []], [0x12, 0x07, []], [0x18, 0x0A, []],
        [0x12, 0x19, [0x02, 0x0C]], [0x18, 0x19, [0x02, 0xFF]], [0x12, 0x22, [0xF1, 0x50]],
        [0x12, 0x22, [0xF4, 0x01]], [0x13, 0x22, [0xF4, 0x41]], [0x12, 0x22, [0xF4, 0x00]]].forEach(([a, s, d]) => check(a, s, d));
    const bad = [
        [0x12, 0x04, []],                 // OBD clear faults
        [0x12, 0x14, [0xFF, 0xFF, 0xFF]], // UDS clear DTCs
        [0x12, 0x10, [0x03]],             // session
        [0x12, 0x11, [0x01]],             // reset
        [0x12, 0x2E, [0xF1, 0x90, 0]],    // write
        [0x12, 0x2F, [0x60, 0xFD, 0x03]], // actuate
        [0x12, 0x31, [0x01, 0x0F, 0x0C]], // routine
        [0x12, 0x3E, [0x00]],             // tester present
        [0x12, 0x85, [0x02]],             // DTC setting
        [0x12, 0x22, [0xF1, 0x90]],       // only F1 50 of 22
        [0x12, 0x22, [0xF1, 0x50, 0xF1, 0x90]],
        [0x12, 0x22, [0xF4, 0x0C]],       // F4 only with the PIDs of 01
        [0x12, 0x22, [0xF4, 0x01, 0xF4]],
        [0x12, 0x22, [0xF6, 0x01]],
        [0x12, 0x19, [0x02]],             // 19 02 needs its mask
        [0x12, 0x19, [0x04, 0x14, 0x03, 0x02, 0xFF]], // other 19 sub-functions: no
        [0x12, 0x19, [0x0A, 0x00]],
        [0x12, 0x19, [0x17, 0x0C]],
        [0x12, 0x08, [0x01]],             // OBD on-board test control
        [0x12, 0x01, [0x0C]],             // a PID not on the list
        [0x12, 0x01, [0x01, 0x41]],       // two PIDs
        [0x12, 0x03, [0x00]],             // 03 with data
        [0xDF, 0x01, [0x01]],             // everyone
        [0x40, 0x03, []],                 // a unit not on the list
        [0x12, 0x01, [256]],
    ];
    bad.forEach(([a, s, d]) => assert.throws(() => check(a, s, d), /read-only/, 'not refused: ' + [a, s, d].join(' ')));
});

/* ---------- a fake head unit: TASU answered by the demo car, every request recorded ---------- */
function fakeSignals(sent, answer) {
    const bus = new EventEmitter();
    return {
        async proxy() { return { id: 'tasu' }; },
        async on(p, ev, fn) { bus.on(ev, fn); },
        async onAvailable(p, fn) { fn(true); },
        async call(p, method, req) {
            assert.strictEqual(method, 'sendTasuRequest');
            const data = Array.from(req.udsData);
            sent.push([req.targetAddress, req.serviceID, data]);
            setTimeout(() => {
                const r = (answer || DEMO.reply)(req.targetAddress, req.serviceID, data);
                if (r) bus.emit('sendTasuResponse', { udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, req.targetAddress, 0, 0].concat(r)), errorCode: 'NO_ERROR' });
            }, 2);
            return 'NO_ERROR';
        },
    };
}
const quietLog = { info() {}, warn() {}, error() {} };

test('a blocked request never reaches the transport', async () => {
    const sent = [], link = await new ReadinessLink(fakeSignals(sent), quietLog, { gapMs: 1 }).init();
    await assert.rejects(() => link.ask(0x12, 0x04, []), /read-only/);
    await assert.rejects(() => link.ask(0x12, 0x14, [0xFF, 0xFF, 0xFF]), /read-only/);
    assert.strictEqual(sent.length, 0);
    const r = await link.ask(0x12, 0x22, [0xF4, 0x01]);
    assert.deepStrictEqual(r.slice(0, 3), [0x62, 0xF4, 0x01]);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(link.stats.blocked, 2);
});

/* ---------- decoding ---------- */
test('PID 01 decoding, optional monitors left out', () => {
    // catalyst, evap, O2, O2 heater present; secondary air, heated cat, A/C, EGR absent; catalyst + O2 incomplete
    const r = M.readiness([0x83, 0x07, 0x65, 0x21]);
    assert.strictEqual(r.mil, true); assert.strictEqual(r.count, 3); assert.strictEqual(r.diesel, false);
    const rows = M.rows(r, null);
    assert.deepStrictEqual(rows.map((x) => x.key), ['misfire', 'fuel', 'components', 'catalyst', 'evap', 'o2', 'o2Heater', 'egr']);
    assert.strictEqual(rows.find((x) => x.key === 'egr').state, 'na');
    assert.strictEqual(M.progress(rows).done, 5); assert.strictEqual(M.progress(rows).total, 7);
    assert.deepStrictEqual(rows.filter((x) => x.state === 'pending').map((x) => x.key), ['catalyst', 'o2']);
    // all three optional ones present
    assert.deepStrictEqual(M.optionalPresent(M.readiness([0, 0x07, 0x1A, 0])), ['heatedCat', 'secondaryAir', 'ac']);
    // the set found first stays (keep), whatever a later answer says
    assert.ok(M.rows(M.readiness([0, 7, 0x65, 0]), null, ['secondaryAir']).some((x) => x.key === 'secondaryAir'));
});

test('two engine units merge: complete only when both are', () => {
    const a = M.readiness([0, 0x07, 0x21, 0x00]), b = M.readiness([0, 0x07, 0x21, 0x01]);
    const m = M.merge([a, b]);
    assert.strictEqual(m.mon.catalyst.done, false);
    assert.strictEqual(m.mon.o2.done, true);
});

test('fault decoding (CAN count form and padded form) and classification', () => {
    assert.deepStrictEqual(M.dtcs([0x43, 0x02, 0x04, 0x20, 0x01, 0x71], 0x03), ['P0420', 'P0171']);
    assert.deepStrictEqual(M.dtcs([0x43, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00], 0x03), ['P0300']);
    assert.deepStrictEqual(M.dtcs([0x43, 0x00], 0x03), []);
    assert.strictEqual(M.dtcs([0x7F, 0x03, 0x11], 0x03), null);
    assert.strictEqual(M.code(0xC1, 0x00), 'U0100');
    assert.strictEqual(M.classify('P0303').system, 'misfire');
    assert.strictEqual(M.classify('P0303').text, 'Cylinder 3 misfire');
    assert.strictEqual(M.classify('P0456').system, 'evap');
    assert.strictEqual(M.classify('P0141').system, 'o2Heater');
    assert.strictEqual(M.classify('P0133').system, 'o2');
    assert.strictEqual(M.classify('P0411').system, 'secondaryAir');
});

test('drive plan covers every pending monitor, in order', () => {
    const rows = M.rows(M.readiness([0, 0x07, 0x6D, 0x6D]), null);    // all non-continuous ones incomplete
    const pl = M.plan(rows, false, 'kmh');
    assert.deepStrictEqual(pl.steps.map((s) => s.id), ['cold', 'cruise', 'coast', 'park']);
    const covered = new Set([].concat.apply([], pl.steps.map((s) => s.covers)));
    rows.filter((r) => r.state === 'pending').forEach((r) => assert.ok(covered.has(r.name), r.name + ' not covered'));
    assert.strictEqual(pl.style.id, 'cruise');
    assert.ok(/45-55 mph/.test(M.plan(rows, false, 'mph').steps[1].short));
    assert.strictEqual(M.plan(rows, true, 'kmh').style.id, 'fault');
    assert.strictEqual(M.plan(M.rows(M.readiness([0, 7, 0x6D, 0]), null), false, 'kmh').steps.length, 0);
});

test('BMW fault memory: parse, text, monitor', () => {
    const BMW = require(path.join(APP, 'bmw'));
    const list = BMW.parse([0x59, 0x02, 0xFF, 0x19, 0x03, 0x02, 0x04, 0x14, 0x03, 0x00, 0x09]);
    assert.deepStrictEqual(list, [{ code: '190302', status: 0x04 }, { code: '140300', status: 0x09 }]);
    assert.strictEqual(BMW.parse([0x7F, 0x19, 0x31]), null);
    assert.strictEqual(BMW.status(0x09).label, 'ACTIVE');
    assert.strictEqual(BMW.status(0x88).label, 'MIL ON');
    assert.strictEqual(BMW.status(0x04).label, 'PENDING');
    const type = BMW.variant(0x12, '0F26E8');
    assert.strictEqual(type, 'DME8FF_R');
    assert.ok(/misfire/i.test(BMW.text(0x12, '140300', type)), BMW.text(0x12, '140300', type));
    assert.ok(/leak/i.test(BMW.text(0x12, '190302', type)));
    assert.strictEqual(BMW.system(BMW.text(0x12, '140300', type)), 'misfire');
    assert.strictEqual(BMW.system(BMW.text(0x12, '190302', type)), 'evap');
    assert.strictEqual(BMW.system('Oxygen sensor upstream of catalytic converter, heating, activation: Short circuit with ground'), 'o2Heater');
    assert.strictEqual(BMW.system('Oxygen sensor behind catalytic converter 2, mixture control: Exhaust gas downstream'), 'o2');
    assert.strictEqual(BMW.system('Catalytic converter 2: Efficiency insufficient'), 'catalyst');
    assert.strictEqual(BMW.system('Mixture control 2: Fuel-air mixture overly lean'), 'fuel');
    assert.strictEqual(BMW.system('Secondary air system: Secondary air mass too low'), 'secondaryAir');
    assert.strictEqual(BMW.system('Exhaust-gas recirculation valve actuation: Maximum current exceeded'), 'egr');
    assert.strictEqual(BMW.system('Coolant-temperature sensor, plausibility: implausible versus oxygen-sensor control'), null);
    assert.strictEqual(BMW.system('Signal (request air conditioning, 0x1FE) not valid, sender IHKA'), null);
});

/* ---------- the whole app on the fake head unit ---------- */
async function runApp(demoSetting, sent, answer) {
    const { Recorder, play } = require(path.join(KIT, 'record'));
    const { Canvas } = require(path.join(KIT, 'canvas'));
    const themes = require(path.join(KIT, 'themes'));
    const vals = { units: 'kmh', theme: 'm_tricolour', demo: demoSetting };
    const clicks = {}, frames = [];
    let tab = null, kick = null;
    mguApp = null;
    delete require.cache[require.resolve(path.join(APP, 'main'))];
    require(path.join(APP, 'main'));
    const ctx = {
        log: quietLog, dataDir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'rd-')),
        signals: fakeSignals(sent, answer),
        settings: { get: (k) => vals[k], onChange() {} },
        theme: () => themes.theme(vals.theme),
        canvas: (w, h) => {
            // the strings drawn, for the checks (glyphs are all a Recorder keeps)
            const r = new Recorder(w, h), text = r.text.bind(r);
            r.said = [];
            r.text = (str, ...a) => { r.said.push(String(str)); return text(str, ...a); };
            return r;
        },
        ui: {
            onClick(id, fn) { clicks[id] = fn; }, text() {}, isVisible: () => true, onVisible() {}, onFocus() {},
            async image(id, cv) { frames.push(cv); },
        },
        onTab(fn) { tab = fn; }, onLayout() {}, hideButton() {},
        loop(name, fps, fn) { kick = fn; return { kick() {} }; },
    };
    await mguApp.start(ctx);
    const shot = async (name) => {
        frames.forEach((f) => { f.said = []; });
        await kick();
        const rec = frames[frames.length - 1];
        if (process.env.PREVIEW) {
            const c = new Canvas(rec.w, rec.h);
            play(rec.words(), c);
            fs.mkdirSync(process.env.PREVIEW, { recursive: true });
            fs.writeFileSync(path.join(process.env.PREVIEW, name + '.png'), c.png());
        }
        return rec;
    };
    const texts = () => { const rec = frames[frames.length - 1]; return rec && rec.said ? rec.said.join(' | ') : ''; };
    return { clicks, tab: (i) => tab(i), shot, frames, texts };
}

test('app on a real (fake) link sends only allowed reads, and draws every page', async () => {
    const sent = [];
    const app = await runApp('off', sent);
    await new Promise((r) => setTimeout(r, 5000));         // the first polls (the absent second engine unit takes 2 s)
    assert.ok(sent.length > 5, 'asked the car: ' + sent.length);
    sent.forEach(([a, s, d]) => check(a, s, d));
    assert.ok(sent.every(([, s]) => [0x01, 0x03, 0x07, 0x0A, 0x19, 0x22].indexOf(s) >= 0));
    assert.ok(sent.some(([a, s, d]) => a === 0x12 && s === 0x19 && d[0] === 0x02), 'read BMW fault memory');
    assert.ok(sent.some(([a, s]) => a === 0x12 && s === 0x22), 'identified the engine unit');
    assert.ok(sent.some(([, s]) => s === 0x07), 'read pending OBD faults');
    assert.ok(sent.filter(([a, s, d]) => a === 0x12 && s === 0x22 && d[0] === 0xF4 && d[1] === 0x01).length >= 1, 'readiness by 22 F4 01');
    await new Promise((r) => setTimeout(r, 1500));         // the fault memory
    await app.shot('1-readiness');
    app.tab(1); await app.shot('2-faults');
    app.tab(2); await app.shot('3-plan');
    // Refresh asks again, still only reads
    const n = sent.length;
    app.clicks.BTN_REFRESH();
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(sent.length > n);
    sent.forEach(([a, s, d]) => check(a, s, d));
});

test('an engine unit that answers only service 01 still gives readiness', async () => {
    // the demo car turned around: 01 answered, 22 F4xx refused
    const only01 = (a, s, d) => {
        if (s === 0x22 && d[0] === 0xF4) return [0x7F, 0x22, 0x31];
        if (s === 0x01 && a === 0x12) { const r = DEMO.reply(a, 0x22, [0xF4, d[0]]); return r[0] === 0x62 ? [0x41].concat(r.slice(2)) : [0x7F, 0x01, 0x12]; }
        return DEMO.reply(a, s, d);
    };
    const sent = [], app = await runApp('off', sent, only01);
    await new Promise((r) => setTimeout(r, 5000));
    sent.forEach(([a, s, d]) => check(a, s, d));
    assert.ok(sent.filter(([a, s, d]) => a === 0x12 && s === 0x01 && d[0] === 0x01).length >= 1, 'readiness by 01 01');
    await app.shot('x');
    assert.ok(/monitors complete/.test(app.texts()), 'readiness shown');
});

test('no readiness answer: faults are still read, and the refusal is shown', async () => {
    const none = (a, s, d) => (s === 0x01 || (s === 0x22 && d[0] === 0xF4) ? (a === 0x12 ? [0x7F, s, 0x11] : null) : DEMO.reply(a, s, d));
    const sent = [], app = await runApp('off', sent, none);
    await new Promise((r) => setTimeout(r, 6000));
    sent.forEach(([a, s, d]) => check(a, s, d));
    assert.ok(sent.some(([a, s, d]) => a === 0x12 && s === 0x19 && d[0] === 0x02), 'read BMW fault memory without readiness');
    await app.shot('x');
    assert.ok(/service not supported/.test(app.texts()), 'refusal shown');
    app.tab(1); await app.shot('x');
    assert.ok(/190302/.test(app.texts()), 'BMW fault shown');
});

(async () => {
    for (const [name, fn] of tests) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
    }
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
})();
