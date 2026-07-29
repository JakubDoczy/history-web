# Texture credits

- `clouds.jpg` — cloud coverage mask, derived from the example asset shipped with
  [three-globe](https://github.com/vasturiano/three-globe) (MIT), itself based on
  NASA Visible Earth imagery (public domain). Converted here to a single-channel
  JPEG mask.
- `paleo/*.jpg`, `moon.jpg` — generated procedurally by `scripts/gen_paleo_v3.py`
  and `scripts/gen_moon.py` in this repository.

## Streamed imagery

- Base map: NASA GIBS / Worldview, `BlueMarble_ShadedRelief_Bathymetry` (public domain).
- High detail: **Sentinel-2 cloudless** — https://s2maps.eu by EOX IT Services GmbH
  (contains modified Copernicus Sentinel data 2020). Attribution is required and is
  shown in the app's settings panel while the layer is in use. The 2018–2024
  mosaics are licensed for **non-commercial use**; the 2016 mosaic
  (`s2cloudless-2016`) is CC BY 4.0 if unrestricted use is ever needed.
