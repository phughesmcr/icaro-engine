// src/agent.js screen tier: Agent_Screenshot and Agent_ScreenRGBA against
// stub canvases (the headless host has no renderer), and the MCP screenshot
// tool, which says it has no pixels headless.

import { mcp_session } from "./agent_mcp_client.js";
import {
  Agent_ScreenRGBA,
  Agent_Screenshot,
  SCREEN_MAX,
  SCREEN_MIN,
} from "../src/agent.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// One host per process, kept across tests (see agent_mcp_test.js)
const ENGINE_TEST = { sanitizeResources: false, sanitizeOps: false };

// A 2D canvas that records what is drawn into it
function stub_canvas(log) {
  const c = {
    width: 300,
    height: 150,
    toDataURL: (type, quality) => {
      log.push(["toDataURL", type, quality, c.width, c.height]);
      return "data:" + type + ";base64,";
    },
    getContext: (kind, opts) => {
      log.push(["getContext", kind, opts?.willReadFrequently === true]);
      return {
        drawImage: (src, x, y, w, h) =>
          log.push(["drawImage", src.name, x, y, w, h]),
        getImageData: (x, y, w, h) => {
          log.push(["getImageData", x, y, w, h]);
          return { data: new Uint8ClampedArray(w * h * 4) };
        },
      };
    },
  };
  return c;
}

// The page's canvases: a 640x480 WebGL view and its overlay
function stub_page(log) {
  return {
    gl: {
      name: "gl",
      width: 640,
      height: 480,
      ownerDocument: {
        createElement: (tag) => {
          log.push(["createElement", tag]);
          return stub_canvas(log);
        },
      },
    },
    overlay: { name: "overlay" },
  };
}

// One page for every test: the screen tier keeps the canvas it made first
const log = [];
const page = stub_page(log);

Deno.test({
  name: "agent screen: RGBA pixels at a chosen size, overlay on top",
  ...ENGINE_TEST,
  fn: () => {
    log.length = 0;
    const a = Agent_ScreenRGBA(page.gl, page.overlay, 84);
    assert(a.width === 84 && a.height === 63, "aspect kept: " + a.height);
    assert(a.data.length === 84 * 63 * 4, "RGBA bytes: " + a.data.length);
    const draws = log.filter((l) => l[0] === "drawImage").map((l) => l[1]);
    assert(draws.join() === "gl,overlay", "draw order: " + draws);
    const reads = log.filter((l) => l[0] === "getContext");
    assert(reads.length <= 1, "one context");
    assert(
      reads.length === 0 || reads[0][2] === true,
      "a context for reading back",
    );

    log.length = 0;
    const b = Agent_ScreenRGBA(page.gl, null, 64, 48);
    assert(b.width === 64 && b.height === 48, "both sizes given");
    assert(
      log.filter((l) => l[0] === "drawImage").map((l) => l[1]).join() === "gl",
      "no overlay when it is null",
    );
    assert(
      !log.some((l) => l[0] === "createElement"),
      "the canvas is reused",
    );

    const tiny = Agent_ScreenRGBA(page.gl, null, 1, 1);
    assert(tiny.width === SCREEN_MIN && tiny.height === SCREEN_MIN, "min");
    const huge = Agent_ScreenRGBA(page.gl, null, 1e6);
    assert(huge.width === SCREEN_MAX, "max");
    const def = Agent_ScreenRGBA(page.gl, null, NaN, NaN);
    assert(def.width === 84 && def.height === 63, "defaults");
  },
});

Deno.test({
  name: "agent screen: a screenshot is a data URL at a chosen width",
  ...ENGINE_TEST,
  fn: () => {
    log.length = 0;
    const url = Agent_Screenshot(page.gl, page.overlay, 320, "image/png");
    assert(url.startsWith("data:image/png"), url);
    const out = log.find((l) => l[0] === "toDataURL");
    assert(out[3] === 320 && out[4] === 240, "size " + out[3] + "x" + out[4]);
    Agent_Screenshot(page.gl, null, 8);
    const small = log.filter((l) => l[0] === "toDataURL").at(-1);
    assert(small[3] === 32 && small[1] === "image/jpeg", "min 32, JPEG");
  },
});

Deno.test({
  name: "agent screen: the MCP screenshot tool says there are no pixels",
  ...ENGINE_TEST,
  fn: async () => {
    const session = await mcp_session();
    await session.raw("start", { map: "e1m1", skill: 1, seed: 1 });
    const r = await session.raw("screenshot", { width: 320 });
    assert(r.isError === true, "screenshot succeeded headless");
    const text = r.content[0].text;
    assert(
      /not available headless/.test(text) && text.includes("screen_rgba"),
      text,
    );
    const bad = await session.raw("screenshot", { width: 1 });
    assert(bad.isError === true, "width 1 accepted");
  },
});
