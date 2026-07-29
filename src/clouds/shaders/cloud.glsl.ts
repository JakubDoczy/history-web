export const cloudVertex = /* glsl */ `
out vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

export const cloudFragment = /* glsl */ `
precision highp float;
precision highp sampler3D;

in vec3 vWorldPos;
out vec4 fragColor;

uniform vec3 uCenter;
uniform float uRin;
uniform float uRout;
uniform float uRplanet;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform sampler2D uWeather;
uniform sampler3D uNoise;
uniform float uTime;
uniform float uCoverage;
uniform float uDensity;

const float PI = 3.14159265;

/** Near/far intersection of a ray with a sphere; x > y means a miss. */
vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

/** Direction to equirectangular UV, matching the -90° Y rotation of the other globe layers. */
vec2 dirToUv(vec3 d) {
  vec3 l = vec3(d.z, d.y, -d.x);
  return vec2(atan(l.z, -l.x) / (2.0 * PI) + 0.5, 0.5 + asin(clamp(l.y, -1.0, 1.0)) / PI);
}

float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) * (d - c) / max(b - a, 1e-5);
}

/** Cloud density at a world-space point. */
float densityAt(vec3 p) {
  vec3 d = p - uCenter;
  float len = length(d);
  float h = (len - uRin) / (uRout - uRin);
  if (h < 0.0 || h > 1.0) return 0.0;

  vec3 dir = d / len;
  float cov = texture(uWeather, dirToUv(dir)).r * uCoverage;
  if (cov < 0.02) return 0.0;

  // vertical profile: flat bases, rounded tops
  float grad = smoothstep(0.0, 0.18, h) * smoothstep(1.0, 0.45, h);

  // base billows, slowly turning over
  vec3 q = dir * 5.0 + vec3(0.0, uTime * 0.0035, 0.0);
  float base = texture(uNoise, q).r;
  float shape = remap(base * grad, 1.0 - cov, 1.0, 0.0, 1.0);
  if (shape <= 0.0) return 0.0;

  // erode the silhouette into wisps, more strongly toward the top
  float detail = texture(uNoise, dir * 21.0 + vec3(uTime * 0.012)).g;
  shape = remap(shape, detail * (0.28 + 0.42 * h), 1.0, 0.0, 1.0);
  return clamp(shape, 0.0, 1.0) * uDensity;
}

/** Henyey–Greenstein phase: forward scattering gives the silver lining. */
float phaseHG(float cosT, float g) {
  float gg = g * g;
  return (1.0 - gg) / (4.0 * PI * pow(1.0 + gg - 2.0 * g * cosT, 1.5));
}

/** Transmittance from a point toward the sun (blocked entirely by the planet). */
float lightTransmittance(vec3 p) {
  if (raySphere(p, uSunDir, uCenter, uRplanet).x > 0.0) return 0.0; // planet shadow
  vec2 hit = raySphere(p, uSunDir, uCenter, uRout);
  float len = max(hit.y, 0.0);
  float step = len / float(LIGHT_STEPS);
  float tau = 0.0;
  for (int i = 0; i < LIGHT_STEPS; i++) {
    tau += densityAt(p + uSunDir * (float(i) + 0.5) * step);
  }
  return exp(-tau * step * 14.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorldPos - ro);

  vec2 outer = raySphere(ro, rd, uCenter, uRout);
  vec2 inner = raySphere(ro, rd, uCenter, uRin);
  vec2 planet = raySphere(ro, rd, uCenter, uRplanet);

  float t0 = max(outer.x, 0.0);
  float t1 = outer.y;
  if (inner.x <= inner.y && inner.x > 0.0) t1 = min(t1, inner.x); // stop at the inner shell
  if (planet.x <= planet.y && planet.x > 0.0) t1 = min(t1, planet.x); // never draw through the globe
  if (t1 <= t0) discard;

  float span = t1 - t0;
  float stepLen = span / float(VIEW_STEPS);
  // jitter the start so banding becomes noise, which reads far better at low step counts
  float jitter = hash12(gl_FragCoord.xy) * stepLen;

  float cosT = dot(rd, uSunDir);
  float phase = mix(phaseHG(cosT, 0.75), phaseHG(cosT, -0.28), 0.4) * 3.2;

  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;

  for (int i = 0; i < VIEW_STEPS; i++) {
    vec3 p = ro + rd * (t0 + jitter + (float(i) + 0.5) * stepLen);
    float dens = densityAt(p);
    if (dens > 0.001) {
      float lt = lightTransmittance(p);
      // powder term: darkens the cores so clouds don't read as flat cotton
      float powder = 1.0 - exp(-dens * 9.0);
      vec3 lum = uSunColor * lt * phase * mix(1.0, powder, 0.6);
      // ambient sky bounce so shadowed sides aren't pure black
      lum += vec3(0.14, 0.18, 0.26) * (0.35 + 0.65 * lt);
      float extinction = exp(-dens * stepLen * 22.0);
      scattered += lum * dens * stepLen * 22.0 * transmittance;
      transmittance *= extinction;
      if (transmittance < 0.012) break;
    }
  }

  float alpha = 1.0 - transmittance;
  if (alpha < 0.004) discard;
  fragColor = vec4(scattered, alpha); // premultiplied
}
`
