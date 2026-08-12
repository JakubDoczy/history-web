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

## Round 55: the same two defects, reported again — and why

The reader, after round 52 shipped: *"empires still do not have nice borders,
they sometimes overlap (despite you claiming it's no longer possible due to
build check) and some borders have weird inconsistent line (border line
sometimes vanishes in certain places)."*

They were right twice, and the validator was green, so the first job was to
find where the validator's definition and the eye's definition had come apart.

**Overlap: the epsilon was measured in the wrong unit.** Round 52 forgave a
shared region up to 0.5% of the smaller polygon. The reasoning — a sliver and a
province are the same *absolute* area when one polity is Phoenicia — is sound;
the metric is not, because it scales the forgiveness with the polity, and 0.5%
of France is Alsace-Lorraine. Five double claims shipped under it, each a
province the reader could point at, the largest 0.92 sq° along the Ordos loop.

What separates a sliver from a province is neither area nor share but WIDTH: a
sliver is arithmetic failing to make two lines meet, so it is bounded by the
precision of the numbers (this corpus stores at 1e-4°, and its widest surviving
seam is 5.5 m), while a piece of ground is as wide as it is. Measured over the
corpus the two populations are three and a half orders of magnitude apart with
nothing in between. The validator now convicts on mean width (`2A/P`) above
`OVERLAP_WIDTH_DEG` = 1e-3° — 111 m, twenty times the widest artefact and a
hundredth of the narrowest real claim. The five convicted pairs are resolved as
frontier rules in `frontiers.json`, in the round-52 pattern.

**Vanishing ink and bitten fills: one bug, twice.** A stored edge is two numbers
however far apart they are, and clipping to the coast hid the fact that the
*authored* half of a ring never changed — Russia's 1700 southern frontier is
still one edge from 120°E to 70°E. Drawn as a chord that line passes 217 km
under the sphere it is supposed to lie on, against the 8.3 km `FRONTIER_ALT`
lifts it: 314 stored edges sag deeper than their own altitude, and in 1922 that
is 28% of all the political ink on the globe, gone. The same long edges make
three-globe interpolate a cap contour along great circles that leaves the planar
ring its own triangle test is measured against — 48% of the interpolated points
— so the fill loses the boundary triangles hanging off them and shows notches.

Both go away by densifying onto great circles first, at the resolution the
polygon layer tessellates at, which is the fix `areaCapRing` already applied to
event footprints for the second reason and never got applied to nations. Cap
contour and political ink are then literally the same vertices rather than two
curves through the same endpoints. Worst year on the globe: cap vertices
13 167 → 13 502 (+2.5%), ink segments 2 085 → 2 420 (+16.1%), draw calls
unchanged — these are the points the layer was generating anyway.

**Exonerated, with measurements**, so the next round does not re-litigate them:
the coastal run-length encoding is correctly phased (93.8% agreement at shift 0
against a fresh classification of the shipped ring, 75% at ±1); the 4 m coast
tolerance is not eating inland frontier; no shared frontier edge is classified
COAST by one side and INLAND by the other (0 of 650, now gated); and the
renderer's drawn set is a subset of the validator's notable set, so nothing is
drawn in a year the validator considered it inactive.

## Round 57: the hole in Korea, and the years after the corpus stops

Two gaps, both of them places where the map answered a reader's question with
blank paper.

**Korea, 1895–1910.** Round 52 wrote down Shimonoseki correctly — the Qing
yields Taiwan and its claim to Korea to Japan from 1895 — and gave Japan an
annexation keyframe at 1910, and between those two years the peninsula belonged
to nobody on the globe. The Korean Empire was not in the corpus at all, and
neither was the five-hundred-year state it renamed. So the fix is not a
placeholder for the fifteen years: it is **Joseon from 1392** (`joseon`, notable
to 1896) and **the Korean Empire from 1897** (`koreanempire`, notable to 1909),
same colour, same ground, the way `aksum`/`aksum2` already handle a state that
changes its name and its century. 1910 is Japan's, because a succession is not a
co-reign.

The authored extent is one ring drawn *offshore* on three sides — the clip
pipeline replaces a hand-drawn shore with Natural Earth's, so the honest way to
author a coastline is not to author one — and the two rivers on the fourth. The
frontier is the Yalu from its mouth at Uiju to Paektu and the Tumen from Paektu
to its mouth: twelve inked edges against three hundred and thirty coastal ones.
The 1392 keyframe stops short of the Tumen and the 1450 one does not, which is
Sejong's six garrisons (1434–1449) and the only border movement the peninsula
has in five centuries.

Three frontier rules, in the round-52 pattern: `ming` and `qing` yield to
Joseon, and `qing` to the Korean Empire — tribute is not a border, and the Qing
extent's straight line across the northern peninsula yields to the rivers the
1712 Mukedeng survey put on the ground. Two authored fixes came with them, both
of which the validator would otherwise have convicted: Russia's 1900 ring reached
the Tumen with a single point at (130, 42), a hundred kilometres inside Korea,
and now carries the river mouth itself; and Japan's 1910 keyframe carried its own
sketch of the peninsula, which is now the Korean Empire's ring, vertex for vertex
— **the annexation is a change of colour, not of shape.**

**The modern states.** After about 1900 the corpus thins to the polities that
still exist: at 2000 the globe drew the United States, China and India, and
Europe, Africa and the Middle East had no political line on them at all. The
layer that fills that in is Natural Earth's 1:50m admin-0 countries — the same
`countries-50m.json` topology `land-50m.json` is cut from, so coast agreement is
identity rather than tolerance — and everything about how it ships is decided by
what it must not become.

*Ink, not polities.* 241 units against a globe that caps itself at ten. So
nothing enters the corpus, the store's `all`, `visibleNations` or the polygon
layer: what ships is the lines *between* countries, drawn through the existing
`FrontierLayer` as ONE entry for the whole world — one draw call, no fills, no
hover, nothing to click. A country's coastline is not in the payload at all,
because the map already draws it.

*A shared arc is one line.* A TopoJSON topology stores the boundary between two
countries once, as an arc both reference, so the frontiers are exactly the 362
arcs with two owners and they arrive deduped by construction — no difference
operator, no overlap validator, no frontier rules. The build asserts that no arc
has three owners, and a test asserts that no edge in the shipped payload appears
twice.

*The honesty threshold: 1992, with a patch set.* NE ships today's borders, so
there is a year before which drawing them is a lie. The two clean answers were
**2011+** (unpatched and fully correct — South Sudan is the last change a 1:50m
map can see) and **1992+** (the first full year after the Soviet dissolution)
with a handful of frontiers withheld until they existed. The patch set shipped,
because when the payload is frontiers and not fills a *merge is a deletion*:
Czechoslovakia's outline is Czechia's and Slovakia's minus the line between them,
and withholding that line until 1993 is the whole of the patch. Seven dated
lines, each with its date and its reason in the file: Czechia|Slovakia and
Eritrea|Ethiopia (1993), Indonesia|Timor-Leste (2002), Montenegro|Serbia and
Kosovo|Montenegro (2006), Kosovo|Serbia (2008), Sudan|S. Sudan (2011).

*Who inks a shared border.* The three polities the corpus still draws after 1992
have hand-authored frontiers hundreds of kilometres off the surveyed ones, and
two pens on one border is the defect this rework exists to remove — so while the
modern set is on, a polity keeps its wash, its label and (on the photograph,
where nothing else draws a shore) its coastline, and gives up its frontier. That
is `frontierInkPlan`, and it is why `inkPathsOf` now has four answers instead of
two.

**Honest limits, written down rather than shipped quietly.** Hong Kong and Macao
are separate units in NE and their lines are drawn across the whole window,
including the years they were a British and a Portuguese colony. Somaliland,
Northern Cyprus and post-2008 Kosovo are drawn because NE draws them; Western
Sahara's line with Morocco is the berm; Palestine's is the 1949 armistice line;
Crimea is Ukraine's, which is a de-jure answer to a question with a de-facto
one. Demarcations settled inside the window (Iraq/Kuwait 1993, Bakassi 2006, the
India/Bangladesh enclave exchange 2015) move lines by less than the 400 m this
data can express. And the modern layer says nothing about 1900–1991, which is
the century of borders this globe still cannot draw: that wants a year-sliced
political dataset, not a threshold.
