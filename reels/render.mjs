// Renders a reel from a data file: node reels/render.mjs reels/data/<slug>.json [--still 0.5,4.0]
// Output: reels/out/<slug>.mp4 (1080x1920, 30 fps, H.264 + silent AAC track, Instagram's reel spec) and, with
// --still, a PNG per time given. The template draws each frame from the timeline, so a render is repeatable.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright"); // the pre-installed Playwright
const here = dirname(fileURLToPath(import.meta.url));
const dataPath = resolve(process.argv[2] ?? "");
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const slug = data.slug ?? basename(dataPath, ".json");
const stillArg = process.argv.indexOf("--still");
const stills = stillArg > 0 ? process.argv[stillArg + 1].split(",").map(Number) : null;
const FPS = 30;
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, "template.html")).href);
await page.evaluate((d) => window.build(d), data);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);

if (stills) {
  for (const t of stills) {
    await page.evaluate((x) => window.setTime(x), t);
    const file = join(out, `${slug}-t${t}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} else {
  const file = join(out, `${slug}.mp4`);
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-crf", "18", "-r", String(FPS),
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((x) => window.setTime(x), i / FPS);
    const buf = await page.screenshot({ type: "png" });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r, j) => ff.on("close", (c) => (c === 0 ? r() : j(new Error(`ffmpeg exited ${c}`)))));
  console.log(file, `${frames} frames, ${duration.toFixed(1)}s`);
}
await browser.close();
