<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, useTemplateRef, watchEffect } from 'vue'
import Globe, { type GlobeInstance } from 'globe.gl'
import {
  AmbientLight,
  DirectionalLight,
  DoubleSide,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
  type Mesh,
  type Object3D,
  type SphereGeometry,
} from 'three'
import { useEventStore } from '../stores/events'
import { useNationStore, type BorderEntry } from '../stores/nations'
import { useTimeStore } from '../stores/time'
import { useSettingsStore } from '../stores/settings'
import { useViewStore } from '../stores/view'
import { featureOf, type HistoricalEvent } from '../lib/events'
import { AREA_CAP_RESOLUTION_DEG, ROUTE_FLOW_INTERVAL_MS, areaCapRing } from '../lib/paths'
import type { Drawing } from '../lib/drawing'
import { DrawingLayer, SURFACE_ALT } from '../lib/drawingLayer'
import { FrontierLayer, inkPathsOf } from '../lib/frontierLayer'
import type { Ring } from '../lib/nations'
import { hatchMaterial, hatchTone } from '../lib/hatch'
import type { ContestedRing } from '../lib/contested'
import { GlobeSurface } from '../lib/globeSurface'
import { RenderPump } from '../lib/renderPump'
import { firstFrame } from '../lib/firstFrame'
import { AtmosphereLayer } from '../lib/skyLayer'
import {
  DetailImagery,
  IMAGERY_ERA_FROM,
  IMAGERY_PLAN,
  singleSourcePlan,
  visibleSpanDeg,
  viewSpanDeg,
  minAltitudeFor,
} from '../lib/detailImagery'
import { DRAWN_ERA_FROM, DRAWN_Z_MAX, DrawnTiles } from '../lib/drawnSource'
import { cloudFadeFor, cloudSharpenFor, cloudIdleIntervalMs } from '../lib/scale'
import { CelestialLayer } from '../lib/celestialLayer'
import { eraPlan, modernShare } from '../lib/paleo'
import { subsolarLongitude, cityLightsFactor } from '../lib/sun'
import { pinElement, clusterElement } from '../lib/eventPins'
import {
  clusterHolds,
  COASTAL_INK,
  CONTESTED,
  frontierInkPlan,
  NATION_FILL_ALPHA,
  onGround,
  pinStateKey,
  pinTier,
  resolveGlobeStyle,
  resolveSelectionInk,
  type RenderMode,
} from '../lib/present'
import {
  clusterEvents,
  clusterSpanBucket,
  fanViewFor,
  layoutPins,
  legStrokeDeg,
  LEG_ARC,
  type ClusterLeg,
  type FanView,
  type PinDatum,
} from '../lib/eventClusters'
import { cameraScope, sameScope } from '../lib/viewport'
import { stableByKey } from '../lib/stableIdentity'
import type { Tier } from '../lib/eventTiers'
import { primaryTag, tagColor } from '../lib/tags'
import {
  DRAWN_TEXTURE,
  MODERN_TEXTURE,
  NIGHT_TEXTURE,
  RELIEF_TEXTURE,
  SKY_TEXTURE,
  framesFor,
} from '../data/paleoTextures'

const events = useEventStore()
const nations = useNationStore()
const time = useTimeStore()
const settings = useSettingsStore()
const view = useViewStore()
const el = useTemplateRef('el')

/**
 * THE LOOK, resolved once and read everywhere below.
 *
 * Nothing in this file reads `settings.clouds`, `settings.relief`,
 * `settings.detail`, `settings.visuals` or `settings.palette` any more — those
 * are what the reader asked for, and this is what the renderer does about it
 * (see lib/present/globe.ts). The indirection is what lets map mode exist
 * without a second copy of every expression below.
 */
const style = computed(() => resolveGlobeStyle(settings, settings.mode))
/**
 * The base-texture timeline this mode reads: the photographed planet's, or the
 * same deep-time frames ending in the drawn world (data/paleoTextures.ts).
 * Everything downstream — the crossfade, the retention window, the relief fade,
 * the paper grade — goes through this one value, so the two modes cannot
 * disagree about which frame is on screen.
 */
const frames = computed(() => framesFor(style.value.base))
/** The mode alone, for the pin and ink resolvers. */
const mode = computed<RenderMode>(() => settings.mode)
/**
 * Has the planet been on screen long enough to be given a sky?
 *
 * The first frame does without the starfield, the night map and the relief (see
 * the tick); this is what tells the background watcher that the deferred half
 * may start.
 */
const starsReady = ref(false)

let globe: GlobeInstance | undefined
let surface: GlobeSurface | undefined
let celestial: CelestialLayer | undefined
let atmosphere: AtmosphereLayer | undefined
let detail: DetailImagery | undefined
/**
 * The drawn map's rasterizer, built the first time map mode is entered and kept
 * after that. Lazy on purpose: it spawns a worker and pulls 1.1 MB of vector
 * data, and the app opens on the photographed globe.
 */
let drawnTiles: DrawnTiles | undefined
/** …and its plan, held rather than rebuilt: `setPlan` compares by identity. */
let drawnPlan: ReturnType<typeof singleSourcePlan> | undefined
/**
 * The starfield sphere three-render-objects owns, and what we want of it.
 *
 * See the background watcher: the library's only handle on a background is a
 * URL, and passing it again reloads the texture, so map mode used to buy the
 * whole 4096x2048 starfield again every time the reader came back. The sphere
 * itself is a direct child of the render root and is identified by what it is —
 * a mesh whose sphere is orders of magnitude wider than the planet — rather
 * than by a name the library does not give it.
 */
let skyMesh: Object3D | undefined
let skyLoaded = false
let starsWanted = true
/** The authored battle plan of the item in focus mode; nothing otherwise. */
let drawing: DrawingLayer | undefined
/** Nation frontiers — the inland edges only; see lib/frontierLayer.ts. */
let frontiers: FrontierLayer | undefined
/** The selected event's routes and their terminus dots. */
let routes: DrawingLayer | undefined
let resizeObs: ResizeObserver | undefined
let raf = 0
/**
 * Is a `pointOfView` flight in the air? Read only by the cancel-on-gesture
 * handler, so that grabbing a globe nobody is flying costs nothing.
 */
let flying = false
/** The flight's own timer, so a second request supersedes the first cleanly. */
let flyTimer = 0
const stops: (() => void)[] = []
/** How long a "look at this" flight runs, in ms. */
const FLY_MS = 900

type EventAreaEntry = {
  kind: 'area'
  event: HistoricalEvent
  ring: Ring
  /** GeoJSON Polygon `coordinates`, closed — held, like the entry itself. */
  coordinates: Ring[]
}
type PolyEntry = BorderEntry | EventAreaEntry | ContestedRing

/** What the polygon layer was last given; see the watcher that fills it. */
let lastPolys: PolyEntry[] = []
/**
 * …and what the ink layer was last given on top of them: the modern states,
 * nought or one entry. Held apart from `lastPolys` because it is not a polygon
 * — it never reaches the cap layer, has no fill and nothing to click.
 */
let lastModern: BorderEntry[] = []
/** …and the mode its stroke colours were resolved for. */
let lastInk: RenderMode | undefined

const asPin = (d: object) => d as PinDatum
const asLeg = (d: object) => d as ClusterLeg
const asPoly = (d: object) => d as PolyEntry

/**
 * The cap material for a polygon: one per colour, held for the app's life.
 *
 * Held rather than made per datum because three-globe compares the material by
 * identity on every digest and a fresh object would swap the material on every
 * border, every time the list is re-set. There are a handful of tag colours and
 * one blank (the borders' invisible cap), so the map never grows past ten.
 */
const capMaterials = new Map<string, MeshBasicMaterial>()
const capMaterial = (color: string, opacity: number): MeshBasicMaterial => {
  const key = `${color}|${opacity}`
  let m = capMaterials.get(key)
  if (!m) {
    m = new MeshBasicMaterial({
      color: color || '#000000',
      transparent: true,
      opacity: color ? opacity : 0,
      // The whole point: see the comment on `polygonCapMaterial`.
      depthWrite: false,
      // Both faces, like the layer's own default. A cap is earcut in lat/lng and
      // some of its triangles come out wound the other way; culling backfaces
      // punches black diamonds in the middle of a footprint (it did, over the
      // Atlantic). The rest of the material is what three-globe would have built
      // anyway — it is unlit Basic there too.
      side: DoubleSide,
      // …but ONE PASS of both faces, not three's two.
      //
      // A transparent DoubleSide material is rendered twice by three: back faces
      // first, then front faces, so that the two layers of a hollow shell blend
      // in the right order (WebGLRenderer.renderObject). Each of those passes
      // sets `material.needsUpdate = true` to flip `side`, and that invalidation
      // makes `setProgram` re-derive the material's parameters and rebuild a
      // fifty-field program cache key — to find the program it already had.
      //
      // A cap is not a shell. It is a single sheet lying on the sphere, so every
      // triangle of it faces the camera or faces away, never both: the back pass
      // and the front pass draw disjoint sets of triangles that together are
      // exactly what one DoubleSide pass draws, in the same place, blended the
      // same number of times. The ordering the two passes buy is ordering
      // between faces that cannot overlap.
      //
      // Measured on a scripted world-view pan (tests/e2e/framePerf.e2e.mjs),
      // 121 polities in 1941: 247 draw calls a frame → 129, and 242 material
      // invalidations a frame → 0. The picture is the same picture — the same
      // page photographed with the flag off differs by 53 596 pixels of 750 000,
      // against 55 542 for the same page photographed twice with it on.
      forceSinglePass: true,
      // …and the same depth bias every other overlay carries (`groundBias` in
      // lib/drawingLayer.ts). This is the rest of the area-smudge fix, and the
      // half that survived `polygonsTransitionDuration(0)`.
      //
      // Height alone cannot separate these layers. The cap sits at 0.0014 R and
      // the borders at 0.0012 R — 1.3 km apart — while one step of a 24-bit
      // depth buffer is ~2.7 km of altitude at world view (the arithmetic is
      // written out above SURFACE_ALT). So the cap, the stroke and the planet
      // land in the SAME depth value over most of the zoom range, and which one
      // wins is then decided by rounding: it changes per pixel, and it changes
      // again the moment the camera moves. That is the ragged edge that
      // "smudges" across a pan, and it is worse, not better, on a device with a
      // 16-bit depth buffer — which is why it outlived a fix that only stopped
      // the cap being built coplanar, and why a software rasteriser here shows
      // it faintly if at all.
      //
      // Polygon offset biases in depth-buffer UNITS, so it is exactly as big as
      // it needs to be at every zoom, and four units is nothing against the ~2R
      // of depth between the near face of the globe and the far one — the
      // planet still hides the areas round the back.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    })
    capMaterials.set(key, m)
  }
  return m
}

/**
 * …and the hatched one, for a contested zone. Held on exactly the same terms
 * and in the same map, so `dispose` frees them together: one material per pair
 * of stripe colours per mode, of which there are two on the whole globe today.
 * See lib/hatch.ts for why this is a patched `MeshBasicMaterial` and not a
 * `ShaderMaterial` of its own.
 */
const hatchCapMaterial = (a: string, b: string, opacity: number): MeshBasicMaterial => {
  const key = `hatch|${a}|${b}|${opacity}`
  let m = capMaterials.get(key)
  if (!m) capMaterials.set(key, (m = hatchMaterial(a, b, opacity)))
  return m
}

/**
 * Clustering runs off a *quantised* span: zoom fires continuously, and
 * regrouping (which rebuilds every pin element) on each frame would both cost
 * and flicker. See lib/eventClusters.ts.
 */
const clusterSpan = computed(() => clusterSpanBucket(visibleSpanDeg(view.altitude)))
const groups = computed(() => clusterEvents(events.visible, clusterSpan.value))

/** The frame the camera actually shows — what a fan is measured against. */
const liveFan = (): FanView =>
  // CSS pixels, not device pixels: the fan is measured against the pins, and a
  // pin is 24 CSS px wide whatever the display's ratio
  fanViewFor({
    altitude: view.altitude,
    fovDeg: view.fov,
    widthPx: view.viewportWidthPx,
    heightPx: view.viewportPx,
  })
/** Stands in when nothing is fanned; layoutPins never reads it then. */
const NO_FAN: FanView = { degPerPx: 0, heightPx: 1, widthPx: 1 }

const layout = computed(() =>
  layoutPins(groups.value, {
    expandedId: events.expandedClusterId,
    selectedId: events.selectedId,
    // The live view is read *only* while a cluster is open. Vue tracks
    // dependencies per run, so with nothing fanned this computed does not
    // depend on the altitude at all and a zoom cannot invalidate the layout —
    // which is what keeps a plain zoom from rebuilding every pin.
    fan: events.expandedClusterId ? liveFan() : NO_FAN,
  }),
)

/**
 * Pin identity, held across layouts.
 *
 * The globe's HTML layer joins data by *object identity*: a datum it has seen
 * before keeps its element and is merely repositioned, a new one is built from
 * scratch. Handing it a fresh `{...p}` every time — which is what this used to
 * do — therefore rebuilt every pin element on every layout change, and a zoom
 * changes the layout several times on its way in. Reusing one object per pin
 * state (see pinStateKey) means a zoom that leaves the same events on screen
 * rebuilds nothing; the elements are cached by the same key for the case where
 * the globe does ask again.
 */
type KeyedPin = PinDatum & { key: string; tier: Tier; highlighted: boolean }
const pinData = new Map<string, KeyedPin>()
const pinEls = new Map<string, HTMLElement>()

/**
 * Is this pin one the open step asked to be lifted? See `Step.highlights`.
 *
 * A BADGE counts if any of the pins it swallowed is one: at the zoom an
 * saga is fitted to, a named child is usually inside a cluster rather than
 * standing on its own, and a highlight nobody can see is not a highlight.
 */
const isHighlighted = (p: PinDatum) =>
  p.kind === 'cluster'
    ? p.members.some((m) => events.highlightedIds.includes(m.id))
    : events.highlightedIds.includes(p.event.id)

const stablePins = (pins: PinDatum[], tiers: ReadonlyMap<string, Tier>, selectedId?: string): KeyedPin[] =>
  stableByKey<PinDatum, KeyedPin>(
    pinData,
    pins,
    (p) => pinStateKey(p, selectedId, pinTier(p, tiers), mode.value, isHighlighted(p)),
    (p, key) => ({ ...p, key, tier: pinTier(p, tiers), highlighted: isHighlighted(p) }),
    // the elements are cached by the same key; a pin that leaves takes its node
    (key) => pinEls.delete(key),
  )

const legData = new Map<string, ClusterLeg>()
/**
 * Legs, held for the reason pins are: while a fan is open, the arc layer must
 * move its arcs rather than rebuild them.
 *
 * This used to refresh the four coordinates by name and leave `event` alone.
 * Going through the shared helper copies the whole leg, which is the correct
 * behaviour and not merely the tidier one — a held leg with a stale `event` is
 * the same bug the pin cache already carries a scar from.
 */
const stableLegs = (legs: ClusterLeg[]): ClusterLeg[] =>
  stableByKey<ClusterLeg, ClusterLeg>(legData, legs, (l) => l.id, (l) => ({ ...l }))

// Only the selected event's area draws as a polygon: overlapping region fills
// used to smother the planet. Unselected area events are pins like the rest.
//
// Held by event id for the same reason borders are (see lib/nations.ts): the
// polygon list is rebuilt whenever anything on it changes, and an entry the
// layer does not recognise costs a rebuilt mesh and a re-tessellated cap.
const areaEntries = new Map<string, EventAreaEntry>()
/**
 * At most one entry, and it is read from `events.selected` rather than found in
 * `events.visible`.
 *
 * This runs inside the polygon watcher, so whatever it reads is what invalidates
 * that watcher — and `visible` is the most volatile thing in the app: it is
 * requeried whenever the selected span, the tag filter or the loaded event count
 * changes. Dragging a selection handle therefore re-ran the polygon layer's
 * whole rebuild-and-compare (~30 times across one drag) to discover that the
 * selected event's footprint had not moved. `selected` changes when the user
 * selects something, which is the only thing that can change this list.
 *
 * It also drops the "and it is inside the visible window" condition, which is
 * the behaviour EventPanel already has: while the panel is open on an event, its
 * footprint is drawn, whether or not the timeline window still reaches it.
 */
const eventAreas = (): EventAreaEntry[] => {
  const e = events.selected
  // only an event has a footprint; a person or a concept is an article
  if (e?.kind !== 'event') return []
  const area = featureOf(e.location, 'area')
  if (!area) return []
  // A drawing supersedes the footprint it is drawn inside. The area cap is a
  // tinted sheet over a whole theatre, and a battle plan read through it is a
  // battle plan read through a filter — the frontlines lose contrast against
  // exactly the ground they are about. While the plan is up, the footprint
  // steps aside; leaving the mode brings it back.
  //
  // The condition is exactly "the ink on the ground is THIS event's" — see
  // `focusDrawing` (stores/events.ts), which since round 60 resolves to the
  // selection's drawing when nothing is focused. Two readings of one rule would
  // be a cap that hides under no plan, or a plan read through a cap.
  if (e.drawing && (!events.focus || events.focus.itemId === e.id)) return []
  const held = areaEntries.get(e.id)
  if (held) return [held]
  const ring = area.ring
  // The cap gets the ring densified onto great circles, not the authored one:
  // see `areaCapRing`. The outline keeps `ring` — the DrawingLayer densifies it
  // to its own, finer resolution.
  const entry: EventAreaEntry = { kind: 'area', event: e, ring, coordinates: [areaCapRing(ring)] }
  areaEntries.set(e.id, entry)
  return [entry]
}

/**
 * The clock the two continuous animations read — the cloud deck's drift and the
 * flow down a one-way route.
 *
 * Pinnable, and only in a development build. Both animations repaint most of the
 * globe every frame by design, which makes them indistinguishable from a
 * rendering fault when two frames are compared: the honest test for "does this
 * edge move when nothing about the scene moved" needs two frames of an
 * identical scene, and it cannot have one while the clouds are turning and the
 * dashes are marching. Setting `__freezeClock` to a timestamp holds both still
 * without touching either animation's own logic, so what a frame diff then sees
 * is geometry and depth and nothing else.
 */
const animationClock = (now: number): number => {
  if (!import.meta.env.DEV) return now
  const frozen = (window as unknown as { __freezeClock?: number }).__freezeClock
  return typeof frozen === 'number' ? frozen : now
}

/**
 * The marks the selected event puts on the map — its routes, the outline of its
 * footprint and the sites it names — on exactly the same terms: drawn while the
 * panel is open on it, gone when it closes.
 *
 * WHAT they are is `resolveSelectionInk` (lib/present/ink.ts), a pure function of
 * the event and the mode. What is left here is the CACHE: the layer's own key
 * comparison wants a stable object to stringify, and a re-selected event should
 * not be re-smoothed. Keyed by mode as well as id, because the two modes resolve
 * to different ink and a held object from the other one would be stale.
 */
const selectionSpecs = new Map<string, Drawing | undefined>()
const selectionDrawing = (): Drawing | undefined => {
  const sel = events.selected
  if (sel?.kind !== 'event') return undefined
  const key = `${mode.value}:${sel.id}`
  if (!selectionSpecs.has(key))
    selectionSpecs.set(key, resolveSelectionInk(sel, { mode: mode.value }))
  return selectionSpecs.get(key)
}

onMounted(() => {
  const dom = el.value!
  const base = import.meta.env.BASE_URL
  // One read of the motion preference: the cloud drift, the arrival ramps and
  // the running dashes on a drawn route all obey it, and the dash rate has to be
  // known when the layer is configured, below.
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  globe = new Globe(dom)
    // Flat black to start with, and the starfield later — see the first-frame
    // block in `tick`. Pure black on purpose: it is the colour the sky texture
    // is 94% made of, so when the stars land they *appear* rather than the field
    // behind them changing shade.
    .backgroundColor('#000000')
    .width(dom.clientWidth)
    .height(dom.clientHeight)
    // events layer: HTML pins, coloured by the event's primary tag. Area events
    // get the footprint pin; their polygon only draws when selected. Co-located
    // events arrive here already collapsed into cluster badges.
    .htmlLat((d) => asPin(d).lat)
    .htmlLng((d) => asPin(d).lng)
    .htmlAltitude(0.006)
    .htmlTransitionDuration(0)
    .htmlElement((d) => {
      const p = asPin(d)
      const tier = (d as KeyedPin).tier ?? 1
      const highlighted = (d as KeyedPin).highlighted ?? false
      const key =
        (d as KeyedPin).key ?? pinStateKey(p, events.selectedId, tier, mode.value, highlighted)
      const held = pinEls.get(key)
      if (held) return held
      const el =
        p.kind === 'cluster'
          ? clusterElement(
              p.members,
              // A STACK THAT HOLDS THE OPEN EVENT IS DRAWN SELECTED — which
              // today is never, because `layoutPins` lifts the open event out of
              // its badge and draws it on its own coordinates (lib/
              // eventClusters.ts). The question is asked here anyway, through
              // the same helper `pinStateKey` uses so the two cannot disagree,
              // because the badge is the only mark left standing on the reader's
              // open event if that lift ever stops happening.
              {
                mode: mode.value,
                tier,
                highlighted,
                selected: clusterHolds(p.members, events.selectedId),
              },
              // the live span, not the quantised one: it is compared against
              // the live span on the next zoom
              () => events.expandCluster(p.id, visibleSpanDeg(view.altitude)),
            )
          : pinElement(
              p.event,
              {
                mode: mode.value,
                tier,
                selected: events.selectedId === p.event.id,
                highlighted,
              },
              () => events.select(p.event.id),
            )
      pinEls.set(key, el)
      return el
    })
    .htmlElementVisibilityModifier((el, visible) => {
      el.style.opacity = visible ? '1' : '0'
      el.style.pointerEvents = visible ? 'auto' : 'none'
    })
    // arcs layer: the legs of an expanded cluster — straight leader lines from
    // the stack's spot out to each member, so a fanned pin still reads as
    // belonging to where it came from. Flat, in the pin plane, and untweened:
    // see LEG_ARC in lib/eventClusters.ts for why all three matter.
    .arcStartLat((d) => asLeg(d).startLat)
    .arcStartLng((d) => asLeg(d).startLng)
    .arcEndLat((d) => asLeg(d).endLat)
    .arcEndLng((d) => asLeg(d).endLng)
    .arcColor((d: object) => {
      const c = tagColor(primaryTag(asLeg(d).event))
      // fades in over the first stretch, so a dozen legs meeting at one point
      // do not paint a blob where the stack is
      return [c + '10', c + 'cc']
    })
    .arcStartAltitude(LEG_ARC.startAltitude)
    .arcEndAltitude(LEG_ARC.endAltitude)
    .arcAltitude(LEG_ARC.altitude)
    // the legs are measured on screen like the fan they belong to; the layer is
    // only ever re-digested while a fan is open, which is when this changes
    .arcStroke(() => legStrokeDeg(liveFan()))
    .arcsTransitionDuration(LEG_ARC.transitionMs)
    // polygons layer: nation borders + the selected event's area
    // The coordinate array comes from the entry rather than being built here:
    // three-globe re-tessellates the cap whenever this is a different array
    // object than last time, whatever the numbers in it say.
    .polygonGeoJsonGeometry((d) => ({
      type: 'Polygon',
      coordinates: asPoly(d).coordinates as unknown as number[],
    }))
    // Borders read as a drawn line, not a wash of colour. The border cap is
    // fully transparent on purpose — a tinted cap over a whole nation is a wash
    // of colour where a border wants to be a drawn line — and the invisible cap
    // is still what catches hover and click for the label.
    //
    // The MATERIAL is ours rather than three-globe's, for one reason:
    // `depthWrite`. Left to itself the layer builds caps that write depth, so
    // every nation on the planet had an invisible pane of glass 25 km over it,
    // and anything grounded under one vanished — with the overlays moved down to
    // SURFACE_ALT that was the whole Barbarossa plan except the stretches of
    // front that happened to lie over water. A cap contributes nothing to depth
    // that the globe underneath it has not already contributed, so it no longer
    // claims any. In every other respect it is what the layer would have built.
    .polygonCapMaterial((d) => {
      const p = asPoly(d)
      // A POLITY IS NOW A WASH, not an empty outline, and it has to be: three
      // quarters of a clipped polity's boundary is coastline, which the drawn
      // map inks itself and this layer therefore does not (see
      // lib/frontierLayer.ts). Leave the cap invisible and Japan — all coast,
      // no frontier — would have nothing on the map at all. The wash is what
      // says how far a polity reached where no frontier is drawn, and because
      // the geometry was cut against the map's own coastline it now stops
      // exactly at the shore. Faint on purpose: a border is still a drawn line,
      // and the fills of two neighbours must not read as a third colour where
      // they meet. They cannot overlap any more — the build refuses to ship an
      // overlap — so the alpha never compounds.
      if (p.kind === 'area') return capMaterial(tagColor(primaryTag(p.event)), 0.22)
      // …and a contested zone is the one fill on this globe that is not a wash
      // in one colour, because there is no one colour it could honestly be. It
      // is hatched in its claimants' — the ground-fixed shader stripe in
      // lib/hatch.ts — and a claimant with no fill anywhere on the map lends a
      // neutral tone instead of a colour nothing else on the globe wears.
      if (p.kind === 'contested')
        return hatchCapMaterial(
          onGround(hatchTone(p.hatch[0], 0), { mode: mode.value }),
          onGround(hatchTone(p.hatch[1], 1), { mode: mode.value }),
          CONTESTED.fill[mode.value],
        )
      return capMaterial(onGround(p.nation.color, { mode: mode.value }), NATION_FILL_ALPHA[mode.value])
    })
    // No side colour at all, rather than a transparent one: three-globe reads
    // this as "no sides" and builds the cap alone, which is one fewer mesh and
    // one fewer wall of triangles per ring for something that was drawn at zero
    // opacity anyway. The invisible *cap* stays — it is the hover/click target.
    .polygonSideColor(() => '')
    // No stroke on an event footprint — its outline is a fat line in the
    // DrawingLayer now (see `areaOutlineFor`). three-globe strokes a polygon
    // with GL_LINES, and there is no polygon offset for line primitives in
    // WebGL, so that stroke could only ever be held off the planet's depth
    // value by ALTITUDE: 8.9 km against a depth quantum of ~2.7 km at world
    // view, which is not a separation, and it flickered along its own length as
    // the camera moved. That is the smudge that outlived both earlier fixes.
    //
    // A nation border is the same primitive with the same exposure, and it is
    // deliberately NOT moved here: a border is drawn for every polity on the
    // globe at once rather than one selection at a time, so rebuilding them as
    // fat lines is a different size of change and a different risk. Nothing was
    // reported against them — they are thinner, unfilled, and never sit under a
    // tinted cap, which is where the artefact was legible — so they keep the
    // layer's stroke and the exposure is written down instead of guessed at.
    // A nation colour was chosen against Blue Marble and is often pale — Sumer
    // is #b09a72, which measures 1.05:1 against the drawn map's land tone, i.e.
    // gone. `onGround` takes it toward the map's own pen on paper and leaves it
    // alone on the photograph. See lib/present/ink.ts.
    // NO stroke on anything in this layer any more. An event footprint's
    // outline has been a fat line in the DrawingLayer for several rounds; a
    // nation's has just joined it in the FrontierLayer, because a closed loop is
    // the one thing three-globe's stroke can draw and a clipped polity needs
    // three quarters of its loop left undrawn.
    .polygonStrokeColor(() => '')
    // Down near the ground, for the reason everything else is (SURFACE_ALT in
    // lib/drawingLayer.ts): at 0.004 a border slid 63 px against its own
    // coastline across a close frame. Not all the way down, though — three-globe
    // tessellates a cap and its stroke at `polygonCapCurvatureResolution`
    // degrees, and a 5° chord sags 6.1 km below the sphere, so a border much
    // under 0.0012 R (7.6 km) would be swallowed by the planet between its own
    // vertices. The footprint sits a hair above the borders, as it always did,
    // and the routes drawn over it still win: nothing in the polygon layer
    // writes depth any more, so what paints over what is renderOrder, and the
    // DrawingLayer's is twelve against the layer's nought.
    // How finely a cap is broken up, in degrees of arc. The library grids the
    // polygon's INTERIOR at this spacing as well as interpolating its contour
    // (`getInnerGeoPoints`), so it is what bounds the size of a cap triangle —
    // and a triangle's edges are straight chords through space, which pass
    // BELOW the sphere between their ends.
    //
    // At three-globe's default of 5 degrees a chord sags 6.06 km, against the
    // 8.92 km the cap is lifted: a margin of 2.9 km. That is thinner than one
    // depth quantum at world view, and thinner than the globe mesh's own
    // faceting, so on a large footprint the middle of a triangle reaches the
    // planet's own depth and the fill comes back with pieces missing — the
    // "gaps in areas, as if it is clipping the ocean" from the field. It is
    // geometry, not depth precision: it happens on any GPU at any depth width,
    // and it is worst on exactly the largest footprints.
    //
    // Two degrees sags 0.97 km — a margin of 9x rather than 1.3x — and the grid
    // is a quarter of the triangles one degree would cost. That trade matters:
    // the cap is drawn on every frame of every gesture, and at one degree the
    // trans-Atlantic footprint alone put 21k triangles a frame on the ink,
    // which is precisely the per-frame cost a selection is not supposed to add.
    // It is spent only where it is needed: a nation border already comes with
    // vertices a fraction of a degree apart, and an area is one polygon at a
    // time.
    // Both kinds get the same resolution now, and the comment above is why: a
    // 5° chord sags 6.06 km below the sphere against the 8.9 km the cap is
    // lifted, which was tolerable while a nation's cap was invisible and is not
    // now that it is a wash — the sag is exactly the "gaps, as if it is clipping
    // the ocean" defect, and it is worst on the largest polygons, which is what
    // an empire is.
    .polygonCapCurvatureResolution(() => AREA_CAP_RESOLUTION_DEG)
    // A CONTESTED CAP SITS LOWER THAN EVERY OTHER FILL, and it has to: it is
    // the one cap on this globe whose own outline is drawn ON TOP of it rather
    // than beside it. Every cap here carries `polygonOffset` (-2, -4) so that
    // it is not eaten by the planet, and there is no polygon offset for LINE
    // primitives in WebGL — so a line lying exactly on a cap's edge, which the
    // zone's dashes and the modern border along the same boundary both do, is
    // pushed behind it by that bias and disappears. Photographed at Abyei: the
    // three authored edges dashed and the fourth, which is the Sudan/South
    // Sudan line, completely gone. 0.0010 R is 6.4 km, six times the 0.97 km a
    // 2° cap chord sags, so the planet still does not eat it.
    .polygonAltitude((d) =>
      asPoly(d).kind === 'area' ? 0.0014 : asPoly(d).kind === 'contested' ? 0.001 : 0.0012,
    )
    .polygonLabel((d) => {
      const p = asPoly(d)
      return p.kind === 'area' ? p.event.name : p.label
    })
    .onPolygonClick((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') events.select(p.event.id)
    })
    // NO transition, and this is the fix for the reported "smudges along the
    // area's edge while the map moves".
    //
    // three-globe builds a polygon object at scale 1 — altitude ZERO, exactly
    // coplanar with the planet — and only moves it to its real altitude inside
    // the tween's `onUpdate`. That callback runs from three-globe's own
    // animation cycle, which is a separate rAF chain from the renderer's, and
    // which `pauseAnimation` cancels. This app calls `pauseAnimation` every time
    // the render pump parks (lib/renderPump.ts), so the cycle is stopped for
    // most of the app's life and a freshly added polygon can sit at altitude 0
    // for as long as it takes something to resume it — measured at over 2.7 s.
    //
    // At altitude 0 the cap and its stroke are in the same plane as the globe
    // mesh, and the two z-fight: the even tint breaks into ragged patches the
    // shape of the sphere's 4° facets, and the stroke stipples. Move the camera
    // and which patches win changes every frame — the smear the reader sees.
    // Selecting an area event is nearly always accompanied by a camera move
    // ("Show on map" flies for 900 ms), so this is the common case, not a rare
    // one.
    //
    // With the duration at zero, three-globe takes the branch that applies the
    // altitude *synchronously inside the digest*, so a polygon is at its final
    // height on the first frame it exists and is never coplanar with anything.
    // Nothing is lost: every polygon on this globe now lives within 9 km of the
    // ground (see `polygonAltitude` above), so the animation that was being
    // skipped was a 300 ms ramp across about one screen pixel. It also stops the
    // layer creating a Tween per polygon per change, which the same broken cycle
    // was never reliably going to finish.
    .polygonsTransitionDuration(0)
    // NO paths layer. Routes used to be drawn by globe.gl's paths layer, and
    // three separate things were wrong with that:
    //
    //  · it drew them 90 km above the map, so a voyage slid against the ocean it
    //    crossed as the camera turned (see SURFACE_ALT in lib/drawingLayer.ts);
    //  · its dash animation is advanced by three-globe's own FrameTicker, which
    //    globe.gl's `pauseAnimation` cancels — and under frame-on-demand this
    //    app pauses and resumes on nearly every frame, so the dash was
    //    structurally unable to tick (measured: 0.0000 of movement in 4.7 s);
    //  · a route needed two data entries, a "halo" and a "line", to get a
    //    casing, because the layer draws one stroke per datum.
    //
    // All of it now goes through the DrawingLayer, like every other mark this
    // globe puts on its map. See `selectionDrawing` above.
    //
    // clicking bare globe dismisses an open cluster
    .onGlobeClick(() => events.collapseClusters())

  // one material for the planet: era textures, day/night, city lights, clouds
  surface = new GlobeSurface(
    {
      day: MODERN_TEXTURE,
      night: NIGHT_TEXTURE,
      relief: RELIEF_TEXTURE,
      clouds: `${base}textures/clouds.jpg`,
      cloudNrm: `${base}textures/clouds-nrm.webp`,
    },
    globe.renderer(),
  )
  globe.globeMaterial(surface.material)
  /**
   * THE OTHER MODE'S BASE MAP IS NOT AN ERA FRAME, and eviction may not treat
   * it as one.
   *
   * `MODERN_TEXTURE` is safe because it is `urls.day` — the map the globe is
   * made of. `DRAWN_TEXTURE` is exactly as permanent in map mode and was
   * exactly as evictable: leaving map mode moved the era window off it, the
   * sweep disposed it, and coming back re-fetched, re-decoded and re-uploaded
   * 32 MB with a full 4096x2048 mip chain. Pinning is not loading — this costs
   * nothing until something asks for the drawn world.
   */
  surface.pin(DRAWN_TEXTURE)
  // No whole-globe network upgrade: the bundled basemap is already 4096×2048,
  // the same layer and size GIBS would return. Sharper close-up detail comes
  // from the streamed Sentinel-2 patch instead.

  globe.controls().autoRotateSpeed = 0.5
  // dev-only handles so a browser console (or a screenshot script) can drive the
  // camera to an exact point of view and inspect what the streamer is doing;
  // never exist in a production build
  if (import.meta.env.DEV) {
    const w = window as unknown as {
      __globe?: GlobeInstance
      __detail?: DetailImagery
      __setTime?: (t: number) => void
      __surface?: GlobeSurface
      __settings?: ReturnType<typeof useSettingsStore>
      __events?: ReturnType<typeof useEventStore>
      __time?: ReturnType<typeof useTimeStore>
      __view?: ReturnType<typeof useViewStore>
      __nations?: ReturnType<typeof useNationStore>
      __politicalCost?: () => { pieces: number; capVertices: number; frontierSegments: number }
    }
    w.__globe = globe
    // the paleo frames can only be checked against a reference map at a stated
    // age, which means a screenshot script has to be able to name one
    w.__setTime = (t: number) => time.focusTime(t)
    // The surface's own knobs, for A/B screenshots. Poking `material.uniforms`
    // from a console is not equivalent: `advance()` re-applies the cloud
    // uniforms from the settings every frame, so a uniform written from outside
    // is gone by the next tick. These are the setters that stick.
    w.__surface = surface
    w.__settings = settings
    // The stores behind the pins: a screenshot script has to be able to set a
    // selection exactly, and to read back *which* events the camera's scope
    // let through and what tier each was given — neither of which is legible
    // from a picture of a globe.
    w.__events = events
    w.__time = time
    w.__view = view
    // …and the political layer, for the same reason. The vertex budget of the
    // clipped polities is not legible from a picture either: what a screenshot
    // script needs is how many contour vertices the cap layer was handed and
    // how many segments the frontier ink came to, at the exact year and camera
    // the frame was taken at. See docs/design/nations-rework.md.
    w.__nations = nations
    w.__politicalCost = () => {
      let capVertices = 0
      let pieces = 0
      let frontierSegments = 0
      for (const entry of lastPolys) {
        if (entry.kind !== 'full') continue
        pieces++
        for (const ring of entry.coordinates) capVertices += ring.length
        for (const run of inkPathsOf(entry, frontierInkPlan(lastModern, { mode: mode.value }).inkOf(entry)))
          frontierSegments += run.length - 1
      }
      // The modern states, counted apart: they are the other half of the ink in
      // a modern year and nothing at all in a historical one.
      let modernSegments = 0
      for (const entry of lastModern)
        for (const run of entry.frontier) modernSegments += run.length - 1
      return { pieces, capVertices, frontierSegments, modernSegments }
    }
  }

  // CSS2DRenderer stamps a depth-sorted z-index (0..100) on every pin, and its
  // container carries no z-index of its own — so those values used to compete
  // in the root stacking context and paint pins over the panels. Naming the
  // container gives it a z-index from the app's scale (tokens.css), which turns
  // it into a stacking context and traps the 0..100 inside. It is the only
  // class-less div globe.gl puts in the scene container.
  dom.querySelector('.scene-container > div:not([class])')?.classList.add('globe-css2d')

  const radius = globe.getGlobeRadius()
  const cam = globe.camera()
  if (cam instanceof PerspectiveCamera) view.fov = cam.fov
  celestial = new CelestialLayer(globe.scene(), radius, `${base}textures/moon.jpg`)
  atmosphere = new AtmosphereLayer(globe.scene(), radius)
  // Two instances of the same renderer, because they have different lifetimes:
  // routes follow the *selection*, and a battle plan follows *focus mode*. One
  // layer holding both would rebuild the plan whenever a route changed, and a
  // rebuild re-smooths every voyage on it.
  drawing = new DrawingLayer(globe.scene(), radius)
  routes = new DrawingLayer(globe.scene(), radius)
  frontiers = new FrontierLayer(globe.scene(), radius)
  // The renderer is what the atlas needs and all it needs: one immutable 4096
  // texture allocated once, written a slot at a time. There is no per-device
  // pixel cap any more because there is no full-texture upload to size — see
  // fitLevel for what is left of that ceiling.
  detail = new DetailImagery({ renderer: globe.renderer() })
  // dev-only handle, alongside __globe: the streaming pipeline's failures are
  // all "what is on screen now versus a moment ago" questions, and without a
  // way to read the loader's own state a screenshot cannot tell a patch that
  // got sharper from one that got blurrier. Never exists in a production build.
  if (import.meta.env.DEV) (window as unknown as { __detail?: DetailImagery }).__detail = detail
  // the patch only reaches the shader if the loader tells us it arrived
  detail.onReady = () => {
    // a load can resolve after imagery was switched off or the time scrubbed
    // into deep time; adopting it then would flash a patch nobody asked for
    if (!detailAllowed()) return
    view.detailStatus = detail!.status
    view.detailSource = detail!.sourceLabel
    view.detailAttribution = detail!.attribution
    view.detailGroundRes = detail!.groundRes
    surface!.setDetail(detail!.atlas, detail!.index, detail!.mix)
    wake() // a tile that arrived while the globe was parked still has to appear
  }

  /**
   * Streaming applies to every era that uses the modern basemap — coastline,
   * river, ice and desert are no less true in 1500 than today. Deep time is the
   * one exclusion: those eras draw a paleo map, and a Sentinel-2 patch of the
   * modern Atlantic over a Pangaean coastline would be nonsense.
   *
   * How *close* the camera may come is what varies by period instead; see
   * minAltitudeFor.
   */
  const detailAllowed = () => {
    switch (style.value.tiles) {
      case 'none':
        return false
      // A photograph of the modern Atlantic over a Pangaean coastline is
      // nonsense, so imagery stops where the paleo frames start driving.
      case 'imagery':
        return time.currentTime > -12000
      // A drawn coastline is not a photograph and carries no century in it, so
      // the only question left is whether the coastline is the right one — see
      // DRAWN_ERA_FROM, which is the year the base texture stops being a
      // reconstruction.
      case 'drawn':
        return time.currentTime >= DRAWN_ERA_FROM
    }
  }

  /**
   * The only place detail streaming is driven. It was previously called from
   * both the zoom handler and the frame loop with different arguments, so the
   * two computed different rectangles and fought over which one to load.
   */
  const syncDetail = (pov: { lat: number; lng: number; altitude: number }) => {
    if (!detailAllowed()) {
      surface!.setDetail(null, undefined, 0)
      return
    }
    // device pixels, not CSS pixels: the globe renders at the device ratio
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = el.value?.clientWidth ?? 900
    const h = el.value?.clientHeight ?? 900
    // the camera's own fov, so the patch is cut to the frame rather than to the
    // horizon — close in those differ by more than an order of magnitude
    detail!.update(pov.lat, pov.lng, pov.altitude, h * dpr, w / h, view.fov)
    surface!.setDetail(detail!.atlas, detail!.index, detail!.mix)
  }

  /** The year the streaming layer stops being an anachronism, if it ever was. */
  const eraFrom = () => (style.value.tiles === 'imagery' ? IMAGERY_ERA_FROM : null)

  /** 0 far out, 1 close in — drives detail streaming and retires the sky effects. */
  const closeness = (altitude: number) => {
    const span = visibleSpanDeg(altitude)
    return Math.max(0, Math.min(1, (40 - span) / 30))
  }

  type Pov = { lat: number; lng: number; altitude: number }

  /**
   * When two camera heights count as the same height.
   *
   * Relative, not absolute: a thousandth of the altitude is the same visual
   * nothing at world view and at street level, where an absolute epsilon would
   * be either useless far out or a visible step close in.
   *
   * One definition, two callers — `povMoved` below and the `view.altitude`
   * write in the tick. They were the same expression written twice, and they
   * have to stay equal: the tick's write is what makes a camera the reader sees
   * as unmoved *stay* unmoved. If one drifted from the other, a rotation would
   * publish a new altitude that nothing else considered a move.
   */
  const ALTITUDE_EPS_REL = 1e-3
  /** Lat/lng below this are the same point for everything downstream. */
  const ANGLE_EPS_DEG = 1e-4
  const sameAltitude = (a: number, b: number) =>
    Math.abs(a - b) <= Math.max(b, 1e-6) * ALTITUDE_EPS_REL

  /** Has the camera moved enough for any of the work below to differ? */
  const povMoved = (a: Pov | undefined, b: Pov) =>
    !a ||
    !sameAltitude(a.altitude, b.altitude) ||
    Math.abs(a.lat - b.lat) > ANGLE_EPS_DEG ||
    Math.abs(a.lng - b.lng) > ANGLE_EPS_DEG

  let lastPov: Pov | undefined
  let lastSync: Pov | undefined

  /**
   * Cloud drift: a phase read off the wall clock every frame, and a cadence
   * chosen for nothing but smoothness.
   *
   * These used to be the same decision, and that was the bug. The phase was
   * advanced by a timer — one step every `driftIntervalMs`, sized so a step
   * moved the deck 0.4 screen pixels — and every frame drawn *between* two of
   * those steps drew the deck where it had been. Frames get drawn for a dozen
   * reasons that have nothing to do with the drift (a pointer over the canvas,
   * OrbitControls damping, the pump's safety tick, a texture landing), so the
   * deck froze for a run of frames and then jumped: measured on an idle globe
   * with a pointer resting on it, 61% of rendered frames repeated the previous
   * phase exactly, and the ones that moved jumped up to 3.6x an even step.
   *
   * Splitting them fixes it outright. `setCloudDrift` below runs on every tick
   * and is a pure function of the clock, so *whatever* causes a frame, that
   * frame shows the deck where the clock says it is — there is no longer a
   * category of frame that can be stale. What is left is only how often to draw
   * an otherwise idle globe, which `cloudIdleIntervalMs` answers with 30 Hz
   * (~0.1 px of deck movement per frame, against the 0.4 px steps at 8-9 Hz
   * that were being reported as staggered). With no film on screen, or with
   * reduced motion, it answers `null` and the pump parks indefinitely.
   *
   * The alternative that was prototyped and rejected: cache the surface pass in
   * a render target when the scene is dirty and re-run only the cloud film on
   * drift ticks. It works, and the fragment saving is real — timed under
   * SwiftShader at 900x900, a whole frame is 327 ms at the default view and
   * 576 ms at mid zoom, of which the surface shader is 141 ms and 349 ms, and a
   * cloud-only pass reading two cached targets came in 27-36% under the full
   * frame. What sank it was the other side of the ledger. The cache has to hold
   * the pre-shadow colour separately from the emissive and rim terms for the
   * ground shadow to stay exact, and those values reach ~2.6 before the output
   * clamp, so the targets have to be half-float — 83 MB at DPR 2 on a 1440x900
   * window, on top of a texture budget that already has a device-memory cap
   * bolted to it (see patchPixelCap). Every dirty frame then pays the surface
   * shader twice, so anything that moves the camera is 25% *slower*. And the
   * cache is only correct if every one of resize, DPR change, era crossfade,
   * patch arrival, palette, visuals, relief, sun, city lights, night-map and
   * upscale arrival invalidates it — a list whose failure mode is a stale
   * planet under moving clouds. Spending 56% fewer frames instead costs one
   * pure function and buys most of the same idle time back.
   */
  /** The framed span, kept for the cadence; see `cloudIdleIntervalMs`. */
  let framedSpanDeg = viewSpanDeg(2.5)

  const applyPov = (force = false) => {
    const pov = globe!.pointOfView()
    // OrbitControls fires a change event per wheel notch and per pointer move,
    // several times a frame during a zoom, and everything below — a projection
    // matrix, store writes that wake Vue, a detail-streaming pass — is only a
    // function of where the camera is. Doing it once per distinct pov is the
    // whole difference between a throttled zoom and an interactive one.
    if (!force && !povMoved(lastPov, pov)) return
    lastPov = { ...pov }
    // how close the camera may come depends on whether modern imagery is allowed
    // The pre-era zoom clamp belongs to the SOURCE. Only a photograph dates
    // itself; the drawn map passes null and may be inspected as closely in 1200
    // as in 2020, which is most of what it is for.
    globe!.controls().minDistance =
      radius * (1 + minAltitudeFor(time.currentTime, style.value.tiles !== 'none', eraFrom()))
    // globe.gl pins near at 0.05, which is what limits how close the camera may
    // come. Tracking it to the camera's own height keeps depth precision good
    // while allowing a far closer approach.
    if (cam instanceof PerspectiveCamera) {
      const wanted = Math.max(0.004, radius * pov.altitude * 0.35)
      if (Math.abs(cam.near - wanted) > wanted * 0.2) {
        cam.near = wanted
        cam.updateProjectionMatrix()
      }
    }
    const near = closeness(pov.altitude)
    const span = visibleSpanDeg(pov.altitude)
    // Quantised, at the same relative epsilon povMoved uses — literally the
    // same predicate now (see ALTITUDE_EPS_REL).
    //
    // A pure rotation gets here on every frame (lat/lng really did change) and
    // used to publish the camera's *distance* each time — which OrbitControls
    // damping leaves wandering in the last few digits. Every one of those writes
    // re-rendered the scale bar, and the bar's rule has a width transition, so
    // it restarted a CSS animation sixty times a second to end at the same
    // width. Below the epsilon the altitude is, for every reader of it, the
    // altitude it already had.
    if (!sameAltitude(view.altitude, pov.altitude)) view.altitude = pov.altitude
    events.noteSpan(span)
    view.detailStatus = detail!.status
    view.detailSource = detail!.sourceLabel
    view.viewportPx = el.value?.clientHeight ?? 900
    view.viewportWidthPx = el.value?.clientWidth ?? 900
    // The visible circle, quantised (lib/viewport.ts), and written only when the
    // quantised value moves. This runs on every distinct camera position — a pan
    // is a new position every frame — and the event query, the clustering and
    // every pin element hang off it, so publishing the raw circle here would
    // rebuild the whole pin layer sixty times a second. Instead a pan crosses a
    // grid line about four times per screen width, and a zoom a few times per
    // octave, which is the cadence the clustering already re-runs at.
    const scope = cameraScope({
      lat: pov.lat,
      lng: pov.lng,
      altitude: pov.altitude,
      fovDeg: view.fov,
      aspect: view.viewportWidthPx / Math.max(1, view.viewportPx),
    })
    if (!sameScope(view.scope, scope)) view.scope = scope
    // The terminator, or the absence of one: map mode has no sun, so it pins
    // this at 1 rather than letting the camera decide (see `GlobeStyle`).
    surface!.setFlatLight(style.value.flatLight ?? near)
    lastSync = { ...pov }
    syncDetail(pov)
    // A drawing's labels are spaced for the frame "Show on map" flies to; zoomed
    // out they pile into one smear. The geometry stays either way.
    drawing?.setViewSpanDeg(viewSpanDeg(pov.altitude, view.fov))
    // HOW HIGH THE INK RIDES — see `inkLift` in lib/drawingLayer.ts. A fixed
    // altitude is a fixed distance on the planet, so it costs twice as many
    // pixels every time the frame halves, which is the "drawings are still
    // floating at higher zoom" the reader reported after round 59 had already
    // made it eight times smaller. Both layers, because a route hovers exactly
    // as visibly as a battle plan does. Costs one matrix each, no rebuild.
    if ([drawing, routes].filter((l) => l?.setCameraAltitude(pov.altitude)).length) wake()
    // The framed span, not the horizon `span` below: close in the two differ by
    // more than an order of magnitude, and it is the framed one that says how
    // many pixels a degree of ground is worth — which is what decides whether
    // 30 Hz is enough to keep the deck's motion sub-pixel.
    framedSpanDeg = viewSpanDeg(pov.altitude, view.fov)
    // clouds retire well before the ground fills the screen; haze lingers longer
    const cloudy = cloudFadeFor(span)
    surface!.setCloudSharpen(cloudy > 0.01 ? cloudSharpenFor(span) : 0)
    surface!.setClouds(
      style.value.clouds && cloudy > 0.01,
      (time.currentTime > -12000 ? 1 : 0) * cloudy,
      style.value.cloudShadows,
    )
    atmosphere!.visible = style.value.atmosphere && near < 0.9
    // …and globe.gl's OWN atmosphere shell, which is a second one and is on by
    // default. It survived every earlier pass at map mode because nothing in
    // this file ever mentioned it: `GlobeStyle.atmosphere` drove the custom
    // layer alone, so the drawn globe kept a blue halo round a sheet of paper.
    globe!.showAtmosphere(style.value.atmosphere)
    wake()
  }

  // One pass per frame at most: the camera can only be in one place per frame,
  // so a change event that arrives after another has already been scheduled has
  // nothing new to say.
  let povRaf = 0
  const scheduleApplyPov = () => {
    if (povRaf) return
    povRaf = requestAnimationFrame(() => {
      povRaf = 0
      applyPov()
    })
  }
  globe.onZoom(scheduleApplyPov)

  const coords = (lat: number, lng: number, alt: number) => globe!.getCoords(lat, lng, alt)
  const sunDir = () => {
    const { x, y, z } = coords(0, subsolarLongitude(settings.sunHour), 1)
    return new Vector3(x, y, z).normalize()
  }
  const dirLight = globe.lights().find((l): l is DirectionalLight => l instanceof DirectionalLight)
  const ambient = globe.lights().find((l): l is AmbientLight => l instanceof AmbientLight)
  if (ambient) ambient.intensity = Math.min(ambient.intensity, 0.7)

  /** Where the era cursor was last frame; the lookahead needs a direction. */
  let prevEraTime: number | undefined

  /**
   * Frame-on-demand: the wiring. The policy — cushion, safety tick, when to park
   * — is in lib/renderPump.ts, and the comment there is the one worth reading.
   *
   * What lives here is the list of dirty sources, and it is the part that has to
   * be complete for any of it to be correct. Every `wake()` below stands for one
   * way the picture can change:
   *
   *   controls 'change'   drag, wheel, pinch, and every damping step after one
   *   pointer events      the hover raycast runs inside the render loop
   *   surface.onDirty     a map, an upscale or an era frame decoding
   *   detail.onReady      a streamed patch arriving
   *   the watchEffects    pins, arcs, polygons, era, sun, palette, settings
   *   applyPov / resize   anything that re-derives from the camera or the canvas
   *   the tick itself     the arrival ramps, cloud drift, autorotation
   */
  const stats = { wakes: 0, resumes: 0, pauses: 0, drifts: 0, flows: 0, ticks: 0 }
  const pump = new RenderPump()
  pump.onResume = () => {
    stats.resumes++
    // resumeAnimation renders synchronously, so a one-frame wake really is one
    globe!.resumeAnimation()
  }
  pump.onPause = () => {
    stats.pauses++
    globe!.pauseAnimation()
  }
  const wake = (ms?: number) => {
    stats.wakes++
    pump.wake(ms)
  }

  /**
   * The starfield sphere, found by shape rather than by name.
   *
   * `three-render-objects` adds it as a direct child of the render root and
   * gives it a `SphereGeometry` of `skyRadius`, which is two orders of
   * magnitude wider than the planet — so "a mesh whose sphere dwarfs the globe"
   * identifies it without depending on the library's internal field names.
   * Found once and remembered; `undefined` is a supported answer (see the
   * background watcher).
   */
  const skySphere = (): Object3D | undefined => {
    if (skyMesh) return skyMesh
    let root: Object3D | null | undefined = globe?.scene()
    while (root?.parent) root = root.parent
    skyMesh = root?.children.find((o) => {
      const g = (o as Mesh).geometry as SphereGeometry | undefined
      return (
        (o as Mesh).isMesh === true &&
        g?.type === 'SphereGeometry' &&
        (g.parameters?.radius ?? 0) > radius * 10
      )
    })
    return skyMesh
  }
  /**
   * BUILD THE DRAWN MAP'S HALF OF THE PIPELINE, once.
   *
   * Called from two places, and the second one is the round-61 change: the
   * tiles watcher, which is the switch itself, and `warmDrawn` below, which is
   * a pointer arriving at the toggle. Everything in here is idempotent because
   * the first caller may be either of them.
   */
  const ensureDrawn = () => {
    if (drawnPlan) return
    drawnTiles = new DrawnTiles(import.meta.env.BASE_URL)
    // …and `paint`, which is the upload path's half of `DETAIL_MODE`: a drawn
    // tile IS the ground, so the reduced copy the sharp/blurred ratio divides
    // by is never sampled and is never made.
    drawnPlan = singleSourcePlan(drawnTiles.source, DRAWN_Z_MAX, true)
    // The 50m geometry landing renames the source, which retires every tile
    // drawn from the 110m stand-in. Nothing else would ask for the new ones:
    // the camera has not moved, so the tick's own guard would skip the sync —
    // forgetting where it last synced is what makes the upgrade reach the
    // screen.
    drawnTiles.onUpgrade = () => {
      lastSync = undefined
      wake()
    }
    if (import.meta.env.DEV) {
      ;(window as unknown as { __drawn?: DrawnTiles }).__drawn = drawnTiles
    }
  }

  /**
   * …and start it BEFORE the click, on the evidence that a click is coming.
   *
   * Three things a cold switch used to do inside the toggle, in the order they
   * block on each other:
   *
   *  1. spawn the rasterizer worker — a module graph, and in dev an HTTP fetch
   *     of every module in it;
   *  2. fetch and parse the vector world (110m, then 50m) in that worker,
   *     which is where the first tile of the new mode is waiting;
   *  3. fetch, decode and upload the 4096x2048 drawn world — 32 MB and a full
   *     mip chain, in the frame that first binds it.
   *
   * None of them needs the mode to have changed, and all three are latency the
   * reader watches. `prime` is the message that makes (2) start without a tile
   * request, because the worker's geometry load is lazy on its first tile.
   */
  const warmDrawn = () => {
    ensureDrawn()
    drawnTiles?.prime()
    surface!.warm(DRAWN_TEXTURE)
  }

  /** Apply the wanted starfield state, whatever the library last decided. */
  const syncSky = () => {
    const sky = skySphere()
    if (sky && sky.visible !== starsWanted) {
      sky.visible = starsWanted
      wake()
    }
  }
  // dev-only handles: a screenshot script has to be able to tell "nothing is
  // being drawn" from "something is being drawn that looks identical"
  if (import.meta.env.DEV) {
    ;(window as unknown as { __wake?: (n?: number) => void }).__wake = wake
    ;(window as unknown as { __rendering?: () => boolean }).__rendering = () => pump.running
    ;(window as unknown as { __frameStats?: () => object }).__frameStats = () => ({
      ...stats,
      running: pump.running,
    })
  }

  // Every camera move — drag, wheel, pinch, and each damping step on the way to
  // a stop — dispatches this. It is the single most important dirty source, and
  // the one the whole scheme depends on.
  globe.controls().addEventListener('change', () => wake())
  // A HAND ON THE GLOBE OUTRANKS A FLIGHT. `pointOfView` with a duration drives
  // the camera for the better part of a second, and it does not stop for the
  // user: grabbing the planet mid-flight used to be a tug of war the tween won,
  // with the globe snapping back to the destination the moment the drag ended.
  // Stages made that a common gesture rather than a rare one — every chip may
  // move the camera — so the flight is abandoned the instant a drag starts.
  //
  // Re-issuing the CURRENT point of view is the cancel: globe.gl ends the
  // running tween (which lands it, synchronously) and then sets the camera back
  // to where this call says it is, so nothing is drawn between the two. Reading
  // the pov first is what makes that true.
  globe.controls().addEventListener('start', () => {
    if (!flying) return
    flying = false
    globe!.pointOfView(globe!.pointOfView())
  })
  // The hover raycast lives inside the render loop, so a pointer that moves over
  // a parked globe has to buy frames for the hover to be found and the tooltip
  // to be drawn. Leaving buys the frames that clear it again.
  for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'wheel']) {
    dom.addEventListener(ev, () => wake(), { passive: true })
  }
  /**
   * Hover is a response to the pointer, so it is only paid for near one.
   *
   * globe.gl raycasts the whole scene once per frame to find what is under the
   * cursor, and that raycast is the single most expensive thing on the main
   * thread while the camera moves: measured over a scripted close-zoom pan, 7.0
   * to 16.0 ms of a 12.6 to 21.1 ms frame — more than half of it, every frame,
   * to re-answer a question nobody asked. It walks every triangle of the globe
   * sphere, every polygon cap, and every segment of every route.
   *
   * three-render-objects already skips it while a *drag* is in progress
   * (`hoverDuringDrag` is false), so what is left to pay for is the motion it
   * does not know about: a wheel zoom, the damping after a drag, a 900 ms "Show
   * on map" flight, autorotation. None of those is a hover.
   *
   * The rule is the two things that can make a hover meaningful: the pointer did
   * something recently, or the camera has come to rest. Anything else — a globe
   * moving under an idle cursor — gets the raycast switched off, and switched
   * back on within a frame of either condition returning. Clicks are safe
   * because a `pointerdown` is pointer activity and turns it on before the
   * gesture that would need it completes.
   */
  let pointerAt = 0
  for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'wheel']) {
    dom.addEventListener(ev, () => (pointerAt = performance.now()), { passive: true })
  }
  /** How long after the pointer moves a hover is still worth looking for. */
  const HOVER_GRACE_MS = 1000
  let hoverOn = true
  const setHover = (on: boolean) => {
    if (on === hoverOn) return
    hoverOn = on
    globe!.enablePointerInteraction(on)
  }

  const t0 = performance.now()
  let lastFrame = t0
  let lastDrift = t0
  /** When the route flow last bought a frame. See ROUTE_FLOW_INTERVAL_MS. */
  let lastFlow = t0
  // The day map has decoded; the next frame is the first with a planet on it.
  // The loader is dismissed a frame after that, so the fade starts from a
  // rendered globe rather than from an empty canvas — see index.html.
  let dayReady = false
  let framesSinceReady = 0
  surface.onDayReady = () => {
    dayReady = true
    wake()
  }
  // a map, an upscale or an era frame landing changes the picture without anyone
  // asking; so does a streamed patch
  surface.onDirty = () => wake()
  /** How long the camera must be still before deferred work may run. */
  const STILL_MS = 400
  let movedAt = performance.now()

  const tick = () => {
    const now = performance.now()
    const dt = now - lastFrame
    lastFrame = now

    // the arrival ramps for the maps that were not needed for first paint; they
    // are the picture changing under their own steam, so they buy frames
    if (surface!.advance(dt)) wake(0)

    // The deck's position, every frame, from the clock — never from a timer.
    // This runs whether or not anything asked for a frame, so a frame drawn for
    // some other reason entirely (a pointer moving, damping, the safety tick)
    // still finds the phase where the wall clock puts it. The cadence question
    // is the separate one below.
    if (!still) surface!.setCloudDrift(animationClock(now) - t0)
    const idleMs = cloudIdleIntervalMs({
      cloudsShown: surface!.cloudsShown,
      reducedMotion: still,
      viewSpanDeg: framedSpanDeg,
      viewportPx: view.viewportPx,
    })
    if (idleMs !== null && now - lastDrift >= idleMs) {
      lastDrift = now
      stats.drifts++
      wake(0)
    }
    // autorotation is driven by OrbitControls.update(), which only runs inside
    // the loop this is deciding whether to run — so unlike every other animation
    // here it cannot ask for itself
    if (settings.autoRotate) wake(0)
    // The dash flowing along a one-way route, on exactly the cloud drift's
    // terms: the phase is set from the wall clock on every frame that happens,
    // so any frame shows it correctly, and the cadence question — how often to
    // draw an otherwise idle globe — is answered separately and modestly at
    // ~20 Hz. Reduced motion sets no phase and buys no frames, so the dash sits
    // where it was built and the brightness ramp carries the direction alone.
    if (!still && routes!.hasFlow) {
      const due = now - lastFlow >= ROUTE_FLOW_INTERVAL_MS
      // Only onto a frame that will actually be drawn. This tick runs at 60 Hz
      // whether or not anything is being rendered, and the phase is a write to
      // every dashed piece of every route — sixty materials for the Atlantic
      // triangle — so on a parked globe it was thousands of uniform writes a
      // second for a picture nobody was drawing. `due` is the case where the
      // wake below is about to draw one, and `resumeAnimation` renders
      // synchronously, so the phase has to be in place before it.
      if (pump.running || due) routes!.setFlowPhase(animationClock(now))
      if (due) {
        lastFlow = now
        stats.flows++
        wake(0)
      }
    }

    // Tiles still queued for a slot (two a frame) and slots still dissolving in
    // are the picture changing on the clock rather than on the camera, so they
    // buy their own frames. This has to come *before* the sync below reads
    // `pump.running`, and that ordering is load-bearing: a wake(0) issued after
    // the read only takes effect on the following tick, which then parks again
    // at the end of it — so the loop alternated between waking and never
    // syncing, and a view stopped at whatever tiles it had when the camera
    // stopped (measured: 12 slots of a 21-tile view, backlog stuck at 9).
    if (detail!.animating) wake(0)
    if (pump.running) {
      // streaming is a function of where the camera is, and the camera cannot
      // move while the loop is parked
      const pov = globe!.pointOfView()
      if (povMoved(lastSync, pov)) {
        lastSync = { ...pov }
        movedAt = now
        syncDetail(pov)
      } else if (detail!.animating) syncDetail(pov)
    }
    // The starfield's own state, re-asserted because the library sets it from
    // an asynchronous texture load. One boolean comparison; see `syncSky`.
    if (starsReady.value) syncSky()
    // deferred work waits for a still camera as well as an idle browser
    const still2 = now - movedAt >= STILL_MS
    surface!.setBusy(!still2)
    setHover(still2 || now - pointerAt < HOVER_GRACE_MS)

    if (dayReady && framesSinceReady < 2) {
      wake()
      framesSinceReady++
      if (framesSinceReady === 2) {
        ;(window as unknown as { __globeReady?: () => void }).__globeReady?.()
        // and only now the maps the first frame did without: they have the
        // network and the main thread to themselves from here on
        surface!.loadRest()
        // The starfield is one of them, and the watcher above is what asks
        // for it — this only says the globe is ready to carry one. globe.gl
        // gives no callback for the background texture, so nothing can wake the
        // pump exactly when it lands; the pump's one-second safety tick bounds
        // the wait, and the three maps above each wake it as they arrive in the
        // same window.
        starsReady.value = true
        // ...and the event data, which draws nothing until there is a planet to
        // put pins on. App.vue is waiting on this. See lib/firstFrame.ts.
        firstFrame.release()
      }
    }

    // and the decision: keep drawing, or park until something asks again
    pump.tick()
    stats.ticks++
    raf = requestAnimationFrame(tick)
  }
  tick()

  // Every one of these is a dirty source: a layer's data changed, or a uniform
  // did, and the loop may well be parked. `wake` buys enough frames to cover the
  // d3 transitions the data changes start (arcs 180 ms, polygons 300 ms).
  stops.push(
    watchEffect(() => {
      // selection and tier are both part of a pin's identity, so both must be
      // dependencies here even though the layout object may be unchanged
      globe!.htmlElementsData(stablePins(layout.value.pins, events.tiers, events.selectedId))
      wake()
    }),
    // Legs get stable identity for the same reason pins do: while a fan is open
    // a zoom relays it every frame, and a fresh object would restart the arc's
    // transition each time instead of moving the arc it already has.
    watchEffect(() => {
      globe!.arcsData(stableLegs(layout.value.legs))
      wake()
    }),
    // The layer is only handed a new list when the list is actually different.
    // Memoised entries (lib/nations.ts) mean a timeline tick usually produces
    // the very same objects in the same order, and re-setting the data then
    // costs a full data-join over every polygon to conclude nothing moved.
    watchEffect(() => {
      // The mode is a dependency, not a decoration: the border colour is
      // resolved per ground (see polygonStrokeColor), and three-globe only
      // re-reads an accessor when the data it is given is different — so the
      // list identity has to change when the mode does.
      const ink = mode.value
      // Focus mode takes the borders off the globe with everything else that is
      // not the focused item (see `focus` in stores/events.ts). It is gated
      // here rather than in the nation store because the borders themselves are
      // unchanged — a polity does not stop existing because someone opened a
      // battle plan — and because the era band and the timeline read the same
      // store and must keep seeing them. Reading `events.focus` inside this
      // watcher is what makes leaving the mode put them straight back.
      // The contested zones ride with the borders and are gated with them: a
      // zone is a cap and an outline like a polity's, differing only in that
      // the cap is hatched and the outline dashed. They come FIRST so that a
      // hatch is never the thing a neighbouring wash is drawn over.
      const zones = events.focus ? [] : nations.contested
      const next = [...zones, ...(events.focus ? [] : nations.borders), ...eventAreas()]
      // The modern states ride with them and are NOT polygons: no fill, no
      // hover, no click, no place in the ranking — border ink only, and one
      // entry for the whole world (see lib/modernBorders.ts). They go with the
      // borders in focus mode for the same reason the borders do.
      const modern = events.focus ? [] : nations.modernBorders
      const same = (a: readonly object[], b: readonly object[]) =>
        a.length === b.length && a.every((p, i) => p === b[i])
      if (ink === lastInk && same(next, lastPolys) && same(modern, lastModern)) return
      const capsMoved = !same(next, lastPolys) || ink !== lastInk
      lastInk = ink
      lastPolys = next
      lastModern = modern
      // Only when the caps actually moved: `polygonsData` is a full data join
      // over every polygon, and crossing 2011 changes one line in Sudan.
      if (capsMoved) globe!.polygonsData(next)
      // …and the political ink, which is the same list minus its coastlines,
      // plus the modern set. One layer, one draw call, rebuilt on exactly the
      // changes the caps are rebuilt on — see lib/frontierLayer.ts for why it is
      // not the polygon layer's stroke and not a DrawingLayer, and
      // `frontierInkPlan` for which of the two layers inks a shared frontier.
      const plan = frontierInkPlan(modern, { mode: ink })
      // A DISPUTED LINE IS THE LAST WORD, so the zones go at the END of this
      // list even though their caps go at the start of the other one. The whole
      // layer is one buffer of GL_LINES drawn in array order, so a later entry
      // paints over an earlier one where they coincide — and a contested zone's
      // boundary coincides with a modern frontier by construction wherever it
      // was derived from one. Photographed at Abyei with the zones first: the
      // three authored edges dashed and the fourth, which is the Sudan/South
      // Sudan line, painted back over in the modern set's pale grey.
      frontiers?.set(
        [...next.filter((p): p is BorderEntry => p.kind === 'full'), ...modern, ...zones],
        plan.colorOf,
        plan.inkOf,
      )
      wake()
    }),
    // The selected event's routes: the lines and the dots on their ports. They
    // appear with the selection and go with it, and the layer's own key
    // comparison keeps a re-run of this watcher from rebuilding an unchanged
    // route.
    watchEffect(() => {
      const sel = events.selected
      const color = sel ? tagColor(primaryTag(sel)) : '#ffffff'
      if (
        routes!.set(selectionDrawing(), {
          color,
          altitude: SURFACE_ALT,
          ground: style.value.base === 'drawn' ? 'paper' : 'dark',
          resolution: { width: view.viewportWidthPx, height: view.viewportPx },
        })
      )
        wake()
    }),
    // The authored drawing — the focused item's plan, resolved for whichever
    // step of it the reader has stepped into. Two decisions, in two places, and
    // neither is here: that focus mode rather than the selection shows a plan at
    // all is `focusDrawing` (stores/events.ts), and what a step does to that plan
    // is `resolveFocusInk` (lib/present/ink.ts). Redoing either here, from the
    // focused item and its plan and its steps and the current step id, would put
    // the one rule that decides what is on the map in a place no test can reach.
    //
    // The colour falls back to the event's tag so an unstyled layer is already
    // in the map's own language.
    watchEffect(() => {
      // colour from the focused context (whose drawing this is), not whatever
      // child happens to be selected inside it
      const sel = events.focused ?? events.selected
      const color = sel ? tagColor(primaryTag(sel)) : '#ffffff'
      if (
        drawing!.set(events.focusDrawing, {
          color,
          ground: style.value.base === 'drawn' ? 'paper' : 'dark',
          // The same altitude as everything else on the map. A plan is still the
          // top layer of ink — that is KIND_ORDER and renderOrder, not height.
          altitude: SURFACE_ALT,
          resolution: { width: view.viewportWidthPx, height: view.viewportPx },
        })
      )
        wake()
    }),
    watchEffect(() => {
      globe!.controls().autoRotate = settings.autoRotate
      wake()
    }),
    // A panel asked the globe to look somewhere — a person's birth or death
    // place, or the whole geometry of an item under "Show on map". The store
    // bumps a counter rather than clearing the request, so asking for the same
    // coordinates twice still flies there twice.
    //
    // Altitude only when the request carries one: a place chip is about *where*
    // and leaves the user's zoom alone, while fitting a route in the frame is a
    // statement about how far out the camera has to be and would be meaningless
    // without it.
    watchEffect(() => {
      const target = events.flyTo
      if (!target) return
      void target.seq
      globe!.pointOfView(
        target.altitude === undefined
          ? { lat: target.lat, lng: target.lng }
          : { lat: target.lat, lng: target.lng, altitude: target.altitude },
        FLY_MS,
      )
      // Armed for exactly as long as the flight lasts (see the `start` handler),
      // and disarmed by a timer rather than by the tween's own completion
      // because globe.gl does not expose one.
      flying = true
      clearTimeout(flyTimer)
      flyTimer = setTimeout(() => (flying = false), FLY_MS) as unknown as number
      // the default cushion (1.5 s) outlasts the 900 ms flight, and OrbitControls
      // announces every damping step of it anyway
      wake()
    }),
    // The relief map is the modern height field; deep-time frames carry their own
    // baked hillshade, so it fades out exactly as they fade in.
    watchEffect(() => {
      surface!.setRelief(style.value.relief * 0.7 * modernShare(frames.value, time.currentTime))
      wake()
    }),
    watchEffect(() => {
      surface!.setVisuals(style.value.boost)
      wake()
    }),
    watchEffect(() => {
      surface!.setPalette(style.value.palette)
      wake()
    }),
    /**
     * WHICH TILES STREAM, and what the shader does with them.
     *
     * One watcher for both because they are one switch. `setPlan` abandons
     * whatever was in flight for the other source and drops the index built
     * from it — the decoded cache is keyed by source label already, so
     * switching back finds its own tiles where it left them.
     *
     * The drawn rasterizer is built the first time it is asked for: it spawns a
     * worker and fetches 1.1 MB of vector data, and a reader who never opens
     * map mode should pay for neither.
     */
    watchEffect(() => {
      const kind = style.value.tiles
      if (kind === 'drawn') {
        ensureDrawn()
        detail!.setPlan(drawnPlan!)
      } else {
        detail!.setPlan(IMAGERY_PLAN)
      }
      // The shader's half of the same decision: whether a streamed tile
      // modulates the ground or IS the ground, whether the planet has an
      // atmospheric limb, how much of the paper grade a deep-time frame takes,
      // whether this mode prints at all, and whether the output is encoded.
      //
      // The last two used to be one number, and the collapse is what let a
      // photograph reach the screen inside map mode: a modern year asks for no
      // paper, which is also what realistic mode asks for at every year, and
      // the surface could not tell "this mode does not print" from "this frame
      // needs no printing". See `applyPaper` in lib/globeSurface.ts.
      surface!.setSurfaceMode(
        style.value.detail,
        style.value.rim,
        style.value.paper ? 1 - modernShare(frames.value, time.currentTime) : 0,
        style.value.encode ? 1 : 0,
        style.value.paper,
      )
      wake()
    }),
    /**
     * The prewarm, hung off the intent latch rather than off the mode.
     *
     * It fires at most once — `mapWarmed` never goes back to false — and it
     * fires for nobody who has not put a pointer, a finger or the keyboard
     * focus on a mode control. A reader who never does still pays for neither
     * the worker, the vector data nor the drawn world, which is the contract
     * the laziness was written for (see lib/drawnSource.ts).
     */
    watchEffect(() => {
      if (settings.mapWarmed) warmDrawn()
    }),
    // The plan carries more than the crossfade: which frames stay resident and
    // which one to warm next, both of which depend on the *direction* the cursor
    // is moving, so the previous time is part of the input.
    watchEffect(() => {
      const t = time.currentTime
      // Which timeline this is, before which frame of it: a frame the surface
      // is holding over from the OTHER mode's list is the one case `applyEra`
      // cannot recognise on its own, and it is what put a photograph under map
      // mode. See `baseHeld` in lib/globeSurface.ts.
      surface!.setBaseFrames(frames.value)
      surface!.setEra(eraPlan(frames.value, t, prevEraTime))
      prevEraTime = t
      wake()
    }),
    // City lights are the night side saying it is night. Map mode has no night
    // (see `GlobeStyle.night`), so it has none of these either.
    watchEffect(() => {
      surface!.setCityLights(style.value.night ? cityLightsFactor(time.currentTime) : 0)
      wake()
    }),
    /**
     * The starfield, or the flat field that replaces it.
     *
     * globe.gl gives no callback for the background texture, so the sky is not
     * asked for until the planet is on screen (see `starsReady` in the tick) —
     * this watcher is what puts it up then, and what takes it away again when
     * the reader switches to map mode. `null` is how globe.gl is told to drop a
     * background image and fall back to the colour.
     */
    watchEffect(() => {
      globe!.backgroundColor(style.value.background)
      if (!starsReady.value) return
      /**
       * THE STARFIELD IS HIDDEN, NOT UNLOADED.
       *
       * `backgroundImageUrl(null)` is how three-render-objects is told to drop
       * a background, and what it does is `skysphere.material.map = null`. The
       * cost is on the way BACK: passing the URL again runs
       * `new TextureLoader().load(...)` unconditionally, so returning to globe
       * mode built a fresh `Texture` and a fresh `MeshBasicMaterial` and left
       * the old pair to the collector — measured as a 4096x2048 upload of
       * `night-sky.webp` and a full mip chain on every switch back
       * (tests/e2e/modeSwitch.e2e.mjs). The reader is toggling to compare two
       * looks; that is the one gesture this must not charge for.
       *
       * So the URL is set exactly once and the sphere's own `visible` carries
       * the decision. Nothing in the library writes that flag except the
       * `backgroundImageUrl` branch, which now runs once. If the sphere cannot
       * be found — a future version that keeps it somewhere else — the old
       * behaviour is the fallback, and it is correct, only slower.
       */
      starsWanted = style.value.stars
      const sky = skySphere()
      if (!sky) {
        // No sphere to hide: keep the old behaviour, which is correct and only
        // costs the reload this exists to avoid.
        globe!.backgroundImageUrl(starsWanted ? SKY_TEXTURE : null)
      } else if (!skyLoaded && starsWanted) {
        skyLoaded = true
        globe!.backgroundImageUrl(SKY_TEXTURE)
      }
      // The library switches the sphere on ITSELF when the texture lands, which
      // can be after this watcher has said to hide it, so the flag is what
      // decides and `syncSky` in the tick is what keeps applying it.
      syncSky()
      wake()
    }),
    // clouds are anachronistic detail in deep time, and would hide the plate drift
    watchEffect(() => {
      // The whole style, not a list of its fields: `style` is one computed, so
      // reading it registers a dependency on every setting behind it at once —
      // which is what makes a NEW visual knob correct here by default instead
      // of correct only if someone remembers to add a line. (It also fixes an
      // old miss: `cloudShadows` was applied inside `applyPov` but was not on
      // the old list, so toggling it alone did nothing until the camera moved.)
      void style.value
      void time.currentTime
      applyPov(true) // a settings change, not a camera move: run it regardless
    }),
    watchEffect(() => {
      const dir = sunDir()
      surface!.setSun(dir)
      atmosphere!.setSunDirection(dir)
      dirLight?.position.copy(dir.clone().multiplyScalar(radius * 4))
      celestial!.visible = style.value.celestial
      celestial!.setHour(settings.sunHour, coords)
      wake()
    }),
  )

  resizeObs = new ResizeObserver(() => {
    globe?.width(dom.clientWidth).height(dom.clientHeight)
    // Fat lines are sized in screen pixels, so their material has to be told
    // what a screen pixel is; a resize without this leaves a frontline drawn at
    // the old aspect and visibly the wrong weight.
    drawing?.setResolution(dom.clientWidth, dom.clientHeight)
    routes?.setResolution(dom.clientWidth, dom.clientHeight)
    applyPov(true) // the scale bar reads viewportPx; without this it is stale until the next zoom
    wake()
  })
  resizeObs.observe(dom)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  clearTimeout(flyTimer)
  stops.forEach((s) => s())
  surface?.dispose()
  detail?.dispose()
  drawnTiles?.dispose()
  celestial?.dispose()
  atmosphere?.dispose()
  drawing?.dispose()
  routes?.dispose()
  frontiers?.dispose()
  for (const m of capMaterials.values()) m.dispose()
  capMaterials.clear()
  resizeObs?.disconnect()
  globe?._destructor()
})
</script>

<template>
  <div ref="el" class="globe" />
</template>

<style scoped>
.globe {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
</style>

<style>
/* Pins are created imperatively by the globe's HTML layer, so unscoped.
   CSS2DRenderer centres the wrapper on the coordinate; shifting the SVG up by
   half its height puts the pin's tip on the spot instead. */
/* the globe's HTML pin layer, pinned below every panel — see tokens.css */
.globe-css2d {
  z-index: var(--z-globe-overlay);
  /*
   * THE ONE VALUE INSIDE THIS CONTAINER THAT IS NOT CSS2DRenderer'S TO GIVE.
   *
   * Everything in here is depth-sorted by three.js every frame: it stamps an
   * INLINE `z-index` of 0..N (N being the number of CSS2D objects in the scene —
   * every pin, every badge, every drawing label) onto each element, nearest
   * camera highest. That is what a map wants, with one exception: the pin the
   * reader has open must be on top of all of it, at every camera angle and
   * inside every stack, or the answer to "where is the thing I just opened" is
   * "behind that other pin". A fixed rank cannot beat a bound that grows with
   * the scene, so the selection is given the top of the range outright.
   *
   * It is a number and not a token because it is not on the app's z-scale: it
   * lives *inside* this container's stacking context (that is the whole job of
   * --z-globe-overlay, see tokens.css), so however large it is it cannot reach
   * a panel.
   */
  --z-pin-selected: 2147483000;
}

/* Drawing labels (lib/drawingLayer.ts). CSS2D, so they live in the same
   container the pins do and inherit its z-index. Small caps and a hard halo:
   these sit on satellite imagery — snowfield, forest, ocean — with nothing
   behind them, so the outline is not decoration, it is the only thing keeping
   them readable. Never a click target; the pin under them must win. */
.drawing-label {
  font-family: var(--cond);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #f2f6fc;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
  text-shadow:
    0 0 3px rgba(2, 5, 10, 0.95),
    0 0 6px rgba(2, 5, 10, 0.8),
    0 1px 0 rgba(2, 5, 10, 0.9);
}
.drawing-label--md {
  font-size: 12.5px;
  letter-spacing: 0.18em;
  color: #fff;
}
/* ON PAPER (lib/drawingLayer.ts, `ground`). The rule above is white letters
   inside a hard black halo, which is the only thing that reads over snowfield,
   forest and open ocean. On the drawn map it is precisely backwards: the
   letters sit at 1.1:1 against parchment and disappear, leaving the halo behind
   as a grey smudge where a word should be. So the pair is inverted — the map's
   own ink for the letters, its own paper for the halo — and the weight goes up
   a step, because a light ground makes a stroke read thinner than it is. */
.drawing-label--paper,
.drawing-label--paper.drawing-label--md {
  color: #221c12;
  font-weight: 700;
  text-shadow:
    0 0 3px rgba(240, 232, 210, 0.95),
    0 0 6px rgba(240, 232, 210, 0.85),
    0 1px 0 rgba(240, 232, 210, 0.9);
}

.event-pin svg {
  display: block;
  /* --pin-shift lifts the artwork so the pin's *tip* (not the box centre) lands
     on the coordinate; area pins carry extra box below the tip, cluster badges
     are centred and set it to 0. */
  transform: translateY(var(--pin-shift, -50%));
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
  transition: opacity var(--fast);
}
/* THE SELECTED PIN IS ON TOP OF EVERY OTHER PIN AND EVERY LABEL, and
   `!important` is the mechanism rather than a shout: CSS2DRenderer writes the
   depth-sorted z-index INLINE, on every element, on every frame, and an
   important author rule is the one thing in the cascade that outranks an inline
   declaration. The old `z-index: 2` here never applied at all — it lost to the
   inline value silently, which is why a selected pin could sit behind its
   neighbour. A selected BADGE carries the same class for the same reason. */
.event-pin--selected {
  z-index: var(--z-pin-selected) !important;
}
/* Hover is a BRIGHTENING and nothing else, deliberately: the pin under the
   cursor gains no rim and no ground ring, so "the one I am pointing at" and
   "the one I have open" are never the same statement. */
.event-pin:hover svg {
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55)) brightness(1.15);
}
/* the footprint breathes, so an area pin is legible as one even while still */
.event-pin--area .pin-footprint {
  transform-box: fill-box;
  transform-origin: center;
  animation: pin-footprint 2.6s var(--ease) infinite;
}
@keyframes pin-footprint {
  0%,
  100% {
    transform: scale(0.86);
    opacity: 0.75;
  }
  50% {
    transform: scale(1.06);
    opacity: 1;
  }
}
.event-pin--cluster svg {
  filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.6));
}
/* Significance tiers (lib/eventTiers.ts). Size is drawn into the SVG; what is
   left here is depth — how far forward each tier sits — which is opacity and
   light, not another shape. Tier 1 also carries a glow ring in its artwork, so
   its drop shadow is warmed slightly to match rather than doubled.
   Not stacking: a plain `z-index` here is dead, because CSS2DRenderer's inline
   depth sort outranks it (see `--z-pin-selected`), and the depth sort is the
   right answer for everything except the pin the reader has open. */
.event-pin--tier1 svg {
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6)) drop-shadow(0 0 6px rgba(255, 240, 200, 0.35));
}
.event-pin--tier3 svg {
  opacity: 0.72;
}
.event-pin--tier3:hover svg {
  opacity: 1;
}
/* the minor tier: present, but not asking for attention */
.event-pin--minor svg {
  opacity: 0.62;
}
.event-pin--minor:hover svg {
  opacity: 1;
}
/* selected always wins, whatever tier it is in */
.event-pin--selected svg,
.event-pin--selected.event-pin--minor svg {
  opacity: 1;
}
/* A child the open step named (see Step.highlights). The accent ring is drawn
   into the artwork; what is left here is full opacity, because a highlighted
   pin must not be dimmed by the tier it happened to land in. Its place in the
   stack is the camera's to decide, like every pin's but the selected one. */
.event-pin--accent svg,
.event-pin--accent.event-pin--minor svg,
.event-pin--accent.event-pin--tier3 svg {
  opacity: 1;
}
/* MAP MODE (lib/present/mode.ts). A drawn map has no light in it, so the pins
   lose the things that model light — the drop shadow, the tier glow's warm
   halo, the breathing footprint — and keep everything that is a line. */
.event-pin--flat svg,
.event-pin--flat.event-pin--tier1 svg {
  filter: none;
}
/* …except the hover lift, which is feedback rather than lighting. */
.event-pin--flat:hover svg {
  filter: brightness(1.15);
}
.event-pin--flat .pin-footprint {
  animation: none;
}
</style>
