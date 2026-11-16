"""Extract shipped assets without executing an application."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import struct

MODS = ['agents', 'spaces', 'picker', 'pane', 'tabs', 'menu', 'new-menu', 'workspace-chrome', 'toast']
EXPECTED_KEYS = {
    '0.1.13': '44b35780fd8ba14d77513d85d0e45aa8f4c14d085b637232bae790f95e3097e1',
    '0.1.16': '2af9b871fee0eea3419be2d619be8e5c10f42a343bbe1c76c5c2f83ef88106ee',
}
EXPECTED = {
    '0.1.13': ['27d9dd06fea9562f62f0924922aafcadd64623391cb1ada4d47d754e91b0f44b', '1e949e399644aeb0e88c73a0dbefe651f3a80dc092cd2d99b3244c2d8b036db0', '6dfde109b9321e8bc7f0e081db964960195748915eb7ff73e75688dd853b6dc3', '30df4c9b774414ca184b16f76c97c84f3cebd2ee411bea45c5c25b9d0ac65899'],
    '0.1.16': ['3ef714bbf187f81c4fbb91949f4fa2b92f0dceda2c52c9bc01eabec5f3d7e0c4', '8f7111eb3a7c055bb04bd81b88f90b581e4d4a85f512eb87d3f5d15f1073f8bd', 'd016a63eb7263ad4478152caa6521b218501bcc3539b7c42e13cfca1806b05c2', '9bb9028df04281ad886165ec0eb9fc0a8ac6efadf39abc4d6aa0afd1370879c7'],
}


def embedded_assets(binary, names=None):
    if binary[:4] != bytes.fromhex('cffaedfe'):
        raise ValueError('expected a little-endian 64-bit Mach-O executable')
    commands = struct.unpack_from('<I', binary, 16)[0]
    offset = 32
    segments = []
    for _ in range(commands):
        command, size = struct.unpack_from('<II', binary, offset)
        if command == 0x19:
            vm, _, file_offset, file_size = struct.unpack_from('<QQQQ', binary, offset + 24)
            if file_size:
                segments.append((vm, file_offset, file_size))
        offset += size

    def file_address(address, size):
        for vm, file_offset, file_size in segments:
            if vm <= address and address + size <= vm + file_size:
                return file_offset + address - vm
        raise ValueError('asset pointer outside a file-backed segment')

    assets = {}
    if names is None:
        names = set(re.findall(rb'(?:' + b'|'.join(x.encode() for x in MODS) + rb')/[a-zA-Z0-9_.-]+\.(?:json|js|svg)', binary))
    for name in sorted(names):
        start = 0
        candidates = set()
        while (index := binary.find(name, start)) >= 0:
            start = index + 1
            for vm, file_offset, file_size in segments:
                if file_offset <= index < file_offset + file_size:
                    key = struct.pack('<QQ', vm + index - file_offset, len(name))
                    cursor = 0
                    while (pointer := binary.find(key, cursor)) >= 0:
                        cursor = pointer + 1
                        address, size = struct.unpack_from('<QQ', binary, pointer + 16)
                        try:
                            begin = file_address(address, size)
                            payload = binary[begin:begin + size]
                            payload.decode('utf-8')
                            if payload and payload[:1] not in b'\x00':
                                candidates.add(payload)
                        except (ValueError, UnicodeDecodeError):
                            pass
        if len(candidates) != 1:
            raise ValueError(f'ambiguous or missing embedded asset {name!r}')
        assets[name.decode()] = candidates.pop()
    return assets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    version = plistlib.loads((args.bundle / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']
    if version not in EXPECTED:
        raise ValueError('unsupported source release')
    binary = (args.bundle / 'Contents/MacOS/Herdr').read_bytes()
    assets = embedded_assets(binary)
    for mod, expected in zip(MODS, EXPECTED[version]):
        if hashlib.sha256(assets[mod + '/main.js']).hexdigest() != expected:
            raise ValueError(f'changed source {mod}')
    hashes = {}
    for name, payload in assets.items():
        target = args.output / 'mods' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        hashes['mods/' + name] = hashlib.sha256(payload).hexdigest()
    marker = b'main{\n  "id": "root"'
    if binary.count(marker) != 1:
        raise ValueError('ambiguous default main layout')
    start = binary.index(marker) + len(b'main')
    text = binary[start:start + 65536].decode('utf-8', errors='ignore')
    _, end = json.JSONDecoder().raw_decode(text)
    layout = text[:end].encode('utf-8')
    if binary[start:start + len(layout)] != layout:
        raise ValueError('default layout bytes changed during decoding')
    key_marker = b'{\n  "global": {\n    "cmd-q": "app.quit"'
    key_maps = set()
    for match in re.finditer(re.escape(key_marker), binary):
        key_start = match.start()
        key_text = binary[key_start:key_start + 65536].decode('utf-8', errors='ignore')
        _, key_end = json.JSONDecoder().raw_decode(key_text)
        candidate = key_text[:key_end].encode('utf-8')
        if binary[key_start:key_start + len(candidate)] != candidate:
            raise ValueError('default key bytes changed during decoding')
        if hashlib.sha256(candidate).hexdigest() == EXPECTED_KEYS[version]:
            key_maps.add(candidate)
    if len(key_maps) != 1:
        raise ValueError('missing verified macOS default key map')
    key_map = key_maps.pop()
    defaults = {'layouts/main.json': layout, 'keys.json': key_map}
    for name, payload in defaults.items():
        target = args.output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)
        hashes[name] = hashlib.sha256(payload).hexdigest()
    begin = binary.index(b'herdr.d.ts//') + len(b'herdr.d.ts')
    end = binary.index(b'gpui-kit.d.tsimport ', begin)
    declaration = binary[begin:end]
    declaration.decode('utf-8')
    (args.output / 'herdr.d.ts').write_bytes(declaration)
    hashes['herdr.d.ts'] = hashlib.sha256(declaration).hexdigest()
    (args.output / 'source-hashes.json').write_text(json.dumps(hashes, indent=2) + '\n')
    (args.output / 'NOTICE').write_text(
        f'Unmodified built-in mods and Herdr declarations from Herdr {version} by the Herdr authors.\n'
        'Licensed under the Apache License, Version 2.0.\n'
        'The complete license is at licenses/herdr-apache-2.0.txt in the repository root.\n'
        'Exact embedded file lengths were read from the executable asset table.\n'
        'SHA-256 digests are recorded in source-hashes.json.\n')
    print(f'{version}: extracted {len(assets)} exact assets and declarations')


if __name__ == '__main__':
    main()
