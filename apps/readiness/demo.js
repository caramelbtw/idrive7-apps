'use strict';
/**
 * Demo car (shown with a DEMO badge): a petrol engine unit at 0x12 a few days after its faults were cleared, with
 * secondary air but no heated catalyst, A/C monitor or EGR. Misfire, fuel system, components and the O2 heater are
 * complete; the oxygen sensor completes 40 s after the app opened, the catalyst at 90 s; the evaporative system stays
 * incomplete. Its BMW fault memory (19 02) has a pending tank-leak fault (190302) and a stored ignition coil fault
 * (154201); like most BMWs it reports no generic P-codes (03 / 07 / 0A answer empty). It identifies as a B58 engine
 * unit (DME8FF_R) and a ZF gearbox. No second engine unit; the gearbox has no faults.
 */
const T0 = Date.now();
const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];

// supported-PID maps: 00 -> 01 20 ; 20 -> 30 31 40 ; 40 -> 41 4E (bit 1 = PID base + 1)
function bits(base, pids) {
    const out = [0, 0, 0, 0];
    pids.forEach((p) => { const i = p - base - 1; out[i >> 3] |= 0x80 >> (i & 7); });
    return out;
}

function reply(addr, sid, data) {
    const s = (Date.now() - T0) / 1000;
    const index = { 0x12: [0x0F, 0x26, 0xE8], 0x18: [0x0F, 0x14, 0xB8] }[addr];
    if (sid === 0x22 && index && data[0] === 0xF1) return [0x62, 0xF1, 0x50].concat(index);
    if (sid === 0x19 && index) {
        // 59 02 <availability mask> then <3-byte code> <status> each
        const out = [0x59, 0x02, 0xFF];
        if (addr === 0x12) out.push(0x19, 0x03, 0x02, 0x04, 0x15, 0x42, 0x01, 0x08);
        return out;
    }
    if (addr === 0x18) return sid === 0x01 || sid === 0x22 ? [0x7F, sid, sid === 0x22 ? 0x31 : 0x11] : [sid + 0x40, 0x00];
    if (addr !== 0x12) return null;
    // as most BMW engine units over this link: OBD data only as UDS identifiers 22 F4 <PID>, service 01 refused
    if (sid === 0x01) return [0x7F, 0x01, 0x11];
    if (sid === 0x22 && data[0] === 0xF4) {
        const pid = data[1], head = [0x62, 0xF4, pid];
        // B: misfire, fuel, components monitored and complete; C: catalyst, evap, secondary air, O2, O2 heater
        let D = 0x04;                                  // evap incomplete
        if (s < 90) D |= 0x01;                         // catalyst
        if (s < 40) D |= 0x20;                         // oxygen sensor
        if (pid === 0x00) return head.concat(bits(0x00, [0x01, 0x20]));
        if (pid === 0x20) return head.concat(bits(0x20, [0x30, 0x31, 0x40]));
        if (pid === 0x40) return head.concat(bits(0x40, [0x41, 0x4E]));
        if (pid === 0x01) return head.concat([0x00, 0x07, 0x6D, D]);
        if (pid === 0x41) return head.concat([0x00, 0x07, 0x6D, D | 0x08]);       // this drive: secondary air not yet
        if (pid === 0x30) return head.concat([9]);
        if (pid === 0x31) return head.concat(be16(186 + Math.floor(s / 60)));
        if (pid === 0x4E) return head.concat(be16(412 + Math.floor(s / 60)));
        return [0x7F, 0x22, 0x31];
    }
    if (sid === 0x03 || sid === 0x07 || sid === 0x0A) return [sid + 0x40, 0x00];
    return null;
}

module.exports = { reply };
