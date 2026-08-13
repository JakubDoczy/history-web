# Borders v3: frontiers that follow the ground

Status: contract, round 59. Author: architect session.

User's brief: *"make borders better - more detailed and with much less error
rate. I know it's hard and must be hardcoded but try to find a way. Borders
are still a thing that really sucks."*

## The insight

A hand-authored frontier is a dozen points guessed over a mental map, and no
amount of pipeline can add truth to it. But most real historical frontiers
FOLLOW NAMED FEATURES: rivers (the Rhine, the Danube, the Yalu, the Oder),
and — for treaty lines that survive today — the modern border itself (the
Pyrenees line of 1659, the 49th parallel, the Rio Grande). We already ship
both feature sets as vector data: NE 50m rivers (water-50m) and the NE
modern-border arcs (borders.modern payload / countries-50m topology). So the
authoring format learns to DECLARE what a frontier follows, and the build
derives the detailed polyline from the data:

    "follows": [
      { "river": "Danube", "from": [lng,lat], "to": [lng,lat] },
      { "modern": "FRA-ESP" },
      { "line": [[...],[...]] }          // explicit points where nothing helps
    ]

The historian's choice stays hardcoded (which feature, between which points);
the geometric detail comes from Natural Earth. Error becomes MEASURABLE: the
build reports each declared segment's snap distance, and a frontier that
claims a river but wanders from it is a build warning with a number.

## Scope, by value

1. PIPELINE (scripts/nations-clip-lib or a sibling): feature extraction —
   named rivers from the vendored water data (NE rivers carry name
   attributes; verify what survives our pruning and re-vendor names if they
   were stripped), modern-border arcs by country pair; a `follows` resolver
   that walks the feature between the declared endpoints (snap endpoints to
   nearest feature vertex, take the path between, orient to ring winding);
   splice resolved segments into the polity ring in place of the coarse
   authored run they replace. Deterministic, validated (continuity: spliced
   ring closes; the declared endpoints are within a stated tolerance of the
   feature).
2. DATA PASS over the corpus's worst frontiers — judged by screen presence:
   the big riverine frontiers first (Rhine/Danube Rome+successors; Yalu/
   Tumen already hand-done — convert to declarations; Oder-Neisse; Amur;
   Indus; Euphrates lines; Danube for Ottoman/Habsburg), then modern-line
   treaties (Pyrenees, Alps France/Italy 1860, US-Canada, US-Mexico,
   Portugal-Spain — the oldest unchanged border in Europe). Each conversion
   is one `follows` declaration replacing dozens of guessed points, and each
   should visibly improve a place a reader will actually look.
3. ERROR REPORT: the build prints a per-polity table — % of inland frontier
   length that is declared (follows a feature) vs freehand, and the mean
   snap error of declared segments. This is the metric the user's "error
   rate" becomes; future data work drives it up/down measurably.

## Non-goals this round

No new dataset adoption (historical-basemaps stays a licensing decision).
No mountain-ridge features (no relief data shipped; a ridge line would be
guessed, which is the disease). Modern-borders layer and coastline handling
unchanged.
