# Nations rework: borders that respect the coast and each other

Status: contract, round 52. Author: architect session.

User's brief: *"go over countries / empires and fix borders — especially
coastlines do not match with the scheme map and for some years, empires have
very overlapping borders — this needs to be completely reworked and rethought
how to correctly and accurately show empires."*

## The two defects, named

1. **Coastline mismatch.** Polity polygons carry their own hand-authored
   coastline segments, which disagree with the Natural Earth 50m coastline
   the drawn map renders — fills jut into the sea or stop short of it.
2. **Overlap.** Some concurrent polities' polygons overlap by whole regions.
   A frontier between two empires is one shared boundary, not two opinions.

## The rework

**Clip to land, at build time.** A build step intersects every polity polygon
with the vendored Natural Earth land geometry (the same
`public/data/map/land-50m.json` the drawn map renders — one source of truth,
so agreement is by construction, not by care). Output replaces the runtime
polygons. Use a robust polygon-clipping library (e.g. `polygon-clipping` on
npm) in a node script beside the other data scripts; preserve ring winding
conventions the conic geometry needs (CW — see the phase-1 lesson).

**The coast is the coast.** After clipping, classify each border edge:
edges that lie on the land boundary (within tolerance) are COASTAL and are
not stroked — the drawn map already inks that line; stroking it again
doubles it and any mismatch reads as error. Only INLAND frontier edges get
political ink. Fills (or bands) still cover the polity's whole clipped area,
so the fill meets the sea exactly on the drawn coastline.

**Overlap is a build error.** The validator computes pairwise intersection
area for polities active in the same year-range; overlap above a small
epsilon (share of the smaller polygon, to forgive hairline digitisation
slivers) fails the build and names the pair and the years. Then FIX the
data the validator convicts: shared frontiers become one agreed line
(subtract one polygon from the other along the historically-defensible
boundary; where a frontier is genuinely contested/fuzzy, the polygons must
still tessellate — ambiguity is a rendering treatment for later, never
silent double-claiming).

**Evaluate (report only, do not adopt this round): historical-basemaps**
(github.com/aourednik/historical-basemaps) as a future replacement for the
hand-authored polity set — real year-sliced world political geometry.
Check its license carefully and report whether it is compatible with this
project's use; estimate the integration cost. Adoption is a separate
decision for the architect and the user.

## Verification

Screenshots on the drawn map: a coastal empire (Rome 117, British India,
Japan) showing fill meeting the coastline exactly with no double ink; a
land frontier still inked; the formerly-overlapping years clean (validator
green over the whole corpus). Same shots in realistic mode (clipping must
not regress the satellite view). Polygon vertex-count budget before/after
(clipping against 50m land multiplies vertices — simplify inland-preserving
if the draw cost moves measurably).
