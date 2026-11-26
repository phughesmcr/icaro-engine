// VID_GetPixelRatio: the touch-device DPR cap and the web-only ?dpr= override.

await import("../src/gl_rsurf.js"); // load the renderer graph first (import cycle)
const {
  VID_ParsePixelRatio,
  VID_ComputePixelRatio,
  VID_GetPixelRatio,
  VID_ResetPixelRatio,
} = await import("../src/vid.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("VID_ParsePixelRatio reads ?dpr=", () => {
  assertEqual(VID_ParsePixelRatio(""), null, "none");
  assertEqual(VID_ParsePixelRatio("?scale=0.5"), null, "other param");
  assertEqual(VID_ParsePixelRatio("?dpr=1.5"), 1.5, "number");
  assertEqual(VID_ParsePixelRatio("?dpr=native"), "native", "native");
  assertEqual(VID_ParsePixelRatio("?dpr=NATIVE"), "native", "native case");
  assertEqual(VID_ParsePixelRatio("?dpr=9"), 4, "clamped high");
  assertEqual(VID_ParsePixelRatio("?dpr=0.1"), 0.5, "clamped low");
  assertEqual(VID_ParsePixelRatio("?dpr=abc"), null, "invalid");
  assertEqual(VID_ParsePixelRatio("?dpr="), null, "empty");
  assertEqual(VID_ParsePixelRatio("?dpr=0"), null, "zero");
  assertEqual(VID_ParsePixelRatio("?dpr=-2"), null, "negative");
});

Deno.test("VID_ComputePixelRatio caps touch devices only", () => {
  assertEqual(VID_ComputePixelRatio(3, null, true), 2, "phone capped");
  assertEqual(VID_ComputePixelRatio(1.5, null, true), 1.5, "under the cap");
  assertEqual(VID_ComputePixelRatio(3, null, false), 3, "desktop uncapped");
  assertEqual(
    VID_ComputePixelRatio(3, "native", true),
    3,
    "native lifts the cap",
  );
  assertEqual(VID_ComputePixelRatio(3, 1, true), 1, "explicit number");
  assertEqual(
    VID_ComputePixelRatio(1, 3, false),
    3,
    "explicit number above device",
  );
  assertEqual(VID_ComputePixelRatio(undefined, null, true), 1, "missing dpr");
});

function withWindow(win, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    value: win,
    configurable: true,
    writable: true,
  });
  VID_ResetPixelRatio();
  try {
    fn();
  } finally {
    if (had !== undefined) Object.defineProperty(globalThis, "window", had);
    else delete globalThis.window;
    VID_ResetPixelRatio();
  }
}

function media(coarse, fine, hover = false) {
  const matches = {
    "(pointer: coarse)": coarse,
    "(any-pointer: fine)": fine,
    "(any-hover: hover)": hover,
  };
  return (q) => ({ matches: matches[q] === true });
}

Deno.test("VID_GetPixelRatio detects touch-primary devices", () => {
  withWindow({
    devicePixelRatio: 3,
    location: { search: "" },
    matchMedia: media(true, false),
  }, () => {
    assertEqual(VID_GetPixelRatio(), 2, "phone");
  });
  withWindow({
    devicePixelRatio: 3,
    location: { search: "" },
    matchMedia: media(false, true),
  }, () => {
    assertEqual(VID_GetPixelRatio(), 3, "desktop");
  });
  withWindow({
    devicePixelRatio: 3,
    location: { search: "" },
    matchMedia: media(true, true, true),
  }, () => {
    assertEqual(VID_GetPixelRatio(), 3, "touch laptop with a mouse");
  });
  // hover alone, with no fine pointer, is still a phone
  withWindow({
    devicePixelRatio: 3,
    location: { search: "" },
    matchMedia: media(true, false, true),
  }, () => {
    assertEqual(VID_GetPixelRatio(), 2, "coarse and hover only");
  });
  // measured on a Galaxy S25 Ultra: the stylus is fine but can't hover
  withWindow({
    devicePixelRatio: 3.5,
    location: { search: "" },
    matchMedia: media(true, true, false),
  }, () => {
    assertEqual(VID_GetPixelRatio(), 2, "phone with a stylus");
  });
  withWindow({ devicePixelRatio: 3 }, () => {
    assertEqual(VID_GetPixelRatio(), 3, "no matchMedia or location");
  });
  withWindow({
    devicePixelRatio: 3,
    location: { search: "?dpr=native" },
    matchMedia: media(true, false),
  }, () => {
    assertEqual(VID_GetPixelRatio(), 3, "?dpr=native");
  });
  withWindow({
    devicePixelRatio: 3,
    location: { search: "?dpr=1" },
    matchMedia: media(true, false),
  }, () => {
    assertEqual(VID_GetPixelRatio(), 1, "?dpr=1");
  });
});
