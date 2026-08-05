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

Geometry is validated on the way through: an event may carry an `area` ring, a
`paths` list of routes and a `drawing` overlay, all in [lng, lat] order (see
validate_paths and validate_drawing).

Relations are validated too (see validate_relations). Three typed fields carry
the whole graph, and all three are written on ONE side only:

  parent   hierarchical containment, one at most, must resolve to an event,
           acyclic. Battle -> operation -> war.
  strong   defining, first-order associations. Einstein <-> relativity, a
           treaty <-> the war it ended. Symmetric; the runtime index
           materialises the inverse (see buildRelations in src/lib/events.ts).
  weak     see-also. Informative but secondary. Symmetric, same rule.

One pair, one relation: containment beats strong, strong beats weak. Saying the
same pair twice — from both ends, or at two strengths, or on top of a
parent/child edge — is redundant, and this script prints it. The data tests
then hold the corpus to zero such warnings.

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
import re
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
        validate_paths(e)
        validate_drawing(e)
        validate_stages(e)
    validate_relations(items, by_id)


def validate_relations(items: list[dict], by_id: dict) -> None:
    """parent / strong / weak: resolvable, acyclic, symmetric-once, disjoint.

    Anything that would make the runtime graph wrong is fatal; anything that is
    merely said twice is a warning, because the index dedupes it and failing the
    build over a harmless duplicate helps nobody. `main` counts the warnings and
    the data tests assert there are none, which is what keeps them from rotting.
    """
    warnings: list[str] = []

    # --- parent: one, resolvable, to an event, acyclic
    for e in items:
        parent = e.get('parent')
        if parent is None:
            continue
        if kind_of(e) != 'event':
            sys.exit(f'{e["id"]}: only an event can have a parent')
        if parent == e['id']:
            sys.exit(f'{e["id"]}: is its own parent')
        if parent not in by_id:
            sys.exit(f'{e["id"]}: unknown parent {parent!r}')
        if kind_of(by_id[parent]) != 'event':
            sys.exit(f'{e["id"]}: parent {parent!r} is not an event')
        seen, cur = {e['id']}, parent
        while cur:
            if cur in seen:
                sys.exit(f'{e["id"]}: parent chain is a cycle, through {cur!r}')
            seen.add(cur)
            cur = by_id[cur].get('parent')

    # --- strong / weak: resolvable, no self, no duplicates within one list
    declared: dict[str, set[tuple[str, str]]] = {'strong': set(), 'weak': set()}
    for e in items:
        for field in ('strong', 'weak'):
            ids = e.get(field)
            if ids is None:
                continue
            if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
                sys.exit(f'{e["id"]}: {field} must be a list of ids')
            if not ids:
                sys.exit(f'{e["id"]}: empty {field} — drop the field instead')
            if len(set(ids)) != len(ids):
                sys.exit(f'{e["id"]}: {field} lists the same id twice')
            for other in ids:
                if other == e['id']:
                    sys.exit(f'{e["id"]}: relates to itself via {field}')
                if other not in by_id:
                    sys.exit(f'{e["id"]}: unknown {field} id {other!r}')
                declared[field].add((e['id'], other))

    # --- one pair, one relation
    family = {
        (e['id'], e['parent']) for e in items if e.get('parent')
    } | {(e['parent'], e['id']) for e in items if e.get('parent')}
    for field, pairs in declared.items():
        for a, b in sorted(pairs):
            if (b, a) in pairs:
                # only report each unordered pair once
                if a < b:
                    warnings.append(f'{a} and {b} both declare {field} — write it on one side only')
            if (a, b) in family:
                warnings.append(f'{a} -> {b} is already parent/child; the {field} edge is redundant')
    for a, b in sorted(declared['weak']):
        if (a, b) in declared['strong'] or (b, a) in declared['strong']:
            warnings.append(f'{a} -> {b} is both strong and weak; strong already wins')

    for w in warnings:
        print(f'  warning: {w}')
    if warnings:
        print(f'  {len(warnings)} relation warning(s)')


# --- geometry primitives ---------------------------------------------------
# One point check and one polyline check, shared by every field that carries
# coordinates: `paths`, and the `frontline` / `thrust` / `marker` / `label`
# layers of a drawing. `validate_paths` used to inline its own copy of the
# polyline walk, which is how it came to be the one place that never checked
# that a coordinate was a NUMBER — a string there raised a TypeError out of the
# comparison instead of naming the event.


def event_only(e: dict, what: str) -> None:
    """Geometry belongs to events. A person is a life and a concept is an idea."""
    if kind_of(e) != 'event':
        sys.exit(f'{e["id"]}: only an event can carry {what}')


def check_point(e: dict, where: str, pos) -> None:
    """One [lng, lat] pair — GeoJSON order, numeric, on the planet."""
    if not isinstance(pos, list) or len(pos) != 2:
        sys.exit(f'{e["id"]}: {where} must be [lng, lat]')
    lng, lat = pos
    if not (isinstance(lng, (int, float)) and isinstance(lat, (int, float))):
        sys.exit(f'{e["id"]}: {where} is not numeric: {pos}')
    if not (-180 <= lng <= 180 and -90 <= lat <= 90):
        sys.exit(f'{e["id"]}: {where} is off the planet: {pos}')


def check_line(e: dict, where: str, path) -> None:
    """A polyline: at least two points, each one a good [lng, lat]."""
    if not isinstance(path, list) or len(path) < 2:
        sys.exit(f'{e["id"]}: {where} needs at least two points')
    for j, pt in enumerate(path):
        check_point(e, f'{where} point {j}', pt)


DIRECTIONS = ('oneway', 'twoway')


def validate_paths(e: dict) -> None:
    """Route geometry: `paths` is ALWAYS a list of polylines, never a bare one.

    One canonical field, checked here so a typo is a build failure rather than a
    line missing from the globe (see src/lib/paths.ts). Each polyline needs two
    points to be a line at all, and each point is [lng, lat] — GeoJSON order,
    the same order `area` rings use.
    """
    if 'path' in e:
        sys.exit(f'{e["id"]}: use "paths" (a list of routes), not "path"')
    paths = e.get('paths')
    direction = e.get('direction')
    # Checked before the early return: `direction` on an event with no routes is
    # a statement about nothing, and is almost always a route that got deleted.
    if direction is not None:
        if paths is None:
            sys.exit(f'{e["id"]}: direction without paths — there is no route to point')
        if direction not in DIRECTIONS:
            sys.exit(f'{e["id"]}: direction must be one of {DIRECTIONS}, not {direction!r}')
    if paths is None:
        return
    event_only(e, 'paths')
    if not isinstance(paths, list) or not paths:
        sys.exit(f'{e["id"]}: paths must be a non-empty list of routes')
    for i, path in enumerate(paths):
        check_line(e, f'path {i}', path)


MARKER_STYLES = ('cross', 'star', 'dot', 'arrow')


def validate_drawing(e: dict) -> None:
    """The battle-plan overlay: `drawing.layers`, four kinds, all [lng, lat].

    Mirrors `isDrawingSpec` in src/lib/drawing.ts. Checked here so a mistyped
    layer kind or a swapped coordinate pair is a build failure rather than a
    silently missing arrow on a map nobody re-reads.
    """
    d = e.get('drawing')
    if d is None:
        return
    event_only(e, 'a drawing')
    if not isinstance(d, dict) or not isinstance(d.get('layers'), list) or not d['layers']:
        sys.exit(f'{e["id"]}: drawing must be an object with a non-empty "layers" list')
    for i, layer in enumerate(d['layers']):
        where = f'drawing layer {i}'
        if not isinstance(layer, dict):
            sys.exit(f'{e["id"]}: {where} is not an object')
        t = layer.get('type')
        if 'color' in layer and not (isinstance(layer['color'], str) and layer['color']):
            sys.exit(f'{e["id"]}: {where} has a non-string color')
        if 'at' in layer and not isinstance(layer['at'], (int, float)):
            sys.exit(f'{e["id"]}: {where} has a non-numeric "at"')
        if t == 'frontline':
            paths = layer.get('paths')
            if not isinstance(paths, list) or not paths:
                sys.exit(f'{e["id"]}: {where} (frontline) needs a non-empty "paths" list')
            for j, p in enumerate(paths):
                check_line(e, f'{where} path {j}', p)
            if layer.get('dash') not in (None, 'solid', 'dashed'):
                sys.exit(f'{e["id"]}: {where} dash must be "solid" or "dashed"')
        elif t == 'thrust':
            check_line(e, f'{where} (thrust)', layer.get('path'))
            if 'taper' in layer and not isinstance(layer['taper'], bool):
                sys.exit(f'{e["id"]}: {where} taper must be a boolean')
        elif t == 'marker':
            check_point(e, f'{where} pos', layer.get('pos'))
            if layer.get('style') not in (None,) + MARKER_STYLES:
                sys.exit(f'{e["id"]}: {where} style must be one of {MARKER_STYLES}')
            if layer.get('style') == 'arrow' and not isinstance(layer.get('bearing'), (int, float)):
                sys.exit(f'{e["id"]}: {where} is an arrow and needs a numeric "bearing"')
        elif t == 'label':
            check_point(e, f'{where} pos', layer.get('pos'))
            if not isinstance(layer.get('text'), str) or not layer['text']:
                sys.exit(f'{e["id"]}: {where} (label) needs non-empty "text"')
            if layer.get('size') not in (None, 'sm', 'md'):
                sys.exit(f'{e["id"]}: {where} size must be "sm" or "md"')
        else:
            sys.exit(f'{e["id"]}: {where} has unknown type {t!r}')
        if 'width' in layer and not (isinstance(layer['width'], (int, float)) and 0 < layer['width'] < 90):
            sys.exit(f'{e["id"]}: {where} width must be a positive number')
        if 'size' in layer and t == 'marker' and not (
            isinstance(layer['size'], (int, float)) and 0 < layer['size'] < 90
        ):
            sys.exit(f'{e["id"]}: {where} size must be a positive number of degrees')


STAGE_ID = re.compile(r'^[a-z0-9][a-z0-9-]*$')
# `[text](item:id)`, `[text](event:id)` and `[text](https://…)` — the three link
# forms src/lib/richtext.ts actually renders. Mirrors COMPLETE_LINKS there.
COMPLETE_LINK = re.compile(
    r'\[(.+?)\]\((?:(?:item|event):[\w-]+|https?:(?:[^\s()]|\([^\s()]*\))+)\)'
)


def check_markup(e: dict, where: str, text: str) -> None:
    """Every "](" in a rich-text field closes a link the renderer knows.

    renderRichText cannot fail — anything it does not recognise falls through as
    escaped prose — so a page with a mistyped link ships as visible bracket soup
    rather than as an error. This is the check that turns that into a build
    failure. Mirrors `markupProblems` in src/lib/stages.ts.
    """
    opens = text.count('](')
    links = len(COMPLETE_LINK.findall(text))
    if opens != links:
        sys.exit(f'{e["id"]}: {where} has {opens - links} malformed link(s)')


def validate_stages(e: dict) -> None:
    """Staged focus: `stages`, ids unique per event, `at` inside the span.

    Mirrors `stageProblems` in src/lib/stages.ts, and checked here for the same
    reason the drawing is: a stage dated outside the event it is a stage of owns
    a window no layer can fall in, which is a chip that filters the map to
    nothing rather than an exception.

    `at` has the same two forms it has on a drawing layer (see DrawingCommon in
    src/lib/drawing.ts): a value in 0..1 is a FRACTION of the event's span, and
    anything else is a year, which must lie inside that span.
    """
    stages = e.get('stages')
    if stages is None:
        return
    event_only(e, 'stages')
    if not isinstance(stages, list) or not stages:
        sys.exit(f'{e["id"]}: stages must be a non-empty list — drop the field instead')
    start = e['start']
    finish = e.get('end', start)
    seen: set[str] = set()
    for i, s in enumerate(stages):
        where = f'stage {i}'
        if not isinstance(s, dict):
            sys.exit(f'{e["id"]}: {where} is not an object')
        sid = s.get('id')
        if not isinstance(sid, str) or not STAGE_ID.match(sid):
            sys.exit(f'{e["id"]}: {where} needs a lowercase-kebab "id", not {sid!r}')
        if sid in seen:
            sys.exit(f'{e["id"]}: two stages share the id {sid!r}')
        seen.add(sid)
        if not isinstance(s.get('name'), str) or not s['name']:
            sys.exit(f'{e["id"]}: {where} ({sid}) needs a non-empty "name"')
        at = s.get('at')
        if not isinstance(at, (int, float)) or isinstance(at, bool):
            sys.exit(f'{e["id"]}: {where} ({sid}) needs a numeric "at"')
        if not (0 <= at <= 1) and not (start <= at <= finish):
            sys.exit(
                f'{e["id"]}: {where} ({sid}) at {at} is outside the span {start}..{finish}'
            )
        page = s.get('page')
        if page is not None:
            if not isinstance(page, str) or not page:
                sys.exit(f'{e["id"]}: {where} ({sid}) page must be non-empty text')
            check_markup(e, f'{where} ({sid}) page', page)
        cam = s.get('camera')
        if cam is not None:
            if not isinstance(cam, dict):
                sys.exit(f'{e["id"]}: {where} ({sid}) camera must be an object')
            lat, lng = cam.get('lat'), cam.get('lng')
            if not isinstance(lat, (int, float)) or not -90 <= lat <= 90:
                sys.exit(f'{e["id"]}: {where} ({sid}) camera lat is off the planet')
            if not isinstance(lng, (int, float)) or not -180 <= lng <= 180:
                sys.exit(f'{e["id"]}: {where} ({sid}) camera lng is off the planet')
            alt = cam.get('altitude')
            if alt is not None and not (isinstance(alt, (int, float)) and alt > 0):
                sys.exit(f'{e["id"]}: {where} ({sid}) camera altitude must be positive')
        for k in s:
            if k not in ('id', 'name', 'at', 'page', 'camera'):
                sys.exit(f'{e["id"]}: {where} ({sid}) has unexpected key {k!r}')


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
    rel = {f: sum(len(e.get(f, ())) for e in items) for f in ('strong', 'weak')}
    rel['parent'] = sum(1 for e in items if e.get('parent'))
    print(f'  relations: {rel}  (each edge is authored once and read both ways)')
    for c in manifest['chunks']:
        print(f"  {c['file']:20s} {c['count']:6d}  {c['from']:.6g} .. {c['to']:.6g}")


if __name__ == '__main__':
    main()
