import type { Palette } from '../palette'
import type { VisualStyle } from '../../stores/settings'
import { assertNever } from '../variant'
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
  /** Streamed high-resolution imagery (lib/detailImagery.ts). */
  imagery: boolean
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
 * Map mode's grade: most of the colour gone, contrast up a little.
 *
 * Not neutral and not grey — a map with no colour at all cannot carry the tag
 * palette the pins are drawn in, which is the one piece of colour coding on this
 * globe worth keeping. This desaturates the *ground* until the ink on top of it
 * is unmistakably the subject.
 */
export const SCHEMATIC_PALETTE: Palette = { saturation: 0.42, grayscale: 0.45, contrast: 0.88 }

/**
 * What map mode CANNOT switch off, written down so the next person does not
 * hunt for it: the surface shader carries an atmospheric rim term of its own
 * (`rim` in lib/globeSurface.ts), unconditional and scaled by daylight. With
 * the terminator flattened, daylight is 1 everywhere, so the rim runs all the
 * way round the limb instead of only along the lit half. It reads as a warm
 * halo on the horizon. Removing it means a new uniform in the surface shader,
 * which is a bigger change than this mode has earned yet.
 */


/** The flat field map mode sits the planet on, instead of a starfield. */
export const SCHEMATIC_BACKGROUND = '#080b12'
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
        imagery: s.detail,
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
        // The streamed patch is a photograph, which is the one thing a
        // schematic map is not. It is also the most expensive thing the app
        // does, so map mode is cheap as a side effect rather than as a goal.
        imagery: false,
        // Not quite the whole enhanced lift, and this is a tuned number rather
        // than a principled one. The curve exists to keep a photographed planet
        // readable across a terminator; there is no terminator here (see
        // `flatLight`), so the whole of it blows the ice and the deserts out,
        // while none of it leaves the raw basemap too dark to read as a map.
        // 0.85 is where the A/B landed.
        boost: 0.85,
        flatLight: 1,
        palette: { ...SCHEMATIC_PALETTE },
      }
    default:
      return assertNever(mode)
  }
}
