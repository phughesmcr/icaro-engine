// The intro page (web-only, no C source): main.js waits on Intro_Gate before
// it loads any game data. Nothing pak-related is fetched until a person
// presses a button here, so crawlers, link previews and other bots that
// load the page never download a pak (and sw.js no longer fetches one on
// install). The page offers LibreQuake, the standard content, downloaded on
// first use (src/librequake.js), and id's own data when a player has added
// id1's pak0.pak in Options, Game data (src/userdata.js). The site serves no
// id pak, so id's data is never started without it. The one exception is a
// local development host (Intro_IsDevHost), where the page asks with HEAD
// whether static/ serves id1's paks, so a developer's own copies start
// without being added: on any other host nothing is asked.
//
// A person who has pressed Play on this device before skips the page when
// what they start needs no download: that state (localStorage) is only ever
// written by a click here or in the Game data panel, so a bot loading the
// page fresh still stops here. docs/librequake-content.md has the details.

import {
  LQ_Error,
  LQ_Install,
  LQ_Installed,
  LQ_RELEASES,
} from "./librequake.js";
import {
  UD_CHOICE_KEY,
  UD_OpenStore,
  UD_PakKey,
  UD_RememberChoice,
} from "./userdata.js";

/** localStorage key set once a person has pressed Play on this device. */
export const INTRO_PLAYED_KEY = "icaro_played";

// URL parameters that name content needing id's data: mission packs and
// add-ons (?game). Lobby rooms (?room) and links to a map (?map, as agents
// use) start LibreQuake, which the rooms run.
const INTRO_ID1_PARAMS = ["game"];

// The hosts Intro_LocalPaks asks: this machine, as location.hostname writes
// it. Not *.localhost or LAN addresses.
/** How long a local pak's HEAD may take before it counts as absent. */
const INTRO_LOCAL_TIMEOUT_MS = 2000;

const INTRO_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Whether hostname (location.hostname) is a local development host. */
export function Intro_IsDevHost(hostname) {
  return INTRO_DEV_HOSTS.has(hostname);
}

/**
 * On a local development host only, whether static/ serves id1's paks where
 * main.js fetches them when none is stored (static/pak0.pak, then pak1.pak):
 * { pak0, pak1 }. Each is one HEAD request, so nothing is downloaded. A 2xx
 * that is HTML (a server's fallback page) doesn't count. Any other host gets
 * { pak0: false, pak1: false } without a request.
 */
export async function Intro_LocalPaks(hostname, doFetch = globalThis.fetch) {
  if (Intro_IsDevHost(hostname) === false || typeof doFetch !== "function") {
    return { pak0: false, pak1: false };
  }
  const served = async (path) => {
    try {
      const response = await doFetch(path, {
        method: "HEAD",
        cache: "no-store",
        // a hung local server mustn't hold the intro page
        signal: typeof AbortSignal.timeout === "function" ?
          AbortSignal.timeout(INTRO_LOCAL_TIMEOUT_MS) :
          undefined,
      });
      const type = response.headers.get("content-type") ?? "";
      return response.ok && type.startsWith("text/html") === false;
    } catch {
      return false;
    }
  };
  const pak0 = await served(UD_PakKey("id1/pak0"));
  const pak1 = pak0 && await served(UD_PakKey("id1"));
  return { pak0, pak1 };
}

const INTRO_GAME_LABELS = {
  hipnotic: "Scourge of Armagon",
  rogue: "Dissolution of Eternity",
  mg1: "Dimension of the Machine",
  mg3: "Add-on mg3",
  dopa: "Dimension of the Past",
  ctf: "Capture the Flag",
};

/**
 * The content a launch wants, from its URL, the person's last pick and
 * whether id1's pak0.pak is stored here (id1): { base, named, missing }
 * where base is what main.js reads as ?base (null for id's data in static/,
 * "librequake", "rerelease", or an unknown value main.js reports), named is
 * true when the URL chose it, and missing is true when the URL asked for id's
 * data but none is stored: base is then "librequake", since id's data would
 * 404. ?base=id1 asks for id's data by name. A remembered pick of id's data
 * with none stored falls back to LibreQuake as if the person had picked
 * nothing.
 */
export function Intro_Want(params, choice, id1 = false) {
  const base = params.get("base");
  if (base !== null && base !== "id1") return { base, named: true };
  if (base === "id1" || INTRO_ID1_PARAMS.some((p) => params.has(p))) {
    if (id1) return { base: null, named: true, missing: false };
    return { base: "librequake", named: true, missing: true };
  }
  if (params.has("room") || params.has("map")) {
    return { base: "librequake", named: true, missing: false };
  }
  if (choice === "id1" && id1) return { base: null, named: false };
  return { base: "librequake", named: false };
}

/**
 * Whether the intro page must ask: { start: base } to go straight on, or
 * { ask: want } (see Intro_Want). It asks unless a person pressed Play on
 * this device before (played) and the content is there without a download,
 * and a URL that asked for id's data it can't have always shows its page.
 */
export function Intro_Decide({ params, played, choice, installed, id1 }) {
  const want = Intro_Want(params, choice, id1 === true);
  const download = want.base === "librequake" && installed === false;
  if (played && download === false && want.missing !== true) {
    return { start: want.base };
  }
  return { ask: want };
}

/** What a URL that names its content starts, in words. */
export function Intro_Describe(params) {
  const game = params.get("game");
  const base = params.get("base");
  if (params.has("room")) return "a multiplayer game";
  if (base === "rerelease") {
    return "Quake (2021 rerelease)" +
      (Object.hasOwn(INTRO_GAME_LABELS, game) ?
        ": " + INTRO_GAME_LABELS[game] :
        "");
  }
  if (Object.hasOwn(INTRO_GAME_LABELS, game)) return INTRO_GAME_LABELS[game];
  if (base === "librequake" || params.has("map")) return "LibreQuake";
  return "Quake";
}

const INTRO_STYLE = `
#intro { position: fixed; inset: 0; z-index: 200; overflow: auto;
  background: #000; color: #ddd; font: 16px/1.45 system-ui, sans-serif;
  display: flex; align-items: center; justify-content: center;
  padding: max(16px, env(safe-area-inset-top))
  max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left));
  -webkit-user-select: text; user-select: text; }
#intro .intro-box { max-width: 34em; }
#intro h1 { font-size: 28px; margin: 0 0 8px; color: #fc8; }
#intro p { margin: 8px 0; }
#intro .intro-small { font-size: 13px; color: #999; }
#intro a { color: #fc8; }
#intro button { font: inherit; min-height: 44px; padding: 8px 16px;
  margin: 4px 8px 4px 0; color: #fff; background: #533;
  border: 1px solid #a76; border-radius: 6px; cursor: pointer; }
#intro button.intro-main { background: #842; border-color: #fc8; }
#intro button:disabled { opacity: 0.5; cursor: default; }
#intro .intro-bar { height: 4px; background: #333; margin: 12px 0 4px; }
#intro .intro-bar div { height: 100%; width: 0%; background: #fc8; }
#intro .intro-status { min-height: 1.45em; white-space: pre-wrap; }
`;

function Intro_MB(bytes) {
  return (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) + " MB";
}

/** The browser's localStorage, store and installer, as Intro_Gate uses them. */
function Intro_BrowserEnv() {
  return {
    document: globalThis.document,
    get: (key) => {
      try {
        return globalThis.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        globalThis.localStorage.setItem(key, value);
      } catch {
        // no localStorage: the page asks again next time
      }
    },
    remember: UD_RememberChoice,
    openStore: UD_OpenStore,
    localPaks: () => Intro_LocalPaks(globalThis.location?.hostname ?? ""),
    install: LQ_Install,
    persist: () => globalThis.navigator?.storage?.persist?.().catch(() => {}),
  };
}

/**
 * Called by main.js before any game data loads: resolves to the ?base value
 * main.js should use (see Intro_Want) once a person has picked what to play,
 * or at once when Intro_Decide says the page can be skipped. env stands in
 * for the browser in tests.
 */
export async function Intro_Gate(params, env = Intro_BrowserEnv()) {
  let store = null;
  try {
    store = await env.openStore();
  } catch {
    // no storage: LibreQuake can't be kept, id's data still plays
  }
  const installed = (await LQ_Installed(store)) !== null;
  // id1's pak0.pak is what a player adds in Options, Game data; pak1.pak
  // makes it registered Quake
  let id1 = false;
  let registered = false;
  if (store !== null) {
    try {
      const keys = new Set((await store.list()).map((i) => i.key));
      id1 = keys.has(UD_PakKey("id1/pak0"));
      registered = id1 && keys.has(UD_PakKey("id1"));
    } catch {
      // can't list: no id data is offered
    }
  }
  // a developer's own paks in static/, on a local development host only
  // (only when the URL names no base or id1's: another base never needs it)
  const base = params.get("base");
  if (
    id1 === false && typeof env.localPaks === "function" &&
    (base === null || base === "id1")
  ) {
    const local = await env.localPaks();
    id1 = local.pak0 === true;
    registered = id1 && local.pak1 === true;
  }
  const decision = Intro_Decide({
    params,
    played: env.get(INTRO_PLAYED_KEY) === "1",
    choice: env.get(UD_CHOICE_KEY),
    installed,
    id1,
  });
  if ("start" in decision) return decision.start;

  return await Intro_Show(
    env,
    params,
    decision.ask,
    store,
    installed,
    id1,
    registered,
  );
}

function Intro_El(doc, tag, text, parent) {
  const el = doc.createElement(tag);
  if (text !== null) el.textContent = text;
  if (parent !== null) parent.appendChild(el);
  return el;
}

// The page itself; resolves with the base to start once a person picks
function Intro_Show(env, params, want, store, installed, id1, registered) {
  const doc = env.document;
  return new Promise((resolve) => {
    if (doc.getElementById("intro-style") === null) {
      const style = Intro_El(doc, "style", INTRO_STYLE, doc.head);
      style.id = "intro-style";
    }
    const page = Intro_El(doc, "div", null, doc.body);
    page.id = "intro";
    page.setAttribute("role", "dialog");
    page.setAttribute("aria-label", "Icaro Engine");
    const box = Intro_El(doc, "div", null, page);
    box.className = "intro-box";

    Intro_El(doc, "h1", "Icaro Engine", box);
    Intro_El(
      doc,
      "p",
      "Quake's engine in your browser, ported function by function from " +
        "id Software's C source.",
      box,
    );
    const about = Intro_El(doc, "p", null, box);
    if (want.missing === true) {
      about.textContent = "This link starts Quake from id Software's own " +
        "files, which aren't in this browser. They can be added from the " +
        "menu (Options, Game data). LibreQuake, a free and open " +
        "replacement made by its own community, plays now. ";
      const link = Intro_El(doc, "a", "About LibreQuake", about);
      link.href = "https://github.com/lavenderdotpet/LibreQuake";
      link.rel = "noopener";
      link.target = "_blank";
    } else if (want.named === false) {
      about.textContent = "LibreQuake is a free and open replacement for " +
        "Quake's game data, made by its own community. It downloads once " +
        "and stays in this browser. ";
      const link = Intro_El(doc, "a", "About LibreQuake", about);
      link.href = "https://github.com/lavenderdotpet/LibreQuake";
      link.rel = "noopener";
      link.target = "_blank";
    } else {
      about.textContent = "This link starts " + Intro_Describe(params) + ".";
    }

    const actions = Intro_El(doc, "div", null, box);
    const bar = Intro_El(doc, "div", null, box);
    bar.className = "intro-bar";
    bar.hidden = true;
    const fill = Intro_El(doc, "div", null, bar);
    const status = Intro_El(doc, "p", null, box);
    status.className = "intro-status";
    status.setAttribute("aria-live", "polite");
    let controller = null;
    const cancel = Intro_El(doc, "button", "Pause download", box);
    cancel.type = "button";
    cancel.hidden = true;
    cancel.addEventListener("click", () => controller?.abort());
    Intro_El(
      doc,
      "p",
      "Nothing is downloaded until you press a button. LibreQuake's art is " +
        "under the BSD 3-clause licence and its QuakeC under the GPL-2. Your own " +
        "Quake files, which stay on this device, can be added from the menu " +
        "(Options, Game data).",
      box,
    ).className = "intro-small";

    const buttons = [];
    const finish = (base) => {
      env.set(INTRO_PLAYED_KEY, "1");
      if (want.named === false) env.remember(base === null ? "id1" : base);
      page.remove();
      resolve(base);
    };

    const button = (label, main, onClick) => {
      const b = Intro_El(doc, "button", label, actions);
      b.type = "button";
      if (main) b.className = "intro-main";
      b.addEventListener("click", onClick);
      buttons.push(b);
      return b;
    };

    const download = async (release) => {
      for (const b of buttons) b.disabled = true;
      env.persist();
      controller = new AbortController();
      cancel.hidden = false;
      bar.hidden = false;
      status.textContent = "Starting the download…";
      let last = 0;
      try {
        await env.install(release, {
          store: store ?? undefined,
          signal: controller.signal,
          onProgress: (phase, done, total) => {
            fill.style.width = (total > 0 ? done / total * 100 : 0) + "%";
            // the text at most every 100 ms; the bar every time
            const now = Date.now();
            if (phase === "download" && now - last < 100 && done < total) {
              return;
            }
            last = now;
            if (phase === "download") {
              status.textContent = "Downloading LibreQuake: " +
                Intro_MB(done) + " of " + Intro_MB(total);
            } else if (phase === "verify") {
              cancel.hidden = true;
              status.textContent = "Checking the download…";
            } else {
              status.textContent = "Unpacking: " +
                Math.floor(done / total * 100) + "%";
            }
          },
        });
        finish("librequake");
      } catch (e) {
        cancel.hidden = true;
        for (const b of buttons) b.disabled = false;
        if (e?.name === "AbortError") {
          status.textContent = "Paused. Press the download button again to " +
            "carry on where it stopped.";
        } else if (e instanceof LQ_Error) {
          status.textContent = "Couldn't get LibreQuake: " + e.message +
            ". Press the download button again to retry.";
        } else {
          status.textContent = "Couldn't get LibreQuake: " +
            (e?.message ?? String(e)) +
            ". Press the download button again to retry.";
        }
      }
    };

    if (want.base !== "librequake") {
      button("Play", true, () => finish(want.base));
    } else if (installed) {
      button("Play LibreQuake", true, () => finish("librequake"));
    } else {
      const full = LQ_RELEASES.full;
      const lite = LQ_RELEASES.lite;
      button(
        "Download LibreQuake (" + Intro_MB(full.size) + ") and play",
        true,
        () => download(full),
      );
      button(
        "First episode only (" + Intro_MB(lite.size) + ")",
        false,
        () => download(lite),
      );
    }
    if (want.base === "librequake" && id1) {
      button(
        registered ? "Play Quake (registered)" : "Play Quake",
        false,
        () => finish(null),
      );
    }

    buttons[0].focus?.();
  });
}
