# Contested territory

Status: contract, round 60. Author: architect session.

User's brief: *"add 'contested territory' feature for cases such as Russian
invasion of Ukraine or territory in Sudan and so on."*

## The shape of the problem

The nations layer states, for every point at every date, exactly one holder —
the overlap validator exists to keep that promise. But some ground at some
dates has NO single honest holder: Crimea after 2014, the Russian-occupied
oblasts after 2022, Kashmir since 1947, Western Sahara since 1975, the areas
contested in Sudan's wars. Painting either claimant's flat colour there is a
statement the map should not make. Cartography solved this long ago: the
disputed area is HATCHED.

## Design: contested zones are carved, not overlapped

A contested zone is a first-class dated entry in `nations.json`:

    "contested": [
      { "id": "crimea", "name": "Crimea",
        "claimants": ["ukraine", "russia"],
        "from": 2014.17, "rings": [...] }
    ]

At clip time (`clip-nations.mjs`) the zone's geometry is SUBTRACTED from every
claimant whose keyframe overlaps the zone's date range, exactly the way the
sea is subtracted from everyone. So by construction no claimant fill covers
contested ground, the overlap validator needs no exemption clause, and the
zone itself ships as its own clipped rings in `nations.clipped.json`.

Rendering: the zone is a polygon cap like any polity, but its fill is a
DIAGONAL HATCH alternating the two claimants' colours (shader stripes in a
stable ground-fixed direction, not screen space, so the hatch doesn't crawl
when the camera turns). Neutral grey hatch if a claimant is absent from the
frame. Its outline strokes are DASHED in the frontier layer — a line in
dispute, same convention the drawing layer already uses for dashed
frontlines. Where the zone's edge coincides with a claimant's remaining
frontier, shared-edge dedup applies as it does between polities.

Dating: `from`/`to` fractional years like frontier rules. Crimea from
2014.17 (the March annexation); the four-oblast occupation zone from 2022.15
with geometry at the stable post-2022 line (we draw eras, not weekly front
movements — the drawing layer, not the nations layer, is where an offensive's
arrows live). Kashmir from 1947.8 (LoC-divided claim), Western Sahara from
1975.9, Sudan: Abyei box from 2011.5 (CPA referendum never held). Sources:
the zone rings derive from named features where possible (the `follows`
machinery is reusable: an occupation line that follows the Dnipro follows the
Dnipro) and from documented lines (LoC, berm) otherwise.

## Validators

- A zone must name ≥2 claimants; each claimant must exist and overlap the
  zone's date range, and the zone must intersect each claimant's pre-carve
  geometry (a zone nobody claimed is a typo).
- Carve continuity: claimant rings still close after subtraction.
- The error report gains a `contested` section: zone count, total km²
  carved, and snap error for any `follows`-declared zone edges.

## Non-goals

No per-month front lines (drawing layer's job). No de-jure/de-facto toggle —
one map, hatch means disputed. Taiwan is out of scope this round: it is a
governance dispute over an island with a stable line, better served by its
own polity entry later than by hatching the whole island.
