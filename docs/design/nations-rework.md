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

## Round 59: a frontier declares what it follows

The contract is `docs/design/borders-v3.md`, and its insight is that a
hand-authored frontier is a dozen points guessed over a mental map, which no
pipeline can add truth to — while most real frontiers FOLLOW A NAMED FEATURE we
already have vectors for. So `nations.json` stops storing the geometry of the
Rhine limes and starts storing the claim that it *is* the Rhine, between two
places, and the build derives the rest:

    { "river": "Rhine", "from": [4.9854,51.8237], "to": [7.59,47.59],
      "note": "The Rhine limes, from the mouth in the Batavian delta to Basel." }
    { "modern": "FRA-ESP + AND-ESP", "from": [...], "to": [...] }

`scripts/follows-lib.mjs` extracts the feature, chooses a mainline, snaps each
declared endpoint to it, orients the run to the ring's winding and splices it
over the authored vertices between the two endpoints. It runs at the TOP of
`clip-nations.mjs`, before anything else touches a ring, so the clip, the
coastal classification, the frontier rules, the codec and round 55's
densification all see a declaration as geometry and none of them has to know.

**The names were never in the water file, and the water file is too coarse.**
The first thing to check was whether `vendor-map-data.mjs`'s pruning had
stripped the river names. It had not: `sane-topojson` strips `properties` from
every geometry at its own build (0 of 461 river features in `world_50m` carry
any), so they were never there to lose. The file is also quantised at 1e4 —
0.036°, about 4 km — which is ten times coarser than the coastline the same
frontier's polygon is clipped against, so it could not have defined a border
even with names on it. `scripts/vendor-rivers.mjs` therefore vendors named
rivers separately, off Natural Earth's own repository at the `v5.1.2` tag the
10m land came from, into `src/data/rivers-named.json` (306 kB, committed,
build-time only). **1:10m rather than 1:50m** because NE 50m does not contain
the Yalu, the Tumen or the Ussuri — three of the frontiers this round exists to
derive — and an allowlist of 54 rivers rather than all 1 367 named features
because the whole 10m set is 2.0 MB of deltas to serve a 240 kB corpus.

**One river is several names.** NE names each reach in the language of the
country it runs through: the Danube above Bratislava is `Donau`, the Euphrates
above Deir ez-Zor is `Al Furat` and above the Syrian border `Firat`, the upper
Amur is `Heilong Jiang`, the Rhine between Lake Constance and Karlsruhe is
`Rhin`. Matching `name === 'Danube'` silently returns the river from Bratislava
down and loses eight hundred kilometres of it, which is exactly the quiet wrong
answer this round exists to make impossible. `name_alt` and `name_en` catch most
of it; `also` in the allowlist is the handful a human had to check on a map.

**A river is not one polyline, and the choice is recorded.** NE splits a river
at confluences and lake crossings — the Indus is thirteen features, the Amur
five — so "the Danube" is the LONGEST CONTINUOUS CHAIN of them, found by an
exhaustive walk (thirteen edges at worst; a greedy walk can take a long
tributary at the first fork and lose a longer trunk behind it), and every piece
the chain did not take comes back in `dropped` for the build to print. Four
branches are dropped over the whole data pass, the largest being the Alaska
panhandle arc of the USA/Canada border.

Endpoints that *should* meet sometimes miss: the Ussuri's two halves are 129 m
apart, the Euphrates' worst seam is 361 m. Read with an exact key those are two
rivers and "the Ussuri" resolves to its lower half. `JOIN_TOL_KM` is 1 km — a
little over half the 1.8 km median segment of the vendored file, so a hole this
small is a pair of points Natural Earth could not have distinguished — and the
29 seams it bridges are counted in the report rather than papered over.

**The error report is the round's product.** Per polity, what share of the
INLAND frontier (a coastal edge is the map's own line, not political ink) lies
on a declared feature, and how far the declarations' endpoints had to travel to
reach the feature they name. It is measured against the SHIPPED rings, not the
authored ones, so a declaration clipped away at the coast or subtracted by a
frontier rule honestly stops counting; provenance is recovered geometrically at
`DECLARED_TOL_DEG` = 5e-4° (55 m, five quanta of the codec), because the clipper
renumbers everything and cannot be asked where a vertex came from.

    — CORPUS —   1 433 797 inland km   51 779 declared   3.6%   0.25 km mean snap

47 declarations over 14 polities; 61 polities are still wholly freehand, and
that list is the work queue. A snap over `SNAP_WARN_KM` = 40 km now FAILS the
build: an endpoint that far from the river it claims is a declaration naming the
wrong reach, and the whole point of the number is that it is checkable.

**What the data pass bought, and what it cost.** Worst year on the globe: cap
vertices 13 168 → 16 257 (+23%), inked frontier segments 2 368 → 5 467 at 1900,
draw calls unchanged (22 → 22, 77 → 80, 33 → 33 on the three 1900 cameras),
triangles +12–14%. The shipped corpus is 103 k → 120 k vertices, 1 018 kB →
1 160 kB. That is the price of the Rhine being the Rhine, and it is paid in
vertices the layer was already generating for the coast.

**Honest limits, written down rather than shipped quietly.**

 · **The Oder-Neisse is not declarable and the Neisse is not in the data.** NE
   10m has no feature named Neisse or Nysa at any scale we ship, and — more to
   the point — no polity in this corpus has that frontier: Poland leaves the
   corpus in 1795 and Germany's window is 1871–1918.
 · **Neither does the Indus.** It is in the vendored set and it chains cleanly
   from Ladakh to the sea, but there is no polity here whose frontier it is: the
   Indus Valley Civilisation is drawn *around* the basin, Alexander's limit is
   the Hyphasis, and the Maurya-Seleucid line of 303 is the Hindu Kush.
 · **The Danube is not the Ottoman frontier in 1683**, which is where the
   contract expected to find it. In 1683 the Ottomans hold all of Hungary and
   the river is an interior road; after Karlowitz the corpus draws Wallachia and
   Moldavia as Ottoman, so the northern line is the Carpathians. The Danube is
   declared where it really is a frontier: Rome at −30/117/300, Byzantium at
   476/565/632/1025/1090, and the Ottomans at 1450, before Mohacs.
 · **Rome 117 still has no Agri Decumates.** The corpus draws the limes as the
   Rhine to Basel and a chord to the Danube; the real 117 frontier leaves the
   river at Rheinbrohl and cuts overland to Eining. Declaring the river between
   the authored endpoints does not re-adjudicate the extent, and re-adjudicating
   it is a data decision for a later round.
 · **Russia at 1858 gets Aigun but not Peking.** The keyframe holds 1858–1899
   and now carries the Amur's left bank; the Ussuri region only becomes Russian
   on the map at the 1900 keyframe, so Primorye is drawn Qing for 1860–1899.
   Fixing that wants a keyframe at 1860, not a declaration.
 · **A declaration needs an authored vertex to attach to.** Four rings gained
   anchors (Russia 1900, the USSR, the PRC, the Mamluks) and the authoring cap
   in `nations.test.ts` went from 80 vertices to 84. That is the format's one
   real awkwardness: the endpoints are where the frontier starts and stops
   following the feature, and the ring has to have a vertex near each.
 · **Andorra is a judgement, not a tolerance.** France and Spain share two arcs
   because Andorra sits between them, so the Pyrenees declaration reads
   `FRA-ESP + AND-ESP` and puts Andorra on the French side — the co-principality
   descends from the Counts of Foix. Writing it as a wider join tolerance would
   have hidden the choice.

## Round 63: modern India, and the two layers that never compared notes

The reader, after five rounds of this: *"try to figure out what to do with maps.
Because it's still full of mistakes even after so many tries. For example modern
India."*

**What modern India actually showed.** The Republic of India was one keyframe at
1960 whose extent was eighty hand-drawn points, and six of them were its entire
northern frontier: (70,28) → (74,33) → (78,35) → (81,30) → (85,28) → (88,27).
Measured against Natural Earth's India, that ring covered **76% of Bangladesh,
70% of Nepal, 16% of Pakistan and 16% of Bhutan**, and left 337 000 km² of India
outside itself — including a wedge of West Bengal between its two pieces, so the
delta showed a triangular hole with a green wash on either side of it. Its
second ring was drawn *around Bangladesh*, which was East Pakistan for the first
twenty-four years the polity is on the globe and has never been Indian. The same
sentence for the others: the PRC's ring held a quarter of Mongolia, 28% of
Kyrgyzstan and 12% of Vietnam; the United States' 1900 ring missed the Alaska
panhandle (54 713 km²), south Florida below Lake Okeechobee (35 215 km²) and
Hawaii.

And after 1992 all of this is drawn UNDER Natural Earth's surveyed frontiers,
because round 57 put the modern states on the globe as ink. So the map contained
its own contradiction: the Nepalese border inked across the middle of a green
wash that claimed Nepal, and the wash's own edge — a ruled line over the
Himalaya — with no ink on it at all, because `frontierInkPlan` correctly makes a
polity give up its frontier while the modern set is on. **Two political layers,
built from different data, drawn at the same instant, never once compared.**

**Why no validator saw it.** Every check in this pipeline judges one layer.
Overlap judges polities against each other — and India overlapped nobody,
because Nepal and Bangladesh are not polities. The shared-frontier ink check
judges a frontier against itself. The modern set is checked against its own
merge table. Nothing asked the fills and the frontiers whether they were
describing the same borders, and in the era where the answer is not in doubt
they were 14% (India), 15% (PRC) and 44% (USA) in agreement.

**The fix: an extent that IS the modern map.** Round 59's insight was that a
hand-authored FRONTIER is a dozen guessed points and no pipeline can add truth
to a guess, so a frontier should declare the feature it follows. Round 63 takes
that to the whole EXTENT. A keyframe can now say

    { "time": 1947, "countries": ["IND"] }

and `countryExtent` (scripts/follows-lib.mjs) builds it from the *union* of those
states in `countries-50m.json` — the topology the modern-border ink is built
from and the file `land-50m.json` is cut from. Fill, frontier and coast are then
one geometry rather than three opinions, by identity rather than by care, which
is the same argument round 52 made about the sea and round 57 made about shared
arcs. It is resolved at the top of `clip-nations.mjs` beside `follows`, so the
clip, the frontier rules, the contested carve and the codec never learn where a
ring came from.

Four extents converted, and only four, because the declaration is honest only
where a polity's extent really is a union of present borders:

 · **india** from 1947 — `IND`. Off today's India by Sikkim (annexed 1975) and
   Goa (1961), 0.34% of the country between them.
 · **prc** from 1949 — `CHN`.
 · **usa** at 1900 — `USA`. Every acre of the fifty states was American in 1900
   (Alaska 1867, Hawaii 1898, the contiguous line closed in 1853), so one
   keyframe is right for 1900 and for 2024, which is the year it is still held
   at.
 · **ussr** — the fifteen republics. Its external border from 1945 to 1991 is
   still somebody's border today, so the union is the Soviet outline exactly,
   with the internal republic lines dissolved by the union operation.

**UNION, not concatenation**, and that is not a detail: two adjacent countries in
one topology share an arc, and simply listing both polygons leaves that arc
inside the extent where `classifyCoastal` would find an edge that is not coast,
call it inland frontier and INK it. The USSR would have shipped with the borders
of its fifteen republics drawn across it.

**The antimeridian, which is where the first version was wrong.** Natural Earth
does not split Russia at 180°: its mainland ring walks (179.87, 69.26) →
(-180, 68.98) → (-179.80, 68.94). A planar clipper reads that step as a
360°-wide edge, so the union of the fifteen republics came out as a BAND ROUND
THE PLANET at 65-71° N, and the clip to land kept every piece of land inside it
— the USSR held northern Alaska and the Canadian Arctic, convicted by the
overlap validator at 240 km wide. `splitAntimeridian` unwraps each ring into
continuous longitudes and cuts it at each 360° window.

**The new validator, and the number it prints.** `modernInkAgreement`
(scripts/nations-clip-lib.mjs) walks every polity keyframe in force inside the
modern window, takes its INLAND edges — the coast is the map's own line and the
modern payload contains no coast at all — and asks how far each is from a line
the modern layer draws. Distance is to the nearest SEGMENT rather than the
nearest vertex, because a hand-authored zone boundary is two points per hundred
kilometres and the answer must be a property of the border rather than of how
finely somebody digitised it; both ends and the midpoint of each fill edge are
probed, because testing only vertices would pass a frontier drawn as one edge
from Punjab to Assam. A contested zone's boundary is a second index the edge is
allowed to be near instead: Natural Earth does not draw the Line of Control,
which is what makes it contested.

    fill against ink — inland frontier a polity draws in 1992+
      polity      inland km      off ink            on ink
      usa       18 593 → 10 279  10 457 → 0   43.8% → 100.0%
      prc       15 561 → 17 300  13 189 → 0   15.2% → 100.0%
      india      9 532 →  8 708   8 194 → 0   14.0% → 100.0%

`MODERN_INK_TOL_KM` is 25 km (a disagreement between two 1:50m layers, not a
survey) and `MODERN_INK_OFF_BUDGET_KM` is 200 km of frontier per polity, in
kilometres rather than as a share for the reason round 55 gave about the overlap
epsilon. It runs in `--check`, off the two shipped files, so `npm run build`
enforces it.

**Two frontier rules changed direction, and both changes are the same lesson:**
a rule written when both extents were hand-drawn can become a rule that lets a
guess cut a survey.

 · `prc` yielded to `france` for Tonkin. French Indochina is a hand-drawn ring
   that runs 26 km up into Yunnan, and the PRC's keyframe holds to 2100 — so a
   colony that ended in 1954 was taking a bite out of China in 2024. **France
   yields now**, from 1949.
 · `japan` would have yielded to `ussr` at the Tumen mouth (600 m over less than
   a square kilometre). **The USSR yields instead**, the other way round from
   the rule beside it, because Japan's 1910 keyframe IS the Korean Empire's ring
   vertex for vertex and a difference operation would end that.

**What it cost.** Authored vertices 45 379 → 45 482 (the four extents are three
lines of JSON where they were 293 points). Shipped corpus 130 628 vertices,
1 257 kB against 1 160 kB. Worst year on the globe 1950: 16 257 → 23 864 cap
vertices, +47%, which is what it costs to draw the Soviet Union's real coastline
and Xinjiang's real frontier instead of a chord; draw calls at the 2024 cameras
are unchanged.

**Honest limits, written down rather than shipped quietly.**

 · **Sikkim and Goa are inside India from 1947.** Natural Earth has no unit for
   either, so drawing India without them wants hand geometry, which is the
   disease. Together 10 798 km², 0.34% of the country, and under two pixels at
   any camera the globe offers.
 · **Hong Kong and Macao are not in the PRC's fill**, because they are separate
   NE units. 1 052 km² between them; their lines are already drawn across the
   whole window (round 57's limit, unchanged).
 · **The interwar USSR is still the post-war USSR.** One keyframe holds from
   1922, as it did before this round: no Baltics, no Moldova, no western Ukraine
   or Belarus, no Tuva and no Kaliningrad until 1940-45. Drawing that wants a
   1922 keyframe with hand geometry for Poland's eastern border, not a
   declaration.
 · **`countries` is not a way to draw an empire.** The British Empire is a union
   of forty modern states at forty different dates, and `britain` and `france`
   after 1900 are still freehand — which is where the next reader-visible error
   in this era is.
 · **The modern layer still draws 190 countries with no fill and three with
   one.** That is round 57's decision (a hundred and ninety-five polities would
   be a different app) and this round did not revisit it, but it is what a
   reader is looking at when they say a modern map looks odd: India, China and
   the United States are washed and their neighbours are paper.
