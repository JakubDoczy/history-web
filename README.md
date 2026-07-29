# history-web

An interactive globe for exploring Earth's history: continents drift, nations
appear and change shape, and events surface on a zoomable timeline spanning
4.5 billion years to the present.

Live: https://jakubdoczy.github.io/history-web/

## Running it

Node 20+.

```sh
npm install
npm run dev      # local dev server
npm test         # unit tests (vitest)
npm run build    # type-check + production build into dist/
```

## Deploying

The site is served from the `gh-pages` branch, which contains build output only.

```sh
GITHUB_TOKEN=ghp_xxx ./scripts/deploy.sh
```

The script runs the tests first and refuses to publish if they fail.

### The token

Create a **classic** personal access token with the single `repo` scope
(Settings → Developer settings → Tokens (classic)). Fine-grained tokens also
work but need Contents: read & write on this repository specifically, which is
easy to get subtly wrong.

Pass it via the environment as above. **Never commit it**, and rotate it if it
has ever been pasted into a chat, an issue, or a log.

## Layout

```
src/
├── lib/          pure logic — time, events, eras, nations, imagery, shaders
├── stores/       Pinia state (time, events, nations, settings, view, ui)
├── components/   globe, timeline, panels
├── clouds/       parked cloud simulation (not in the render path)
└── data/         sample events, nations, texture keyframes
docs/             requirements and plans
scripts/          texture generators and the deploy script
tests/            unit tests, one file per lib module
```

Logic lives in `src/lib` as pure functions so it can be tested without a
browser; components stay thin. Anything that renders is verified indirectly —
by testing the maths it depends on.

## Conventions worth keeping

- **Tests gate deploys.** Not a formality: most bugs here were geometry or
  lifecycle errors that a browser would have shown but a sandbox would not.
- **Never put an unverified data source ahead of a working one.** Load the
  reliable one first, then upgrade if the better one arrives.
- **Shaders**: `tests/shader.test.ts` checks for duplicate uniform declarations,
  which fail silently and render the globe black.
- **Comment the surprises, not the obvious** — why a threshold has hysteresis,
  why a clamp exists, why a source was rejected.
