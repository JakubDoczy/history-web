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
`paths` list of routes, a `points` list of secondary sites and a `drawing`
overlay — the first, second and fourth in [lng, lat] order (see validate_paths,
validate_points and validate_drawing).

Relations are validated too (see validate_relations). Three typed fields carry
the whole graph, and all three are written on ONE side only:

  parent   hierarchical containment, one at most, must resolve to an event,
           acyclic. Battle -> operation -> war.
  strong   defining, first-order associations. Einstein <-> relativity, a
           treaty <-> the war it ended. Symmetric; the runtime index
           materialises the inverse (see buildRelations in src/lib/events.ts).
  weak     see-also. Informative but secondary. Symmetric, same rule.

A fourth edge is not a relation but a route through one: a STEP's `child` (see
validate_step_children), which makes that step an entrance into another item.
It is checked on its own edges — resolvable, an event, acyclic — because
nothing forces it to follow `parent`, and a loop in it is an infinite descent.

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
        validate_points(e)
        validate_drawing(e)
        validate_steps(e, by_id)
    validate_step_children(items, by_id)
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


def check_drawing(e: dict, what: str, d) -> None:
    """One drawing: `layers`, five kinds, all [lng, lat].

    Mirrors `isDrawingSpec` in src/lib/drawing.ts. Checked here so a mistyped
    layer kind or a swapped coordinate pair is a build failure rather than a
    silently missing arrow on a map nobody re-reads.

    `what` names where the drawing came from, because there are now two places
    one can be written: an event's own `drawing`, and a STEP's (see
    validate_steps and src/lib/steps.ts, rule 4).
    """
    if not isinstance(d, dict) or not isinstance(d.get('layers'), list) or not d['layers']:
        sys.exit(f'{e["id"]}: {what} must be an object with a non-empty "layers" list')
    for i, layer in enumerate(d['layers']):
        where = f'{what} layer {i}'
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



def validate_drawing(e: dict) -> None:
    """An event's own overlay, if it has one."""
    d = e.get('drawing')
    if d is None:
        return
    event_only(e, 'a drawing')
    check_drawing(e, 'drawing', d)


def validate_points(e: dict) -> None:
    """Secondary sites: `points`, a list of {lat, lng, name?}.

    The main location is `lat`/`lng` — one place, because a pin is one place —
    and this is how an event names the rest of them (see the `point` member of
    `Feature` in src/lib/events.ts). Flat, like every other coordinate on disk,
    and NOT in GeoJSON order for the same reason `lat`/`lng` are not: these are
    named fields, so there is no order to get wrong.
    """
    points = e.get('points')
    if points is None:
        return
    event_only(e, 'points')
    if not isinstance(points, list) or not points:
        sys.exit(f'{e["id"]}: points must be a non-empty list — drop the field instead')
    for i, p in enumerate(points):
        where = f'point {i}'
        if not isinstance(p, dict):
            sys.exit(f'{e["id"]}: {where} is not an object')
        lat, lng = p.get('lat'), p.get('lng')
        if not isinstance(lat, (int, float)) or not -90 <= lat <= 90:
            sys.exit(f'{e["id"]}: {where} lat is off the planet')
        if not isinstance(lng, (int, float)) or not -180 <= lng <= 180:
            sys.exit(f'{e["id"]}: {where} lng is off the planet')
        name = p.get('name')
        if name is not None and (not isinstance(name, str) or not name):
            sys.exit(f'{e["id"]}: {where} name must be non-empty text')
        for k in p:
            if k not in ('lat', 'lng', 'name'):
                sys.exit(f'{e["id"]}: {where} has unexpected key {k!r}')


STEP_ID = re.compile(r'^[a-z0-9][a-z0-9-]*$')
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
    failure. Mirrors `markupProblems` in src/lib/steps.ts.
    """
    opens = text.count('](')
    links = len(COMPLETE_LINK.findall(text))
    if opens != links:
        sys.exit(f'{e["id"]}: {where} has {opens - links} malformed link(s)')


def validate_steps(e: dict, by_id: dict) -> None:
    """The authored steps: `steps`, ids unique per event, times inside the span.

    Mirrors `stepProblems` in src/lib/steps.ts, and checked here for the same
    reason the drawing is: a step dated outside the event it is a step of owns a
    window no layer can fall in, which is a chip that filters the map to nothing
    rather than an exception.

    A step's time is written in one of two forms, and exactly one of them:

        {"at": 0.45}                 a moment
        {"start": 0.3, "end": 0.55}  a stretch

    Both use the same dual space a drawing layer's `at` does (see DrawingCommon
    in src/lib/drawing.ts): a value in 0..1 is a FRACTION of the event's span,
    and anything else is a year, which must lie inside that span.

    A step may also carry ink of its own (`drawing`, drawn over the parent layers
    its window keeps) and `highlights` — ids of this event's own children to lift
    while it is open. A highlight that is not a child is a build failure: the
    whole of what it does is pin and accent a child pin, so naming something else
    is a line of data that can never have an effect.

    Or it may be an ENTRANCE: a `child`, which makes the step another item and
    makes stepping into it a descent (see Step.child in src/lib/steps.ts). Such a
    step legitimately carries nothing but an id, a name and a time — the child
    supplies its own page, ink and camera — so page/drawing/camera stay optional
    here for it, as they are for every other step. What the child itself must be
    is checked in validate_step_children, which needs the whole corpus.
    """
    steps = e.get('steps')
    if steps is None:
        return
    event_only(e, 'steps')
    if not isinstance(steps, list) or not steps:
        sys.exit(f'{e["id"]}: steps must be a non-empty list — drop the field instead')
    start = e['start']
    finish = e.get('end', start)
    children = {c['id'] for c in by_id.values() if c.get('parent') == e['id']}
    seen: set[str] = set()
    for i, s in enumerate(steps):
        where = f'step {i}'
        if not isinstance(s, dict):
            sys.exit(f'{e["id"]}: {where} is not an object')
        sid = s.get('id')
        if not isinstance(sid, str) or not STEP_ID.match(sid):
            sys.exit(f'{e["id"]}: {where} needs a lowercase-kebab "id", not {sid!r}')
        if sid in seen:
            sys.exit(f'{e["id"]}: two steps share the id {sid!r}')
        seen.add(sid)
        if not isinstance(s.get('name'), str) or not s['name']:
            sys.exit(f'{e["id"]}: {where} ({sid}) needs a non-empty "name"')

        # --- the time, in exactly one of its two forms
        moment, stretch = 'at' in s, 'start' in s
        if moment == stretch:
            sys.exit(
                f'{e["id"]}: {where} ({sid}) needs either "at" (a moment) or '
                f'"start"/"end" (a stretch), not both and not neither'
            )
        ends = [s['at']] if moment else [s['start']] + ([s['end']] if 'end' in s else [])
        for v in ends:
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                sys.exit(f'{e["id"]}: {where} ({sid}) has a non-numeric time {v!r}')
            if not (0 <= v <= 1) and not (start <= v <= finish):
                sys.exit(
                    f'{e["id"]}: {where} ({sid}) {v} is outside the span {start}..{finish}'
                )
        if len(ends) == 2 and ends[1] < ends[0]:
            sys.exit(f'{e["id"]}: {where} ({sid}) ends before it starts')

        page = s.get('page')
        if page is not None:
            if not isinstance(page, str) or not page:
                sys.exit(f'{e["id"]}: {where} ({sid}) page must be non-empty text')
            check_markup(e, f'{where} ({sid}) page', page)
        if s.get('drawing') is not None:
            check_drawing(e, f'{where} ({sid}) drawing', s['drawing'])
        highlights = s.get('highlights')
        if highlights is not None:
            if not isinstance(highlights, list) or not highlights:
                sys.exit(f'{e["id"]}: {where} ({sid}) highlights must be a non-empty list')
            for h in highlights:
                if not isinstance(h, str) or not h:
                    sys.exit(f'{e["id"]}: {where} ({sid}) highlights must be ids')
                if h not in children:
                    sys.exit(
                        f'{e["id"]}: {where} ({sid}) highlights {h!r}, '
                        f'which is not a child of this event'
                    )
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
        child = s.get('child')
        if child is not None and (not isinstance(child, str) or not child):
            sys.exit(f'{e["id"]}: {where} ({sid}) child must be an id')
        for k in s:
            if k not in (
                'id', 'name', 'at', 'start', 'end', 'page', 'camera', 'drawing',
                'child', 'highlights',
            ):
                sys.exit(f'{e["id"]}: {where} ({sid}) has unexpected key {k!r}')


def validate_step_children(items: list[dict], by_id: dict) -> None:
    """The step-child graph: every entrance resolves, and none of them loops.

    Two checks, and the second is the one that needs the whole corpus.

    RESOLVES. A `child` names an item that exists and is an EVENT. It is an
    event because stepping into one is `showOnMap` (see selectStep in
    src/stores/events.ts), which needs somewhere on the globe to go: a concept
    has no place at all, so a chip pointing at one would be a chip that does
    nothing, which is exactly the class of data error a build check exists for.

    ACYCLIC, and checked on its own edges rather than on `parent`. The two
    graphs are expected to agree — an entrance normally descends into a child
    of the stepped event — but nothing in the model forces that, and "the
    parent chain is acyclic" would not save a reader from ww2 -> d-day -> ww2.
    A cycle here is an infinite descent: every step in it pushes another focus
    context, for ever.
    """
    edges: dict[str, set[str]] = {}
    for e in items:
        for s in e.get('steps') or ():
            child = s.get('child')
            if child is None:
                continue
            if child == e['id']:
                sys.exit(f'{e["id"]}: step {s["id"]!r} descends into its own event')
            if child not in by_id:
                sys.exit(f'{e["id"]}: step {s["id"]!r} descends into unknown item {child!r}')
            if kind_of(by_id[child]) != 'event':
                sys.exit(
                    f'{e["id"]}: step {s["id"]!r} descends into {child!r}, '
                    f'which is a {kind_of(by_id[child])} and has nowhere on the map to go'
                )
            edges.setdefault(e['id'], set()).add(child)

    # iterative DFS with the usual three colours; the path is kept so the error
    # names the loop rather than merely reporting that there is one
    state: dict[str, int] = {}

    def walk(start: str) -> None:
        stack = [(start, iter(sorted(edges.get(start, ()))))]
        path = [start]
        state[start] = 1
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                state[node] = 2
                stack.pop()
                path.pop()
                continue
            if state.get(nxt) == 1:
                loop = ' -> '.join(path[path.index(nxt):] + [nxt])
                sys.exit(f'step-child graph is a cycle: {loop}')
            if state.get(nxt) != 2:
                state[nxt] = 1
                path.append(nxt)
                stack.append((nxt, iter(sorted(edges.get(nxt, ())))))

    for node in sorted(edges):
        if state.get(node) is None:
            walk(node)


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
