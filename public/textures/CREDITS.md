# Texture credits

- `clouds.jpg` — cloud coverage mask, derived from the example asset shipped with
  [three-globe](https://github.com/vasturiano/three-globe) (MIT), itself based on
  NASA Visible Earth imagery (public domain). Converted here to a single-channel
  JPEG mask.
- `clouds-nrm.webp` — cloud surface normals and ambient occlusion, derived from
  `clouds.jpg` above by `scripts/bake_clouds.py` in this repository (the mask read
  as a heightfield). Same provenance and licence as its source.
- `paleo/*.webp` — **PALEOMAP PaleoDEMs**, Scotese, C.R. & Wright, N.M. (2018),
  *PALEOMAP Paleodigital Elevation Models (PaleoDEMs) for the Phanerozoic*,
  Zenodo DOI [10.5281/zenodo.5460860](https://doi.org/10.5281/zenodo.5460860),
  licensed **CC BY 4.0**. Attribution is required and is shown in the app's
  settings panel whenever a deep-time frame is on screen. Each frame is one of
  the 109 reconstructions, rendered to this project's palette by
  `scripts/gen_paleo_v4.py` (hypsometric tint, hillshade off the reconstructed
  elevations, shelf seas, and ice caps from the age's climate state). No
  geography in them is invented or interpolated.
- `moon.jpg` — generated procedurally by `scripts/gen_moon.py` in this repository.

## Streamed imagery

- Base map: NASA GIBS / Worldview, `BlueMarble_ShadedRelief_Bathymetry` (public domain).
- High detail: **Sentinel-2 cloudless** — https://s2maps.eu by EOX IT Services GmbH
  (contains modified Copernicus Sentinel data 2020). Attribution is required and is
  shown in the app's settings panel while the layer is in use. The 2018–2024
  mosaics are licensed for **non-commercial use**; the 2016 mosaic
  (`s2cloudless-2016`) is CC BY 4.0 if unrestricted use is ever needed.
