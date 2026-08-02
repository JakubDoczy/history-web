<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, useTemplateRef, watchEffect } from 'vue'
import Globe, { type GlobeInstance } from 'globe.gl'
import { AmbientLight, DirectionalLight, PerspectiveCamera, Vector3 } from 'three'
import { useEventStore } from '../stores/events'
import { useNationStore, type BorderEntry } from '../stores/nations'
import { useTimeStore } from '../stores/time'
import { useSettingsStore } from '../stores/settings'
import { useViewStore } from '../stores/view'
import { isEvent, type HistoricalEvent } from '../lib/events'
import { densifyPaths, type GeoPath } from '../lib/paths'
import type { Ring } from '../lib/nations'
import { GlobeSurface } from '../lib/globeSurface'
import { RenderPump } from '../lib/renderPump'
import { firstFrame } from '../lib/firstFrame'
import { AtmosphereLayer } from '../lib/skyLayer'
import {
  DetailImagery,
  visibleSpanDeg,
  viewSpanDeg,
  minAltitudeFor,
  patchPixelCap,
} from '../lib/detailImagery'
import { cloudFadeFor, cloudSharpenFor, cloudIdleIntervalMs } from '../lib/scale'
import { CelestialLayer } from '../lib/celestialLayer'
import { eraPlan, modernShare } from '../lib/paleo'
import { subsolarLongitude, cityLightsFactor } from '../lib/sun'
import { pinElement, clusterElement, pinStateKey } from '../lib/eventPins'
import {
  clusterEvents,
  clusterSpanBucket,
  fanViewFor,
  layoutPins,
  legStrokeDeg,
  type ClusterLeg,
  type FanView,
  type PinDatum,
} from '../lib/eventClusters'
import { cameraScope, sameScope } from '../lib/viewport'
import { stableByKey } from '../lib/stableIdentity'
import type { Tier } from '../lib/eventTiers'
import { primaryTag, tagColor } from '../lib/tags'
import { PALEO_FRAMES, MODERN_TEXTURE, NIGHT_TEXTURE, RELIEF_TEXTURE, SKY_TEXTURE } from '../data/paleoTextures'

const events = useEventStore()
const nations = useNationStore()
const time = useTimeStore()
const settings = useSettingsStore()
const view = useViewStore()
const el = useTemplateRef('el')

let globe: GlobeInstance | undefined
let surface: GlobeSurface | undefined
let celestial: CelestialLayer | undefined
let atmosphere: AtmosphereLayer | undefined
let detail: DetailImagery | undefined
let resizeObs: ResizeObserver | undefined
let raf = 0
const stops: (() => void)[] = []

type EventAreaEntry = {
  kind: 'area'
  event: HistoricalEvent
  ring: Ring
  /** GeoJSON Polygon `coordinates`, closed — held, like the entry itself. */
  coordinates: Ring[]
}
type PolyEntry = BorderEntry | EventAreaEntry

/** One drawn route of the selected event; `points` is already densified. */
type EventPathEntry = {
  event: HistoricalEvent
  points: GeoPath
}

/** What the polygon layer was last given; see the watcher that fills it. */
let lastPolys: PolyEntry[] = []
/** …and the paths layer. Same rule: only re-set when the list really changed. */
let lastPaths: EventPathEntry[] = []
/** Is a route on screen? The dash animation needs frames while one is (see `tick`). */
let routesDrawn = false

const asPin = (d: object) => d as PinDatum
const asLeg = (d: object) => d as ClusterLeg
const asPoly = (d: object) => d as PolyEntry
const asPath = (d: object) => d as EventPathEntry

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
type KeyedPin = PinDatum & { key: string; tier: Tier }
const pinData = new Map<string, KeyedPin>()
const pinEls = new Map<string, HTMLElement>()

/**
 * A pin's tier: its own, or — for a badge — its dominant member's.
 *
 * Dominant by *tier*, not by the raw priority the cluster is anchored on: the
 * two orders differ once the coverage penalty is applied, and a badge hiding
 * the set's leading event has to say so whichever member the badge is sitting
 * on. Anything not in the map is not in the result set and cannot lead it.
 */
const tierOf = (p: PinDatum, tiers: ReadonlyMap<string, Tier>): Tier =>
  p.kind === 'cluster'
    ? (p.members.reduce<Tier>((best, m) => Math.min(best, tiers.get(m.id) ?? 3) as Tier, 3))
    : (tiers.get(p.event.id) ?? 3)

const stablePins = (pins: PinDatum[], tiers: ReadonlyMap<string, Tier>, selectedId?: string): KeyedPin[] =>
  stableByKey<PinDatum, KeyedPin>(
    pinData,
    pins,
    (p) => pinStateKey(p, selectedId, tierOf(p, tiers)),
    (p, key) => ({ ...p, key, tier: tierOf(p, tiers) }) as KeyedPin,
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
  const sel = events.selected
  // only an event has a footprint; a person or a concept is an article
  const e = sel && isEvent(sel) ? sel : undefined
  if (!e?.area) return []
  const held = areaEntries.get(e.id)
  if (held) return [held]
  const ring = e.area
  const entry: EventAreaEntry = { kind: 'area', event: e, ring, coordinates: [[...ring, ring[0]]] }
  areaEntries.set(e.id, entry)
  return [entry]
}

/**
 * The routes of the selected event, on exactly the same terms as its footprint:
 * drawn while the panel is open on it, gone when it closes, held by id so the
 * layer is not handed a new object for a line it is already drawing.
 *
 * Densified here rather than in the data (lib/paths.ts): the renderer fills the
 * gaps between waypoints *linearly in lat/lng*, so an ocean leg authored as two
 * ports would be drawn as a rhumb line rather than the great circle a ship
 * sails. Doing it at entry-build time means it happens once per event, not once
 * per frame.
 */
const pathEntries = new Map<string, EventPathEntry[]>()
const eventPaths = (): EventPathEntry[] => {
  const sel = events.selected
  const e = sel && isEvent(sel) ? sel : undefined
  if (!e?.paths?.length) return []
  const held = pathEntries.get(e.id)
  if (held) return held
  const entries = densifyPaths(e.paths).map((points) => ({ event: e, points }))
  pathEntries.set(e.id, entries)
  return entries
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
      const key = (d as KeyedPin).key ?? pinStateKey(p, events.selectedId, tier)
      const held = pinEls.get(key)
      if (held) return held
      const el =
        p.kind === 'cluster'
          ? clusterElement(p.members, tier, () =>
              // the live span, not the quantised one: it is compared against
              // the live span on the next zoom
              events.expandCluster(p.id, visibleSpanDeg(view.altitude)),
            )
          : pinElement(p.event, events.selectedId === p.event.id, tier, () =>
              events.select(p.event.id),
            )
      pinEls.set(key, el)
      return el
    })
    .htmlElementVisibilityModifier((el, visible) => {
      el.style.opacity = visible ? '1' : '0'
      el.style.pointerEvents = visible ? 'auto' : 'none'
    })
    // arcs layer: the legs of an expanded cluster, anchor out to each member,
    // so a fanned pin still reads as belonging to the spot it came from
    .arcStartLat((d) => asLeg(d).startLat)
    .arcStartLng((d) => asLeg(d).startLng)
    .arcEndLat((d) => asLeg(d).endLat)
    .arcEndLng((d) => asLeg(d).endLng)
    .arcColor((d: object) => {
      const c = tagColor(primaryTag(asLeg(d).event))
      return [c + '10', c + 'cc'] // fades in from the anchor so the badge stays clean
    })
    .arcAltitude(0.004)
    // the legs are measured on screen like the fan they belong to; the layer is
    // only ever re-digested while a fan is open, which is when this changes
    .arcStroke(() => legStrokeDeg(liveFan()))
    .arcsTransitionDuration(180)
    // polygons layer: nation borders + the selected event's area
    // The coordinate array comes from the entry rather than being built here:
    // three-globe re-tessellates the cap whenever this is a different array
    // object than last time, whatever the numbers in it say.
    .polygonGeoJsonGeometry((d) => ({
      type: 'Polygon',
      coordinates: asPoly(d).coordinates as unknown as number[],
    }))
    // Borders read as a drawn line, not a wash of colour. The cap is fully
    // transparent on purpose: caps are lit Lambert meshes, so on the night side
    // of the terminator even a 13% tint renders as a dark sheet that blots out
    // the map (strokes are unlit lines and stay crisp everywhere). The
    // invisible cap still catches hover/click for the label.
    .polygonCapColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return tagColor(primaryTag(p.event)) + '38'
      return 'rgba(0,0,0,0)'
    })
    // No side colour at all, rather than a transparent one: three-globe reads
    // this as "no sides" and builds the cap alone, which is one fewer mesh and
    // one fewer wall of triangles per ring for something that was drawn at zero
    // opacity anyway. The invisible *cap* stays — it is the hover/click target.
    .polygonSideColor(() => '')
    .polygonStrokeColor((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') return tagColor(primaryTag(p.event))
      return p.nation.color
    })
    // Borders sit almost on the surface, and always under the event pins (0.006).
    .polygonAltitude((d) => (asPoly(d).kind === 'area' ? 0.012 : 0.004))
    .polygonLabel((d) => {
      const p = asPoly(d)
      return p.kind === 'area' ? p.event.name : p.label
    })
    .onPolygonClick((d) => {
      const p = asPoly(d)
      if (p.kind === 'area') events.select(p.event.id)
    })
    .polygonsTransitionDuration(300)
    // paths layer: the routes of the selected event — trade roads, voyages, the
    // legs of the Atlantic triangle. Same lifecycle as the area polygon above:
    // nothing is drawn until an event is opened, and closing the panel clears it.
    //
    // Points are `[lng, lat]`, the order every other piece of geometry in the
    // dataset uses; the layer's own default is the other way round, hence the
    // two accessors.
    .pathPoints((d) => asPath(d).points)
    .pathPointLng((p) => (p as [number, number])[0])
    .pathPointLat((p) => (p as [number, number])[1])
    // Just clear of the surface — above the area cap (0.012), so a route over
    // its own event's footprint is not tinted by it, and far below the pins,
    // which are HTML and draw over the scene regardless.
    .pathPointAlt(0.014)
    // The entries arrive densified (see `eventPaths`), so the layer's own
    // linear fill-in has nothing left to get wrong; 1° keeps its subdivision
    // finer than ours rather than coarser.
    .pathResolution(1)
    .pathColor((d: object) => tagColor(primaryTag(asPath(d).event)))
    // A fat line (any non-null stroke) rather than the layer's 1 px default:
    // width is in screen pixels, so the route stays legible zoomed out to the
    // whole ocean it crosses and does not thicken into a band zoomed in.
    .pathStroke(2.2)
    // A dashed line that runs is the difference between "here is a corridor"
    // and "things moved along here" — direction, at the cost of frames (see the
    // `routesDrawn` wake in `tick`). Dash and gap are in units of line length,
    // so a long voyage and a short one carry the same *number* of dashes rather
    // than the same dash size, which keeps both legible.
    .pathDashLength(0.02)
    .pathDashGap(0.012)
    .pathDashAnimateTime(still ? 0 : 9000)
    .pathTransitionDuration(400)
    .pathLabel((d) => asPath(d).event.name)
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
  // A patch at the 4096 ceiling is a 33 MB texture upload, and the composite is
  // re-uploaded whenever the view moves — so what the device can afford, not
  // what GL permits, is the right ceiling. See patchPixelCap.
  detail = new DetailImagery({
    maxPx: patchPixelCap({
      maxTextureSize: globe.renderer().capabilities.maxTextureSize,
      devicePixelRatio: window.devicePixelRatio,
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
    }),
  })
  // dev-only handle, alongside __globe: the streaming pipeline's failures are
  // all "what is on screen now versus a moment ago" questions, and without a
  // way to read the loader's own state a screenshot cannot tell a patch that
  // got sharper from one that got blurrier. Never exists in a production build.
  if (import.meta.env.DEV) (window as unknown as { __detail?: DetailImagery }).__detail = detail
  if (import.meta.env.DEV) {
    ;(window as unknown as { __detail?: DetailImagery }).__detail = detail
  }
  // the patch only reaches the shader if the loader tells us it arrived
  detail.onReady = () => {
    // a load can resolve after imagery was switched off or the time scrubbed
    // into deep time; adopting it then would flash a patch nobody asked for
    if (!detailAllowed()) return
    view.detailStatus = detail!.status
    view.detailSource = detail!.sourceLabel
    view.detailAttribution = detail!.attribution
    view.detailGroundRes = detail!.groundRes
    surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix, detail!.lod)
    wake() // a patch that arrived while the globe was parked still has to appear
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
  const detailAllowed = () => settings.detail && time.currentTime > -12000

  /**
   * The only place detail streaming is driven. It was previously called from
   * both the zoom handler and the frame loop with different arguments, so the
   * two computed different rectangles and fought over which one to load.
   */
  const syncDetail = (pov: { lat: number; lng: number; altitude: number }) => {
    if (!detailAllowed()) {
      surface!.setDetail(null, detail!.rect, 0)
      return
    }
    // device pixels, not CSS pixels: the globe renders at the device ratio
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    const w = el.value?.clientWidth ?? 900
    const h = el.value?.clientHeight ?? 900
    // the camera's own fov, so the patch is cut to the frame rather than to the
    // horizon — close in those differ by more than an order of magnitude
    detail!.update(pov.lat, pov.lng, pov.altitude, h * dpr, w / h, view.fov)
    surface!.setDetail(detail!.texture ?? null, detail!.rect, detail!.mix, detail!.lod)
  }

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
    globe!.controls().minDistance = radius * (1 + minAltitudeFor(time.currentTime, settings.detail))
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
    surface!.setFlatLight(near)
    lastSync = { ...pov }
    syncDetail(pov)
    // The framed span, not the horizon `span` below: close in the two differ by
    // more than an order of magnitude, and it is the framed one that says how
    // many pixels a degree of ground is worth — which is what decides whether
    // 30 Hz is enough to keep the deck's motion sub-pixel.
    framedSpanDeg = viewSpanDeg(pov.altitude, view.fov)
    // clouds retire well before the ground fills the screen; haze lingers longer
    const cloudy = cloudFadeFor(span)
    surface!.setCloudSharpen(cloudy > 0.01 ? cloudSharpenFor(span) : 0)
    surface!.setClouds(
      settings.clouds && cloudy > 0.01,
      (time.currentTime > -12000 ? 1 : 0) * cloudy,
      settings.cloudShadows,
    )
    atmosphere!.visible = settings.atmosphere && near < 0.9
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
  const stats = { wakes: 0, resumes: 0, pauses: 0, drifts: 0, ticks: 0 }
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
  // The hover raycast lives inside the render loop, so a pointer that moves over
  // a parked globe has to buy frames for the hover to be found and the tooltip
  // to be drawn. Leaving buys the frames that clear it again.
  for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'pointerleave', 'wheel']) {
    dom.addEventListener(ev, () => wake(), { passive: true })
  }

  const t0 = performance.now()
  let lastFrame = t0
  let lastDrift = t0
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
    if (!still) surface!.setCloudDrift(now - t0)
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
    // Neither is the dash animation on a drawn route: three-globe advances it
    // from the frame loop, so a parked globe freezes it mid-stride. This is the
    // one animation in the app that keeps the pump running on an idle camera,
    // and it is bounded by the thing that started it — a path event being open
    // in the panel. Reduced motion turns it off, like every other motion here.
    if (routesDrawn && !still) wake(0)

    if (pump.running) {
      // streaming is a function of where the camera is, and the camera cannot
      // move while the loop is parked; the settle timer inside DetailImagery is
      // already armed and lands the sharp patch on its own
      const pov = globe!.pointOfView()
      if (povMoved(lastSync, pov)) {
        lastSync = { ...pov }
        movedAt = now
        syncDetail(pov)
      }
    }
    // deferred work waits for a still camera as well as an idle browser
    surface!.setBusy(now - movedAt < STILL_MS)

    if (dayReady && framesSinceReady < 2) {
      wake()
      framesSinceReady++
      if (framesSinceReady === 2) {
        ;(window as unknown as { __globeReady?: () => void }).__globeReady?.()
        // and only now the maps the first frame did without: they have the
        // network and the main thread to themselves from here on
        surface!.loadRest()
        // The starfield is one of them. globe.gl gives no callback for the
        // background texture, so nothing can wake the pump exactly when it
        // lands — but the pump's one-second safety tick bounds the wait, and
        // the three maps above each wake it as they arrive in the same window.
        globe!.backgroundImageUrl(SKY_TEXTURE)
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
      const next = [...nations.borders, ...eventAreas()]
      if (next.length === lastPolys.length && next.every((p, i) => p === lastPolys[i])) return
      lastPolys = next
      globe!.polygonsData(next)
      wake()
    }),
    // The selected event's routes. Same guard as the polygons above: handing the
    // layer an equal-but-new list would rebuild every line and restart its
    // transition.
    watchEffect(() => {
      const next = eventPaths()
      if (next.length === lastPaths.length && next.every((p, i) => p === lastPaths[i])) return
      lastPaths = next
      routesDrawn = next.length > 0
      globe!.pathsData(next)
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
        900,
      )
      // the default cushion (1.5 s) outlasts the 900 ms flight, and OrbitControls
      // announces every damping step of it anyway
      wake()
    }),
    // The relief map is the modern height field; deep-time frames carry their own
    // baked hillshade, so it fades out exactly as they fade in.
    watchEffect(() => {
      surface!.setRelief(settings.relief ? 0.7 * modernShare(PALEO_FRAMES, time.currentTime) : 0)
      wake()
    }),
    watchEffect(() => {
      surface!.setVisuals(settings.visuals === 'enhanced' ? 1 : 0)
      wake()
    }),
    watchEffect(() => {
      surface!.setPalette(settings.palette)
      wake()
    }),
    // The plan carries more than the crossfade: which frames stay resident and
    // which one to warm next, both of which depend on the *direction* the cursor
    // is moving, so the previous time is part of the input.
    watchEffect(() => {
      const t = time.currentTime
      surface!.setEra(eraPlan(PALEO_FRAMES, t, prevEraTime))
      prevEraTime = t
      wake()
    }),
    watchEffect(() => {
      surface!.setCityLights(cityLightsFactor(time.currentTime))
      wake()
    }),
    // clouds are anachronistic detail in deep time, and would hide the plate drift
    watchEffect(() => {
      void settings.clouds
      void settings.atmosphere
      void settings.detail
      void time.currentTime
      applyPov(true) // a settings change, not a camera move: run it regardless
    }),
    watchEffect(() => {
      const dir = sunDir()
      surface!.setSun(dir)
      atmosphere!.setSunDirection(dir)
      dirLight?.position.copy(dir.clone().multiplyScalar(radius * 4))
      celestial!.setHour(settings.sunHour, coords)
      wake()
    }),
  )

  resizeObs = new ResizeObserver(() => {
    globe?.width(dom.clientWidth).height(dom.clientHeight)
    applyPov(true) // the scale bar reads viewportPx; without this it is stale until the next zoom
    wake()
  })
  resizeObs.observe(dom)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  stops.forEach((s) => s())
  surface?.dispose()
  detail?.dispose()
  celestial?.dispose()
  atmosphere?.dispose()
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
}

.event-pin svg {
  display: block;
  /* --pin-shift lifts the artwork so the pin's *tip* (not the box centre) lands
     on the coordinate; area pins carry extra box below the tip, cluster badges
     are centred and set it to 0. */
  transform: translateY(var(--pin-shift, -50%));
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
  transition: opacity var(--fast, 0.15s ease);
}
.event-pin--selected {
  z-index: 2;
}
.event-pin:hover svg {
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55)) brightness(1.15);
}
/* the footprint breathes, so an area pin is legible as one even while still */
.event-pin--area .pin-footprint {
  transform-box: fill-box;
  transform-origin: center;
  animation: pin-footprint 2.6s var(--ease, ease) infinite;
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
   stacking, not another shape. Tier 1 also carries a glow ring in its artwork,
   so its drop shadow is warmed slightly to match rather than doubled. */
.event-pin--tier1 {
  z-index: 1;
}
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
</style>
