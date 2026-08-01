#!/usr/bin/env python3
"""Split the flat item list into the era chunks the app streams.

Reads every JSON file in public/data/events/ except manifest.json (so it can
re-run over its own output, or ingest a new flat file dropped in the folder),
DERIVES each item's numeric priority from its position in ranking.txt, assigns
each item to an era chunk by the year it is anchored at, extracts the
high-priority spine, and rewrites manifest.json + spine.json + the era files.

Items are events, persons and concepts (see src/lib/events.ts). An entry with
no "kind" is an event, which is what the several hundred entries written before
the item model existed rely on.

Chunk coverage in the manifest is the true min..max time extent of each chunk,
so long-running events are found from windows that only touch their tail.

--- ranking ---

public/data/events/ranking.txt is the SOURCE of importance: one id per line,
most important first, '#' comments and blank lines ignored. Priorities in the
JSON are outputs of this script, not inputs — editing one by hand is pointless,
it is overwritten on the next build.

Ids absent from the list are the MINOR tier: priority 0, off the globe unless
Settings -> Events -> "Show minor events" is on, but still searchable and
linkable.
"""

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'data' / 'events'
RANKING = OUT / 'ranking.txt'
SPINE_PRIORITY = 85  # spine = always-loaded backbone; keep it a few hundred items at most

MINOR_PRIORITY = 0  # must match MINOR_PRIORITY in src/lib/events.ts

# --- rank -> priority ------------------------------------------------------
# The runtime still culls, sizes pins and picks the spine on a 1..100 number,
# so a rank has to become one. The curve is
#
#     priority(rank) = round(TOP - SPREAD * (rank / (N - 1)) ** SHAPE)
#
# i.e. 100 for the first id on the list, 52 for the last, whatever N is.
# SHAPE < 1 makes it concave: the top of the list keeps fine-grained separation
# (the first ~2% of ids stay at 95+, a set small enough to be the "era-defining"
# tier) while the long tail compresses into a few crowded levels. That is the
# shape of the hand-assigned priorities this replaces — they ran 52..100 with
# twenty-odd entries at 95+ — so every threshold already baked into the app and
# its tests (spine at 85, tier bands at 95/85/70/55) keeps meaning what it did.
TOP = 100
BOTTOM = 52
SPREAD = TOP - BOTTOM
SHAPE = 0.6


def priority_for(rank: int, n: int) -> int:
    """1..100 from a 0-based rank in a list of n ids."""
    if n <= 1:
        return TOP
    return max(1, round(TOP - SPREAD * (rank / (n - 1)) ** SHAPE))


# (name, start-year lower bound inclusive); items are assigned to the last era
# whose bound is <= the item's anchor year. Bounds are astronomical years
# (0 = 1 BCE).
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


def kind_of(item: dict) -> str:
    return item.get('kind', 'event')


def anchor_year(item: dict) -> float:
    """The year an item sits at: an event starts, a person is born, a concept is anchored."""
    k = kind_of(item)
    if k == 'person':
        return item['born']
    if k == 'concept':
        return item['anchorYear']
    return item['start']


def time_extent(item: dict) -> tuple[float, float]:
    """The span an item occupies on the timeline — a point for anything instantaneous."""
    k = kind_of(item)
    if k == 'person':
        return item['born'], item.get('died', item['born'])
    if k == 'concept':
        return item['anchorYear'], item['anchorYear']
    return item['start'], item.get('end', item['start'])


def read_ranking() -> list[str]:
    if not RANKING.exists():
        sys.exit(f'missing ranking file: {RANKING}')
    ids = []
    for line in RANKING.read_text().splitlines():
        line = line.split('#', 1)[0].strip()
        if line:
            ids.append(line)
    return ids


def validate(items: list[dict], ranked: list[str]) -> None:
    by_id = {e['id']: e for e in items}
    seen: set[str] = set()
    dupes = sorted({i for i in ranked if i in seen or seen.add(i)})
    if dupes:
        sys.exit(f'ranking.txt lists {len(dupes)} id(s) twice: {", ".join(dupes)}')
    missing = [i for i in ranked if i not in by_id]
    if missing:
        sys.exit(f'ranking.txt names {len(missing)} unknown id(s): {", ".join(missing)}')
    required = {'event': ('start', 'lat', 'lng'), 'person': ('born',), 'concept': ('anchorYear',)}
    for e in items:
        k = kind_of(e)
        if k not in required:
            sys.exit(f'{e["id"]}: unknown kind {k!r}')
        for field in required[k]:
            if field not in e:
                sys.exit(f'{e["id"]}: a {k} needs a {field!r}')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    items, seen = [], set()
    for f in sorted(OUT.glob('*.json')):
        if f.name == 'manifest.json':
            continue
        for e in json.loads(f.read_text()):
            if e['id'] not in seen:
                seen.add(e['id'])
                items.append(e)
    # also ingest a flat file passed as argument (one-off migrations)
    for arg in sys.argv[1:]:
        for e in json.loads(Path(arg).read_text()):
            if e['id'] not in seen:
                seen.add(e['id'])
                items.append(e)

    ranked = read_ranking()
    validate(items, ranked)

    rank_of = {i: r for r, i in enumerate(ranked)}
    n = len(ranked)
    for e in items:
        r = rank_of.get(e['id'])
        e['priority'] = MINOR_PRIORITY if r is None else priority_for(r, n)

    chunks: dict[str, list] = {name: [] for name, _ in ERAS}
    for e in items:
        chunks[era_for(anchor_year(e))].append(e)

    manifest = {'spine': 'spine.json', 'chunks': []}
    for name, _ in ERAS:
        evs = sorted(chunks[name], key=anchor_year)
        if not evs:
            continue
        file = f'{name}.json'
        (OUT / file).write_text(json.dumps(evs, indent=1, ensure_ascii=False) + '\n')
        manifest['chunks'].append({
            'file': file,
            'from': min(time_extent(e)[0] for e in evs),
            'to': max(time_extent(e)[1] for e in evs),
            'count': len(evs),
        })

    spine = sorted((e for e in items if e['priority'] >= SPINE_PRIORITY), key=anchor_year)
    (OUT / 'spine.json').write_text(json.dumps(spine, indent=1, ensure_ascii=False) + '\n')
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')

    total = sum(c['count'] for c in manifest['chunks'])
    kinds = {k: sum(1 for e in items if kind_of(e) == k) for k in ('event', 'person', 'concept')}
    minor = sum(1 for e in items if e['priority'] == MINOR_PRIORITY)
    print(f'{total} items -> {len(manifest["chunks"])} chunks + spine ({len(spine)})')
    print(f'  kinds: {kinds}  ranked: {n}  minor: {minor}')
    for c in manifest['chunks']:
        print(f"  {c['file']:20s} {c['count']:6d}  {c['from']:.6g} .. {c['to']:.6g}")


if __name__ == '__main__':
    main()
