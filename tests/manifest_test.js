// The manifest's images and index.html's iOS launch images exist and have the
// sizes declared for them.

const root = new URL("../", import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// width and height from a PNG's IHDR
async function pngSize(path) {
  const data = await Deno.readFile(new URL(path, root));
  const view = new DataView(data.buffer);
  assert(view.getUint32(12) === 0x49484452, `${path}: no IHDR`);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

// width and height from a JPEG's frame header (SOF0-SOF2)
async function jpegSize(path) {
  const data = await Deno.readFile(new URL(path, root));
  const view = new DataView(data.buffer);
  assert(view.getUint16(0) === 0xffd8, `${path}: not a JPEG`);
  for (let pos = 2; pos + 9 < data.length;) {
    const marker = view.getUint16(pos);
    if (marker >= 0xffc0 && marker <= 0xffc2) {
      return `${view.getUint16(pos + 7)}x${view.getUint16(pos + 5)}`;
    }
    pos += 2 + view.getUint16(pos + 2);
  }
  throw new Error(`${path}: no frame header`);
}

const SIZE_OF = { "image/png": pngSize, "image/jpeg": jpegSize };

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("manifest.webmanifest", root)),
);
const html = await Deno.readTextFile(new URL("index.html", root));

Deno.test("every manifest image has the size it declares", async () => {
  const images = [...manifest.icons, ...manifest.screenshots]
    .filter((image) => image.type !== "image/svg+xml");
  assert(images.length > 0, "no images");
  for (const image of images) {
    const size = await SIZE_OF[image.type](image.src);
    assert(size === image.sizes, `${image.src} is ${size}, not ${image.sizes}`);
  }
});

Deno.test("the manifest has a wide and a narrow screenshot", () => {
  for (const factor of ["wide", "narrow"]) {
    const shot = manifest.screenshots.find((s) => s.form_factor === factor);
    assert(shot !== undefined, `no ${factor} screenshot`);
    assert(typeof shot.label === "string", `${factor} has no label`);
  }
});

Deno.test("the manifest keeps one window and leaves a launch to the page", () => {
  const mode = manifest.launch_handler.client_mode;
  // focus-existing needs pwa_launch.js's launchQueue consumer, or a tapped
  // room link would only focus the running game
  assert(mode[0] === "focus-existing", `client_mode ${mode}`);
});

Deno.test("each iOS launch image matches its media query's screen", async () => {
  const links = html.match(/<link rel="apple-touch-startup-image"[^>]*>/g);
  assert(links !== null, "no launch image links");
  const seen = new Set();
  for (const link of links) {
    const media = link.match(/media="([^"]*)"/)[1];
    const href = link.match(/href="([^"]*)"/)[1];
    const number = (name) =>
      Number(media.match(new RegExp(`\\(${name}: (\\d+)`))[1]);
    const ratio = number("-webkit-device-pixel-ratio");
    const short = number("device-width") * ratio;
    const long = number("device-height") * ratio;
    const expected = media.includes("(orientation: portrait)") ?
      `${short}x${long}` :
      `${long}x${short}`;
    const size = await pngSize(href);
    assert(size === expected, `${href} is ${size}, media wants ${expected}`);
    assert(!seen.has(media), `two images for ${media}`);
    seen.add(media);
  }

  // and no image is left over
  const hrefs = new Set(links.map((l) => l.match(/href="([^"]*)"/)[1]));
  for await (const entry of Deno.readDir(new URL("static/splash/", root))) {
    assert(hrefs.has(`static/splash/${entry.name}`), `unused ${entry.name}`);
  }
});
