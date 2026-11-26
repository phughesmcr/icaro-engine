// The intro page (web-only, no C source): main.js waits on Intro_Gate before
// it loads any game data. Nothing pak-related is fetched until a person
// presses a button here, so crawlers, link previews and other bots that
// load the page never download a pak (and sw.js no longer fetches one on
// install). The page offers LibreQuake, the standard content, downloaded on
// first use (src/librequake.js), or id's own data: the shareware pak0.pak,
// and a player's own registered paks (src/userdata.js).
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
// add-ons (?game), lobby rooms, whose servers run id1's maps (?room), and
// agent links to a map such as e1m1 (?map)
const INTRO_ID1_PARAMS = ["game", "room", "map"];

const INTRO_GAME_LABELS = {
  hipnotic: "Scourge of Armagon",
  rogue: "Dissolution of Eternity",
  mg1: "Dimension of the Machine",
  mg3: "Add-on mg3",
  dopa: "Dimension of the Past",
  ctf: "Capture the Flag",
};

/**
 * The content a launch wants, from its URL and the person's last pick:
 * { base, named } where base is what main.js reads as ?base (null for id's
 * data in static/, "librequake", "rerelease", or an unknown value main.js
 * reports), and named is true when the URL chose it. ?base=id1 asks for
 * id's data by name.
 */
export function Intro_Want(params, choice) {
  const base = params.get("base");
  if (base === "id1") return { base: null, named: true };
  if (base !== null) return { base, named: true };
  if (INTRO_ID1_PARAMS.some((p) => params.has(p))) {
    return { base: null, named: true };
  }
  if (choice === "id1") return { base: null, named: false };
  return { base: "librequake", named: false };
}

/**
 * Whether the intro page must ask: { start: base } to go straight on, or
 * { ask: want } (see Intro_Want). It asks unless a person pressed Play on
 * this device before (played) and the content is there without a download.
 */
export function Intro_Decide({ params, played, choice, installed }) {
  const want = Intro_Want(params, choice);
  const download = want.base === "librequake" && installed === false;
  if (played && download === false) return { start: want.base };
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
  if (base === "librequake") return "LibreQuake";
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
  const decision = Intro_Decide({
    params,
    played: env.get(INTRO_PLAYED_KEY) === "1",
    choice: env.get(UD_CHOICE_KEY),
    installed,
  });
  if ("start" in decision) return decision.start;

  let registered = false;
  if (store !== null) {
    try {
      const key = UD_PakKey("id1");
      registered = (await store.list()).some((i) => i.key === key);
    } catch {
      // can't list: offer the shareware label
    }
  }
  return await Intro_Show(
    env,
    params,
    decision.ask,
    store,
    installed,
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
function Intro_Show(env, params, want, store, installed, registered) {
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
    if (want.named === false) {
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
        "under the BSD 3-clause licence and its QuakeC under the GPL-2; the " +
        "shareware episode is id Software's. Your own Quake files can be " +
        "added from the menu (Options, Game data).",
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
            ". You can play the Quake shareware episode instead.";
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
    if (want.base === "librequake") {
      button(
        registered ?
          "Play Quake (registered)" :
          "Play the Quake shareware episode",
        false,
        () => finish(null),
      );
    }

    buttons[0].focus?.();
  });
}
