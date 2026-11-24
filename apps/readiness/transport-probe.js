'use strict';
/**
 * transport-probe.js — detect and test alternate diagnostic transports from the MGU.
 *
 * The DME (0x12) refuses OBD-II readiness requests over TASU because sourceAddress 0xF2
 * identifies the head unit. MHD reads readiness over the OBD port directly on CAN with
 * standard scan-tool addressing (0x7DF / 0x7E0), which the DME treats as an external tool.
 *
 * This module probes whether the MGU has access to:
 *   1. SocketCAN interfaces (can0, vcan0, etc.) — raw CAN bus access
 *   2. DoIP gateway (port 13400 on the vehicle Ethernet) — Diagnostics over IP
 *   3. TASU with alternate source addresses (0xF1 = standard external tester)
 *
 * Every request is a harmless read: OBD-II mode 01 PID 00 (supported PIDs bitmap),
 * which every OBD-II-compliant ECU must answer, changes nothing, and has no side effects.
 */
const { exec, execSync } = require('child_process');
const net = require('net');
const dgram = require('dgram');

const TARGETS = { 0x12: 'Engine (DME)' };
const OBD_FUNC = 0x7DF;
const DME_REQ  = 0x7E0;
const DME_RESP = 0x7E8;

const h2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const h3 = (n) => n.toString(16).toUpperCase().padStart(3, '0');
const hx = (buf) => Array.from(buf).map((b) => h2(b)).join(' ');

function run(cmd, timeout) {
    return new Promise((resolve) => {
        exec(cmd, { timeout: timeout || 5000 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), code: err && err.code });
        });
    });
}

function runSync(cmd) {
    try { return execSync(cmd, { timeout: 3000 }).toString().trim(); } catch (e) { return null; }
}

/**
 * Detect SocketCAN interfaces. Returns [{ name, state, type }].
 */
async function detectCan() {
    const out = [];

    // method 1: ip link show type can
    const r1 = await run('ip link show type can 2>/dev/null');
    if (r1.ok && r1.stdout) {
        const re = /^\d+:\s+(\S+):/gm;
        let m;
        while ((m = re.exec(r1.stdout)) !== null) {
            const state = r1.stdout.includes(m[1] + ':') && r1.stdout.includes('UP') ? 'UP' : 'DOWN';
            out.push({ name: m[1], state, type: 'can' });
        }
    }

    // method 2: look for /sys/class/net/can*
    const r2 = await run('ls -1 /sys/class/net/ 2>/dev/null | grep -E "^(can|vcan)"');
    if (r2.ok && r2.stdout) {
        r2.stdout.split('\n').filter(Boolean).forEach((name) => {
            if (!out.find((o) => o.name === name)) {
                const operstate = runSync('cat /sys/class/net/' + name + '/operstate 2>/dev/null');
                out.push({ name, state: operstate || '?', type: 'sys' });
            }
        });
    }

    // method 3: check if can-utils are installed
    const hasUtils = await run('which cansend 2>/dev/null');

    return { interfaces: out, canUtils: hasUtils.ok };
}

/**
 * Try sending an OBD-II request over raw SocketCAN using cansend + candump.
 * Request: CAN ID 0x7DF, data [02 01 00 00 00 00 00 00] (mode 01, PID 00)
 * Expected response on 0x7E8: [06 41 00 xx xx xx xx 00]
 */
async function testCanObd(iface) {
    // bring up the interface if it's down
    await run('ip link set ' + iface + ' up 2>/dev/null');

    // start candump in background, listening for the DME response
    const dumpCmd = 'timeout 3 candump ' + iface + ',7E8:7FF -n 1 2>/dev/null';
    const sendCmd = 'cansend ' + iface + ' 7DF#0201000000000000 2>/dev/null';

    // run them: start dump first, then send
    const dumpP = run(dumpCmd, 5000);
    await new Promise((r) => setTimeout(r, 200));
    const sendR = await run(sendCmd, 3000);
    const dumpR = await dumpP;

    if (!sendR.ok) return { ok: false, error: 'cansend failed: ' + (sendR.stderr || sendR.code), raw: null };

    if (dumpR.stdout && dumpR.stdout.includes('7E8')) {
        // parse response bytes
        const match = dumpR.stdout.match(/\[(\d+)\]\s+([\dA-Fa-f\s]+)/);
        const bytes = match ? match[2].trim() : dumpR.stdout;
        return { ok: true, error: null, raw: bytes, response: dumpR.stdout };
    }

    return { ok: false, error: 'no response on CAN ID 0x7E8 within 3s', raw: null };
}

/**
 * Check if a DoIP gateway is reachable on the vehicle Ethernet.
 * DoIP uses TCP port 13400. We also check UDP 13400 for vehicle identification.
 */
async function detectDoip() {
    const hosts = [];

    // find candidate IPs: local interfaces in 169.254.x.x range, or anything on eth/enp
    const r = await run("ip -4 addr show 2>/dev/null | grep -oP '\\d+\\.\\d+\\.\\d+\\.\\d+' | grep -v 127.0.0");
    const localIps = r.ok ? r.stdout.split('\n').filter(Boolean) : [];

    // check ARP table for potential gateways
    const arp = await run('ip neigh show 2>/dev/null');
    const neighbors = [];
    if (arp.ok && arp.stdout) {
        const re = /^(\d+\.\d+\.\d+\.\d+)\s/gm;
        let m;
        while ((m = re.exec(arp.stdout)) !== null) neighbors.push(m[1]);
    }

    // try connecting to DoIP port on each neighbor and common BMW addresses
    const candidates = [...new Set([...neighbors, '169.254.0.1', '169.254.1.1'])];
    for (const ip of candidates.slice(0, 5)) {
        const reachable = await testTcpPort(ip, 13400, 2000);
        if (reachable) hosts.push(ip);
    }

    return { hosts, localIps, neighbors };
}

function testTcpPort(host, port, timeout) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        s.setTimeout(timeout);
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('timeout', () => { s.destroy(); resolve(false); });
        s.on('error', () => { s.destroy(); resolve(false); });
        s.connect(port, host);
    });
}

/**
 * Send a DoIP diagnostic request (OBD-II mode 01 PID 00) to the DME.
 *
 * DoIP framing (ISO 13400-2):
 *   Header: version (02), inverse (FD), type (0x8001 = diagnostic message), length
 *   Payload: source address (2 bytes), target address (2 bytes), UDS data
 *
 * We use source address 0x0EF1 (standard external tester in BMW DoIP)
 * and target 0x0012 (DME).
 */
async function testDoipObd(host) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(4000);

        const srcAddr = 0x0EF1;   // external tester
        const tgtAddr = 0x0012;   // DME

        // routing activation first (type 0x0005)
        const activate = Buffer.alloc(15);
        activate[0] = 0x02; activate[1] = 0xFD;             // version
        activate.writeUInt16BE(0x0005, 2);                   // routing activation request
        activate.writeUInt32BE(7, 4);                        // payload length
        activate.writeUInt16BE(srcAddr, 8);                  // source address
        activate[10] = 0x00;                                 // activation type (default)
        activate.writeUInt32BE(0x00000000, 11);              // reserved

        // diagnostic message (type 0x8001): OBD-II 01 00
        const uds = Buffer.from([0x01, 0x00]);              // mode 01 PID 00
        const diag = Buffer.alloc(8 + 4 + uds.length);
        diag[0] = 0x02; diag[1] = 0xFD;
        diag.writeUInt16BE(0x8001, 2);
        diag.writeUInt32BE(4 + uds.length, 4);
        diag.writeUInt16BE(srcAddr, 8);
        diag.writeUInt16BE(tgtAddr, 10);
        uds.copy(diag, 12);

        let buf = Buffer.alloc(0), activated = false, done = false;

        const finish = (result) => {
            if (done) return;
            done = true;
            sock.destroy();
            resolve(result);
        };

        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            // parse DoIP frames
            while (buf.length >= 8) {
                const plen = buf.readUInt32BE(4);
                if (buf.length < 8 + plen) break;
                const type = buf.readUInt16BE(2);
                const payload = buf.slice(8, 8 + plen);
                buf = buf.slice(8 + plen);

                if (type === 0x0006 && !activated) {
                    // routing activation response
                    activated = true;
                    sock.write(diag);
                } else if (type === 0x8001 && payload.length >= 5) {
                    // diagnostic message response
                    const respUds = payload.slice(4);
                    if (respUds[0] === 0x41 && respUds[1] === 0x00) {
                        finish({ ok: true, error: null, raw: hx(respUds), source: 'doip', srcAddr: h2(srcAddr >> 8) + h2(srcAddr & 0xFF) });
                    } else if (respUds[0] === 0x7F) {
                        finish({ ok: false, error: 'NRC ' + h2(respUds[2]), raw: hx(respUds), source: 'doip' });
                    }
                } else if (type === 0x8003) {
                    // negative acknowledge
                    finish({ ok: false, error: 'DoIP NACK code ' + (payload.length ? h2(payload[0]) : '?'), raw: null, source: 'doip' });
                }
            }
        });

        sock.on('timeout', () => finish({ ok: false, error: 'timeout (4s)', raw: null, source: 'doip' }));
        sock.on('error', (e) => finish({ ok: false, error: e.message, raw: null, source: 'doip' }));

        sock.connect(13400, host, () => {
            sock.write(activate);
        });
    });
}

/**
 * Try TASU with an alternate source address. The standard TASU interface hardcodes 0xF2,
 * but we test whether the SOME/IP call accepts a different sourceAddress field value.
 *
 * This reuses the app's existing signals proxy — it doesn't open a new transport.
 */
async function testTasuAltSource(signals, proxy, sourceAddr, targetAddr, log) {
    if (!proxy) return { ok: false, error: 'no TASU proxy', raw: null, source: 'tasu-alt' };

    const udsData = Buffer.from([0x00]);   // PID 00 (after service ID)
    const sid = 0x01;                      // OBD-II mode 01

    return new Promise((resolve) => {
        let done = false, timer, onResp;
        const finish = (r) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (onResp) signals.removeListener && signals.removeListener(proxy, 'sendTasuResponse', onResp);
            resolve(r);
        };

        // listen for response
        const frames = [];
        onResp = (v) => {
            if (done) return;
            const toBytes = (b) => {
                if (!b) return [];
                if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Array.from(b);
                if (Array.isArray(b)) return b.slice();
                if (b.data) return toBytes(b.data);
                return [];
            };
            const b = toBytes(v && (v.udsResponse !== undefined ? v.udsResponse : v));
            if (b.length < 10) return;
            if (b[2] === 0x7F) {
                finish({ ok: false, error: 'transport reject code ' + h2(b[4]), raw: hx(b), source: 'tasu-0x' + h2(sourceAddr) });
                return;
            }
            const ecu = b[6], uds = b.slice(9);
            if (ecu === targetAddr && uds[0] === 0x41 && uds[1] === 0x00) {
                finish({ ok: true, error: null, raw: hx(uds), source: 'tasu-0x' + h2(sourceAddr), ecuReply: h2(ecu) });
            } else if (ecu === targetAddr && uds[0] === 0x7F) {
                const nrc = { 0x11: 'not supported', 0x12: 'not supported', 0x31: 'not available', 0x7E: 'wrong session', 0x7F: 'wrong session' };
                finish({ ok: false, error: nrc[uds[2]] || 'NRC ' + h2(uds[2]), raw: hx(uds), source: 'tasu-0x' + h2(sourceAddr) });
            }
        };

        timer = setTimeout(() => finish({ ok: false, error: 'no reply (4s)', raw: null, source: 'tasu-0x' + h2(sourceAddr) }), 4000);

        // subscribe to responses, then send
        signals.on(proxy, 'sendTasuResponse', onResp, log).then(() => {
            return signals.call(proxy, 'sendTasuRequest', {
                sourceAddress: sourceAddr,
                targetAddress: targetAddr,
                serviceID: sid,
                subroutineID: 0,
                udsDataLength: udsData.length,
                udsData: udsData,
                deadlockTime: 0,
            }, 6000);
        }).then((r) => {
            const v = r && typeof r === 'object' ? (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
            const verdict = v === undefined ? 'NO_ERROR' : String(v);
            if (/REJECTED|NOT_ACCEPTED|INVALID/i.test(verdict)) {
                finish({ ok: false, error: 'transport refused: ' + verdict, raw: null, source: 'tasu-0x' + h2(sourceAddr) });
            }
            // else wait for the frame listener
        }).catch((e) => {
            finish({ ok: false, error: String(e), raw: null, source: 'tasu-0x' + h2(sourceAddr) });
        });
    });
}

/**
 * Run the full transport probe. Returns { results: [...], summary }.
 * Each result: { test, ok, detail, error, raw }.
 */
async function probe(signals, log, opts) {
    const results = [];
    const add = (test, ok, detail, error, raw) => {
        results.push({ test, ok, detail: detail || '', error: error || '', raw: raw || '' });
        if (opts && opts.onStep) opts.onStep(test, results.length);
    };

    // 1. SocketCAN detection
    if (opts && opts.onStep) opts.onStep('Detecting CAN interfaces...', 0);
    const can = await detectCan();
    if (can.interfaces.length) {
        can.interfaces.forEach((i) => add('CAN: ' + i.name, true, 'state: ' + i.state, '', ''));
    } else {
        add('CAN interfaces', false, 'none found', 'No SocketCAN interfaces on this head unit', '');
    }
    add('can-utils installed', can.canUtils, can.canUtils ? 'cansend available' : 'not found', '', '');

    // 2. Test CAN OBD if any interface is available
    if (can.interfaces.length && can.canUtils) {
        for (const iface of can.interfaces) {
            if (opts && opts.onStep) opts.onStep('Testing CAN on ' + iface.name + '...', results.length);
            const r = await testCanObd(iface.name);
            add('CAN OBD on ' + iface.name, r.ok, r.ok ? 'DME replied: ' + r.raw : 'no response', r.error, r.raw);
        }
    }

    // 3. DoIP detection
    if (opts && opts.onStep) opts.onStep('Detecting DoIP...', results.length);
    const doip = await detectDoip();
    if (doip.hosts.length) {
        doip.hosts.forEach((h) => add('DoIP gateway', true, h + ':13400 reachable', '', ''));
    } else {
        add('DoIP gateway', false, 'port 13400 not found on neighbors', 'Tried: ' + (doip.neighbors.length ? doip.neighbors.slice(0, 3).join(', ') : 'no neighbors'), '');
    }

    // 4. Test DoIP OBD if a gateway was found
    for (const host of doip.hosts) {
        if (opts && opts.onStep) opts.onStep('Testing DoIP on ' + host + '...', results.length);
        const r = await testDoipObd(host);
        add('DoIP OBD via ' + host, r.ok, r.ok ? 'DME replied: ' + r.raw : 'no positive reply', r.error, r.raw);
    }

    // 5. TASU with alternate source addresses
    // get the SOME/IP proxy if the app has one
    let proxy = null;
    try {
        const IFACE = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
        const INSTANCE = 'SystemFunctionsInternalTasuInst1';
        proxy = await signals.proxy(IFACE, INSTANCE);
    } catch (e) { /* no proxy */ }

    const altSources = [
        [0xF1, 'standard external tester (like a scan tool)'],
        [0xF0, 'programming tester'],
        [0xF4, 'OBD tester address'],
    ];

    for (const [src, desc] of altSources) {
        if (opts && opts.onStep) opts.onStep('TASU source 0x' + h2(src) + '...', results.length);
        const r = await testTasuAltSource(signals, proxy, src, 0x12, log);
        add('TASU 0x' + h2(src) + ' (' + desc + ')', r.ok,
            r.ok ? 'DME replied: ' + r.raw : (r.error || 'no reply'),
            r.ok ? '' : r.error,
            r.raw);
    }

    // 6. Check the normal TASU path for comparison
    if (opts && opts.onStep) opts.onStep('TASU normal (0xF2)...', results.length);
    const normal = await testTasuAltSource(signals, proxy, 0xF2, 0x12, log);
    add('TASU 0xF2 (head unit — baseline)', normal.ok,
        normal.ok ? 'DME replied: ' + normal.raw : (normal.error || 'no reply'),
        normal.ok ? '' : normal.error,
        normal.raw);

    // summary
    const working = results.filter((r) => r.ok && r.test.includes('OBD')).map((r) => r.test);
    const altWorking = results.filter((r) => r.ok && r.test.startsWith('TASU 0x') && !r.test.includes('0xF2')).map((r) => r.test);
    let summary;
    if (working.length) summary = 'Direct diagnostic access confirmed: ' + working.join(', ');
    else if (altWorking.length) summary = 'Alternate TASU source works: ' + altWorking.join(', ');
    else summary = 'No alternate transport found — only standard TASU (0xF2) available';

    return { results, summary };
}

module.exports = { probe, detectCan, detectDoip, testCanObd, testDoipObd, testTasuAltSource };
