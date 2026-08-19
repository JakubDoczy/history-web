import { createServer } from 'vite'
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const { chromium } = pw.chromium ? pw : pw.default
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const server = await createServer({ root: process.cwd(), server: { port: 0 }, logLevel: 'warn' })
await server.listen()
const base = `http://localhost:${server.httpServer.address().port}`
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
await page.goto(base, { timeout: 90_000 })
await page.waitForFunction(() => window.__events?.all.length > 0 && window.__globe)
await page.evaluate(() => window.__setTime(1941))
await page.waitForTimeout(2000)
// drawn map, 1941: the floor is MIN_ALTITUDE_DETAIL. Ask for far below it.
const probe = async (mode, year, ask) => {
  await page.evaluate((m) => window.__settings.setMode(m), mode)
  await page.evaluate((y) => window.__setTime(y), year)
  await page.waitForTimeout(800)
  await page.evaluate((a) => window.__globe.pointOfView({ lat: 50.45, lng: 30.52, altitude: a }, 0), ask)
  await page.waitForTimeout(1500)
  // nudge controls so the clamp applies
  await page.mouse.move(550, 400)
  await page.mouse.wheel(0, -1)
  await page.waitForTimeout(1200)
  return page.evaluate(() => window.__globe.pointOfView().altitude)
}
console.log('drawn 1941, ask 1e-5   ->', await probe('schematic', 1941, 1e-5))
console.log('sat   1941, ask 1e-5   ->', await probe('realistic', 1941, 1e-5))
console.log('sat   1800, ask 1e-3   ->', await probe('realistic', 1800, 1e-3))
console.log('drawn 1941, ask 0.0016 ->', await probe('schematic', 1941, 0.0016), '(closest authored step camera)')
await browser.close(); await server.close()
