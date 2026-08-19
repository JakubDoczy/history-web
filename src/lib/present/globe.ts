import type { Palette } from '../palette'
import type { VisualStyle } from '../../stores/settings'
import { assertNever } from '../variant'
import { DETAIL_MODE } from '../globeSurface'
import type { RenderMode } from './mode'

/**
 * WHAT THE PLANET LOOKS LIKE — every visual decision GlobeView used to take by
 * reading the settings store, in one value.
 *
 * The problem this fixes is not tidiness. Those reads were scattered across nine
 * `watchEffect`s and a camera callback, and each one was `settings.x` used
 * directly as a uniform: `settings.clouds && cloudy > 0.01`, `settings.relief ?
 * 0.7 * share : 0`, `settings.visuals === 'enhanced' ? 1 : 0`. That is fine
 * while there is one look. It is impossible the moment there are two, because
 * "off in map mode" would have to be written into every one of those
 * expressions, and the day someone adds a tenth they will not know to.
 *
 * So the settings say what the READER asked for, this says what the RENDERER
 * does about it, and the mode is what stands between them.
 */

/** The knobs a look is resolved FROM: the reader's own settings. */
export interface GlobeSettings {
  clouds: boolean
  cloudShadows: boolean
  atmosphere: boolean
  relief: boolean
  detail: boolean
  visuals: VisualStyle
  palette: Palette
}

/** The look itself. Every field is something a renderer can act on directly. */
export interface GlobeStyle {
  mode: RenderMode
  /** The drifting cloud deck. */
  clouds: boolean
  /** …and the shadow it casts on the ground. */
  cloudShadows: boolean
  /** The blue rim and the haze around the limb. */
  atmosphere: boolean
  /** Strength of the relief map, 0..1. Zero is a flat planet. */
  relief: number
  /** The starfield behind the globe. */
  stars: boolean
  /** The sun and the moon in the frame (lib/celestialLayer.ts). */
  celestial: boolean
  /** The colour behind it when there are no stars. */
  background: string
  /** City lights on the night side. */
  night: boolean
  /**
   * WHICH TILES STREAM.
   *
   * It used to be `imagery: boolean`, and map mode's answer was `false` — a
   * schematic map is not a photograph, so it streamed nothing and was soft
   * wherever the 4096 base texture ran out. The drawn map is what turns that
   * boolean into a choice: the same pyramid, the same cache, the same atlas and
   * the same shader path, fed by a rasterizer instead of by a satellite (see
   * lib/drawnSource.ts).
   */
  tiles: TileKind
  /**
   * How a streamed tile reaches the screen: as a ratio the base map is
   * multiplied by, or painted on as the ground itself. See DETAIL_MODE — the
   * ratio assumes the tile and the base map are one picture at two
   * resolutions, and a drawing whose pen is a fixed number of tile pixels is
   * not.
   */
  detail: number
  /**
   * The atmospheric limb and the warm terminator band, 0..1.
   *
   * Zero on the drawn map, and this is the note that used to say map mode
   * COULD NOT switch it off: with the terminator flattened the rim ran right
   * round the planet as a warm halo. It is one uniform now (`uRim`).
   */
  rim: number
  /**
   * This mode prints on the drawn map's paper.
   *
   * Deep time keeps its existing reconstructions — nobody has vector coastlines
   * for the Cretaceous — but map mode's timeline carries them as build-time
   * drawn twins in the map's own palette (DRAWN_FRAMES), so scrubbing from
   * 1940 to 200 Ma changes the geography without changing the medium and the
   * shader adds nothing. What this flag still gates is the paper FLOOR: a
   * frame held over from the other mode's timeline (the one case the year
   * cannot see) is duotoned into ink-on-paper rather than shown as a
   * photograph. See `applyPaper` in lib/globeSurface.ts.
   */
  paper: boolean
  /** The whole-globe base texture: the photographed planet, or the drawn world. */
  base: BaseTexture
  /**
   * Write sRGB-encoded rather than linear.
   *
   * The surface material has always written linear values into a buffer the
   * browser treats as sRGB — see the note at the bottom of the fragment shader.
   * A photograph tuned through that missing gamma is a photograph that looks
   * right; a DRAWING tuned that way is a drawing whose ink and paper are no
   * longer the numbers the rasterizer chose. So the drawn map encodes and the
   * photographed one does not, which is the only honest way to fix it without
   * re-grading a shipped look.
   */
  encode: boolean
  /** `uBoost`: 0 = physical lighting, 1 = the enhanced curve. */
  boost: number
  /**
   * How far to suppress the day/night terminator, or `null` for "follow the
   * camera" — which is what the realistic globe does, flattening the lighting
   * only as the ground fills the frame (see `closeness` in GlobeView).
   *
   * Map mode pins it at 1: a schematic map has no sun, so it has no night.
   */
  flatLight: number | null
  palette: Palette
}

/**
 * Map mode's grade: NONE, and that is the change the drawn map made here.
 *
 * It used to be `{ 0.42, 0.45, 0.88 }` — most of the colour taken out of a
 * satellite basemap so that the ink on top of it was unmistakably the subject.
 * That was the right treatment for a photograph pressed into service as a map.
 * The ground is a drawing now, made of two parchment tones and one ink, and
 * every one of those three knobs damages it: desaturating warm paper walks it
 * toward grey, and contrast under 1 closes the small gap between sea and land
 * that the whole map is built on. The identity triple is not laziness here; it
 * is the statement that the grade belongs in the rasterizer.
 */
export const SCHEMATIC_PALETTE: Palette = { saturation: 1, grayscale: 0, contrast: 1 }

/** Which whole-globe texture the surface starts from. */
export type BaseTexture = 'modern' | 'drawn'
/** Which tile source streams under it, if any. */
export type TileKind = 'imagery' | 'drawn' | 'none'

/**
 * The board the drawn map sits on, instead of a starfield.
 *
 * Warm, and nearly black. It used to be a cold #080b12 — the sky the stars were
 * taken out of — which put a blue-black frame round a sheet of parchment and
 * made the paper read as grey. This is the same value the ink is, taken down:
 * the globe then reads as a printed sphere lying on a dark table.
 */
export const SCHEMATIC_BACKGROUND = '#17130d'
/** …and what the realistic globe uses before (and behind) the sky texture. */
export const REALISTIC_BACKGROUND = '#000000'

/**
 * Resolve the look.
 *
 * The realistic branch is a faithful restatement of what GlobeView did inline,
 * field for field — that is the whole of its job, and it is why the sweep to it
 * changed no pixel. The schematic branch is the proof that the seam holds: it
 * touches no shader, invents no uniform, and is nothing but a different set of
 * answers to the same eleven questions.
 */
export function resolveGlobeStyle(s: GlobeSettings, mode: RenderMode): GlobeStyle {
  switch (mode) {
    case 'realistic':
      return {
        mode,
        clouds: s.clouds,
        cloudShadows: s.cloudShadows,
        atmosphere: s.atmosphere,
        relief: s.relief ? 1 : 0,
        stars: true,
        celestial: true,
        background: REALISTIC_BACKGROUND,
        night: true,
        tiles: s.detail ? 'imagery' : 'none',
        detail: DETAIL_MODE.ratio,
        rim: 1,
        paper: false,
        base: 'modern',
        encode: false,
        boost: s.visuals === 'enhanced' ? 1 : 0,
        flatLight: null,
        palette: s.palette,
      }
    case 'schematic':
      return {
        mode,
        clouds: false,
        cloudShadows: false,
        atmosphere: false,
        relief: 0,
        stars: false,
        celestial: false,
        background: SCHEMATIC_BACKGROUND,
        night: false,
        // The streamed patch used to be a photograph, which is the one thing a
        // schematic map is not, so this was `false` and the mode was soft
        // wherever the base texture ran out. It is the drawn rasterizer now:
        // the same pyramid, and the reason coastlines are crisp at every zoom
        // rather than only at the one the 4096 texture happens to serve.
        tiles: 'drawn',
        detail: DETAIL_MODE.paint,
        rim: 0,
        paper: true,
        base: 'drawn',
        encode: true,
        // ZERO, where map mode used to ask for 0.85 of the enhanced curve.
        // That curve exists to keep a PHOTOGRAPHED planet readable across a
        // terminator — it lifts the land band hard and holds water back by a
        // blueness mask. Run over parchment it lifts the paper toward white,
        // crushes the sea tone into the land tone, and reads the ocean's warm
        // grey as land. The drawn base texture is already graded: it was drawn
        // that way. The right amount of curve to add to a finished drawing is
        // none.
        boost: 0,
        flatLight: 1,
        palette: { ...SCHEMATIC_PALETTE },
      }
    default:
      return assertNever(mode)
  }
}
