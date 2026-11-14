#!/usr/bin/env python3
"""readiness_texts.py - the BMW fault texts Readiness needs, taken from Fault Scanner's database.

    python3 kit/tools/readiness_texts.py [dtc_db.pack]   # Fault Scanner's database -> apps/readiness/bmw_dtc.pack

Fault Scanner isn't in this repository: pass the path of apps/dtc_scanner/dtc_db.pack from a checkout of
https://github.com/cauliflowermossgrape/idrive7-apps (default: that path here, if you've copied it in).

Readiness reads BMW's own fault memory (UDS 19 02) of the engine unit(s) (0x12, 0x13) and the gearbox (0x18).
Their codes are BMW hex codes (140300, 1F2501 ...), not P-codes, and only a text database names them. This keeps
the part of Fault Scanner's committed database that covers those three addresses:

    sgbd_index.json              "<address> <SGBD index>" -> unit type, for 12 / 13 / 18 only
    tables/addr/<12|13|18>.json  the text every unit type at that address agrees on
    tables/variant/<type>.json   the text of exactly that engine / gearbox type

The result is a committed pack like dtc_db.pack (build.py ships a .pack in the app folder as it is).
Run it again after Fault Scanner's database is updated.
"""
import json, os, shutil, struct, sys, tempfile, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pack_data  # noqa: E402

SRC = os.path.join(ROOT, 'apps', 'dtc_scanner', 'dtc_db.pack')
OUT = os.path.join(ROOT, 'apps', 'readiness', 'bmw_dtc.pack')
ADDRS = ('12', '13', '18')


def read_pack(path):
    data = open(path, 'rb').read()
    if data[:8] != pack_data.MAGIC:
        sys.exit(path + ': not a data pack')
    ilen = struct.unpack('<I', data[8:12])[0]
    index = json.loads(zlib.decompress(data[12:12 + ilen], -15))
    base = 12 + ilen

    def part(name):
        off, ln = index['files'][name]
        return json.loads(zlib.decompress(data[base + off:base + off + ln], -15))

    def whole(rel):
        if rel in index['split']:
            out = {}
            for n in index['files']:
                if n.startswith(rel + '#'):
                    out.update(part(n))
            return out
        return part(rel) if rel in index['files'] else None

    return whole


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC
    if not os.path.exists(src):
        sys.exit('missing ' + src + ' (pass the path of Fault Scanner's dtc_db.pack from the upstream repository)')
    get = read_pack(src)
    index = {k: v for k, v in (get('sgbd_index.json') or {}).items() if k.split(' ')[0] in ADDRS}
    tmp = tempfile.mkdtemp()
    try:
        def put(rel, obj):
            p = os.path.join(tmp, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'w', encoding='utf-8') as f:
                json.dump(obj, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
        put('sgbd_index.json', index)
        codes = 0
        for a in ADDRS:
            t = get('tables/addr/%s.json' % a)
            if t:
                put('tables/addr/%s.json' % a, t)
                codes += len(t)
        types = sorted(set(index.values()))
        kept = []
        for v in types:
            t = get('tables/variant/%s.json' % v.lower())
            if t:
                put('tables/variant/%s.json' % v.lower(), t)
                kept.append(v)
        raw, size, n = pack_data.pack(tmp, OUT)
        print('%d address texts, %d unit types (%s)' % (codes, len(kept), ' '.join(kept)))
        print('%s: %.2f MB (%.1f MB of JSON)' % (os.path.relpath(OUT, ROOT), size / 1e6, raw / 1e6))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
