// src/intro.js reads ?game= through url_config.js (URLCfg_Game), as main.js
// does: a name url_config.js ignores asks the intro page for nothing, so the
// page neither says the link needs id's data nor names a pack.

import {
  Intro_Decide,
  Intro_Describe,
  Intro_Gate,
  INTRO_PLAYED_KEY,
  Intro_Want,
} from "../src/intro.js";
import { URLCfg_Game, URLCfg_Parse } from "../src/url_config.js";
import { UD_LQ_MANIFEST } from "../src/userdata.js";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const params = (q) => new URLSearchParams(q);

// ?game= values url_config.js refuses: paths, reserved and base names,
// empty, too long, bad characters
const REFUSED = [
  "?game=../x",
  "?game=..%2Fx",
  "?game=a/b",
  "?game=",
  "?game=id1",
  "?game=ID1",
  "?game=librequake",
  "?game=rerelease",
  "?game=-x",
  "?game=" + "a".repeat(33),
  "?game=%3Cscript%3E",
];

Deno.test("URLCfg_Game matches URLCfg_Parse's game", () => {
  for (
    const q of [
      ...REFUSED,
      "",
      "?game=hipnotic",
      "?game=Rogue",
      "?game=quoth",
      "?game=mg1",
      "?game=nosuchdir",
    ]
  ) {
    const p = params(q);
    const got = JSON.stringify(URLCfg_Game(p.get("game")));
    const want = JSON.stringify(URLCfg_Parse(p).game);
    assert(got === want, q + ": " + got + " vs " + want);
  }
  assert(URLCfg_Game(null) === null, "absent");
  assert(URLCfg_Game("Rogue").dir === "rogue", "mission packs in any case");
});

Deno.test("Intro_Want: a refused ?game= asks for nothing", () => {
  for (const q of REFUSED) {
    for (const id1 of [false, true]) {
      const want = Intro_Want(params(q), null, id1);
      assert(
        want.base === "librequake" && want.named === false &&
          want.missing !== true,
        q + " id1=" + id1 + ": " + JSON.stringify(want),
      );
    }
    // the last pick still counts, as with no ?game= at all
    const picked = Intro_Want(params(q), "id1", true);
    assert(picked.base === null && picked.named === false, q + " picked id1");
  }
});

Deno.test("Intro_Want: an accepted ?game= still asks for id's data", () => {
  for (const q of ["?game=hipnotic", "?game=ROGUE", "?game=nosuchdir"]) {
    const missing = Intro_Want(params(q), null, false);
    assert(
      missing.base === "librequake" && missing.named === true &&
        missing.missing === true,
      q + " without id1: " + JSON.stringify(missing),
    );
    const present = Intro_Want(params(q), null, true);
    assert(
      present.base === null && present.missing === false,
      q + " with id1: " + JSON.stringify(present),
    );
  }
});

Deno.test("Intro_Decide: a returning player isn't stopped by a refused ?game=", () => {
  for (const q of REFUSED) {
    const d = Intro_Decide({
      params: params(q),
      played: true,
      choice: null,
      installed: true,
      id1: false,
    });
    assert(d.start === "librequake", q + ": " + JSON.stringify(d));
  }
  const pack = Intro_Decide({
    params: params("?game=hipnotic"),
    played: true,
    choice: null,
    installed: true,
    id1: false,
  });
  assert("ask" in pack && pack.ask.missing === true, "a pack still asks");
});

Deno.test("Intro_Describe names packs as url_config.js reads them", () => {
  assert(
    Intro_Describe(params("?game=HIPNOTIC")) === "Scourge of Armagon",
    "mission pack in any case",
  );
  assert(
    Intro_Describe(params("?base=rerelease&game=../mg1")) ===
      "Quake (2021 rerelease)",
    "refused name not labelled",
  );
  assert(Intro_Describe(params("?game=../x")) === "Quake", "refused");
});

Deno.test("Intro_Gate: a refused ?game= goes straight in for a returning player, with nothing fetched", async () => {
  const store = {
    list: () => Promise.resolve([{ key: UD_LQ_MANIFEST, size: 1 }]),
    get: (key) =>
      Promise.resolve(
        key === UD_LQ_MANIFEST ?
          new Blob([
            JSON.stringify({
              version: "v0.09-beta",
              variant: "full",
              files: 1,
            }),
          ]) :
          null,
      ),
  };
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (input) => {
    calls.push(String(input?.url ?? input));
    return Promise.reject(new Error("no network in this test"));
  };
  try {
    const env = {
      // no page may be built: any DOM use throws
      document: null,
      get: (k) => k === INTRO_PLAYED_KEY ? "1" : null,
      set: () => {},
      remember: () => {},
      openStore: () => Promise.resolve(store),
      install: () => Promise.reject(new Error("no install")),
      persist: () => {},
    };
    assert(
      await Intro_Gate(params("?game=../x"), env) === "librequake",
      "LibreQuake",
    );
  } finally {
    globalThis.fetch = saved;
  }
  assert(calls.length === 0, "nothing fetched: " + calls.join(" "));
});
