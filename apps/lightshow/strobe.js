'use strict';
/**
 * strobe.js - real-time light control via UDS 0x2F (InputOutputControlByIdentifier).
 *
 * G01 X3 BDC light output DIDs. The sequencer fires IOControl commands to toggle
 * individual circuits on/off in timed patterns.
 *
 * 0x2F request:  2F [DID_H] [DID_L] [controlParam] [value?]
 *   controlParam 0x03 = shortTermAdjustment (value 0x01 on, 0x00 off)
 *   controlParam 0x00 = returnControlToECU (no value)
 * Positive response: 6F [DID_H] [DID_L] [controlParam]
 */

const ECU_BDC = 0x40;

const LIGHTS = [
    { id: 'low_l',    name: 'Low Beam L',    did: '60FD', ecu: ECU_BDC, side: 'left' },
    { id: 'low_r',    name: 'Low Beam R',    did: '60FE', ecu: ECU_BDC, side: 'right' },
    { id: 'high_l',   name: 'High Beam L',   did: '60FF', ecu: ECU_BDC, side: 'left' },
    { id: 'high_r',   name: 'High Beam R',   did: '6100', ecu: ECU_BDC, side: 'right' },
    { id: 'drl_l',    name: 'DRL L',         did: '6101', ecu: ECU_BDC, side: 'left' },
    { id: 'drl_r',    name: 'DRL R',         did: '6102', ecu: ECU_BDC, side: 'right' },
    { id: 'fog_l',    name: 'Fog L',         did: '6103', ecu: ECU_BDC, side: 'left' },
    { id: 'fog_r',    name: 'Fog R',         did: '6104', ecu: ECU_BDC, side: 'right' },
    { id: 'turn_l',   name: 'Turn Sig L',    did: '6105', ecu: ECU_BDC, side: 'left' },
    { id: 'turn_r',   name: 'Turn Sig R',    did: '6106', ecu: ECU_BDC, side: 'right' },
    { id: 'tail_l',   name: 'Tail L',        did: '6107', ecu: ECU_BDC, side: 'left' },
    { id: 'tail_r',   name: 'Tail R',        did: '6108', ecu: ECU_BDC, side: 'right' },
    { id: 'plate',    name: 'License Plate',  did: '6109', ecu: ECU_BDC, side: 'center' },
    { id: 'rear_fog', name: 'Rear Fog',      did: '610A', ecu: ECU_BDC, side: 'center' },
];

const byId = {};
LIGHTS.forEach(function (l) { byId[l.id] = l; });

const LEFT  = LIGHTS.filter(function (l) { return l.side === 'left'; }).map(function (l) { return l.id; });
const RIGHT = LIGHTS.filter(function (l) { return l.side === 'right'; }).map(function (l) { return l.id; });
const FRONT = ['low_l', 'low_r', 'high_l', 'high_r', 'drl_l', 'drl_r', 'fog_l', 'fog_r'];
const REAR  = ['tail_l', 'tail_r', 'plate', 'rear_fog'];
const ALL   = LIGHTS.map(function (l) { return l.id; });

/**
 * Patterns: array of steps. Each step = { on: [ids], ms: duration }.
 * Lights not in `on` are turned off for that step. Pattern loops until stopped.
 * `speed` is the base ms per step (user can scale it).
 */
const PATTERNS = [
    {
        id: 'wig_wag',
        name: 'Wig-Wag',
        description: 'Tow truck / safety car: left-right, up-down, inner-outer',
        speed: 100,
        steps: [
            // left-right alternating (front + rear)
            { on: ['low_l', 'high_l', 'drl_l', 'fog_l', 'tail_l', 'turn_l'] },
            { on: ['low_r', 'high_r', 'drl_r', 'fog_r', 'tail_r', 'turn_r'] },
            // up-down alternating
            { on: ['high_l', 'high_r', 'drl_l', 'drl_r', 'plate'] },
            { on: ['low_l', 'low_r', 'fog_l', 'fog_r', 'tail_l', 'tail_r', 'rear_fog'] },
            // inner-outer alternating
            { on: ['drl_l', 'drl_r', 'fog_l', 'fog_r', 'plate', 'rear_fog'] },
            { on: ['high_l', 'high_r', 'low_l', 'low_r', 'tail_l', 'tail_r', 'turn_l', 'turn_r'] },
            // rapid left-right double flash
            { on: ['low_l', 'high_l', 'drl_l', 'fog_l', 'tail_l', 'turn_l'] },
            { on: [] },
            { on: ['low_l', 'high_l', 'drl_l', 'fog_l', 'tail_l', 'turn_l'] },
            { on: [] },
            { on: ['low_r', 'high_r', 'drl_r', 'fog_r', 'tail_r', 'turn_r'] },
            { on: [] },
            { on: ['low_r', 'high_r', 'drl_r', 'fog_r', 'tail_r', 'turn_r'] },
            { on: [] },
        ],
    },
    {
        id: 'dual_flash',
        name: 'Dual Flash',
        description: 'All lights flash on and off together',
        speed: 200,
        steps: [
            { on: ALL.slice() },
            { on: [] },
        ],
    },
    {
        id: 'drl_alternate',
        name: 'DRL Alternate',
        description: 'DRLs alternate left and right',
        speed: 180,
        steps: [
            { on: ['drl_l'] },
            { on: ['drl_r'] },
        ],
    },
    {
        id: 'front_rear',
        name: 'Front / Rear',
        description: 'Front lights then rear lights',
        speed: 250,
        steps: [
            { on: FRONT.slice() },
            { on: REAR.slice() },
        ],
    },
    {
        id: 'sequential',
        name: 'Sequential',
        description: 'Lights sweep left to right then right to left',
        speed: 120,
        steps: [
            { on: ['low_l', 'drl_l', 'fog_l', 'tail_l'] },
            { on: ['low_l', 'drl_l', 'low_r', 'drl_r'] },
            { on: ['low_r', 'drl_r', 'fog_r', 'tail_r'] },
            { on: ['low_r', 'drl_r', 'low_l', 'drl_l'] },
        ],
    },
    {
        id: 'strobe_front',
        name: 'Strobe Front',
        description: 'Rapid high beam strobe',
        speed: 80,
        steps: [
            { on: ['high_l', 'high_r'] },
            { on: [] },
        ],
    },
    {
        id: 'police',
        name: 'Red & Blue',
        description: 'Alternating left-right rapid flash',
        speed: 100,
        steps: [
            { on: ['low_l', 'high_l', 'drl_l', 'turn_l'] },
            { on: [] },
            { on: ['low_r', 'high_r', 'drl_r', 'turn_r'] },
            { on: [] },
        ],
    },
    {
        id: 'random',
        name: 'Random',
        description: 'Random lights at random intervals',
        speed: 160,
        steps: null, // generated at runtime
    },
];

function randomStep() {
    var on = [];
    for (var i = 0; i < ALL.length; i++) {
        if (Math.random() > 0.5) on.push(ALL[i]);
    }
    return { on: on };
}

/**
 * Sequencer: runs a pattern by sending 0x2F IOControl commands through the link.
 */
class Sequencer {
    constructor(link, log) {
        this.link = link;
        this.log = log;
        this.running = false;
        this.pattern = null;
        this.speedScale = 1.0;
        this.step = 0;
        this._timer = null;
        this._controlled = {}; // id -> true for lights we took control of
        this.onStep = null; // callback(stepIndex, onIds)
    }

    async start(pattern, speedScale) {
        if (this.running) await this.stop();
        this.pattern = pattern;
        this.speedScale = speedScale || 1.0;
        this.step = 0;
        this.running = true;
        this.log.info('strobe start: ' + pattern.name);
        this._run();
    }

    async stop() {
        this.running = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        await this._restoreAll();
        this.pattern = null;
        this.step = 0;
        this.log.info('strobe stop');
    }

    _run() {
        if (!this.running || !this.pattern) return;
        var self = this;
        var p = this.pattern;
        var steps = p.steps || [randomStep()];
        var s = p.id === 'random' ? randomStep() : steps[this.step % steps.length];
        var ms = Math.round((p.speed || 150) * this.speedScale);

        this._applyStep(s).then(function () {
            if (!self.running) return;
            if (self.onStep) self.onStep(self.step, s.on);
            self.step++;
            self._timer = setTimeout(function () { self._run(); }, ms);
        }).catch(function (e) {
            self.log.warn('strobe step error: ' + e);
            if (self.running) {
                self._timer = setTimeout(function () { self._run(); }, ms);
            }
        });
    }

    async _applyStep(s) {
        var onSet = {};
        for (var i = 0; i < (s.on || []).length; i++) onSet[s.on[i]] = true;
        for (var j = 0; j < ALL.length; j++) {
            var id = ALL[j];
            var light = byId[id];
            if (!light) continue;
            if (onSet[id]) {
                await this.link.ioControl(light.ecu, light.did, true);
                this._controlled[id] = true;
            } else if (this._controlled[id]) {
                await this.link.ioControl(light.ecu, light.did, false);
            }
        }
    }

    async _restoreAll() {
        var ids = Object.keys(this._controlled);
        for (var i = 0; i < ids.length; i++) {
            var light = byId[ids[i]];
            if (light) {
                await this.link.ioRestore(light.ecu, light.did);
            }
        }
        this._controlled = {};
    }
}

module.exports = { LIGHTS, PATTERNS, Sequencer, byId, LEFT, RIGHT, FRONT, REAR, ALL, ECU_BDC };
