#!/usr/bin/env python3
"""Split a flat event list into the era chunks the app streams.

Reads every JSON file in public/data/events/ except manifest.json and
spine.json (so it can re-run over its own output, or ingest a new flat file
dropped in the folder), assigns each event to an era chunk by its start year,
extracts the high-priority spine, and rewrites manifest.json + spine.json +
the era files. Chunk coverage in the manifest is the true min(start)..max(end)
of each chunk, so long-running events are found from windows that only touch
their tail.
"""

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'events'
SPINE_PRIORITY = 85  # spine = always-loaded backbone; keep it a few hundred events at most

# (name, start-year lower bound inclusive); events are assigned to the last era
# whose bound is <= start. Bounds are astronomical years (0 = 1 BCE).
ERAS = [
    ('deep-time', -5_000_000_000),
    ('ancient', -10_000),
    ('medieval', 500),
    ('early-modern', 1500),
    ('modern', 1800),
    ('contemporary', 1945),
]


def era_for(start: float) -> str:
    name = ERAS[0][0]
    for n, bound in ERAS:
        if start >= bound:
            name = n
    return name


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    events, seen = [], set()
    for f in sorted(OUT.glob('*.json')):
        if f.name == 'manifest.json':
            continue
        for e in json.loads(f.read_text()):
            if e['id'] not in seen:
                seen.add(e['id'])
                events.append(e)
    # also ingest a flat file passed as argument (one-off migrations)
    for arg in sys.argv[1:]:
        for e in json.loads(Path(arg).read_text()):
            if e['id'] not in seen:
                seen.add(e['id'])
                events.append(e)

    chunks: dict[str, list] = {name: [] for name, _ in ERAS}
    for e in events:
        chunks[era_for(e['start'])].append(e)

    manifest = {'spine': 'spine.json', 'chunks': []}
    for name, _ in ERAS:
        evs = sorted(chunks[name], key=lambda e: e['start'])
        if not evs:
            continue
        file = f'{name}.json'
        (OUT / file).write_text(json.dumps(evs, indent=1, ensure_ascii=False) + '\n')
        manifest['chunks'].append({
            'file': file,
            'from': min(e['start'] for e in evs),
            'to': max(e.get('end', e['start']) for e in evs),
            'count': len(evs),
        })

    spine = sorted((e for e in events if e['priority'] >= SPINE_PRIORITY), key=lambda e: e['start'])
    (OUT / 'spine.json').write_text(json.dumps(spine, indent=1, ensure_ascii=False) + '\n')
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')

    total = sum(c['count'] for c in manifest['chunks'])
    print(f'{total} events -> {len(manifest["chunks"])} chunks + spine ({len(spine)})')
    for c in manifest['chunks']:
        print(f"  {c['file']:20s} {c['count']:6d}  {c['from']:.6g} .. {c['to']:.6g}")


if __name__ == '__main__':
    main()
