// Autosave on hide (src/autosave.js, host_cmd.js Host_AutoSave and
// Host_MaybeOfferContinue): when to save, when to offer Continue, and the
// save slot round trip on the headless host.

import {
  headless_frame,
  headless_init,
  headless_map,
  headless_wait_signon,
} from "../server/headless_host.js";
import { ca_connected, cl, cls } from "../src/client.js";
import { sv, svs } from "../src/server.js";
import { Cbuf_AddText } from "../src/cmd.js";
import { Cvar_FindVar, Cvar_SetValue } from "../src/cvar.js";
import {
  Host_AutoSave,
  Host_AutosaveVisible,
  Host_MaybeOfferContinue,
} from "../src/host_cmd.js";
import { Key_Event, Key_ModalActive } from "../src/keys.js";
import {
  Autosave_EncodeMeta,
  AUTOSAVE_MAX_AGE_MS,
  AUTOSAVE_META_KEY,
  Autosave_OfferDecision,
  Autosave_ParseMeta,
  Autosave_UrlBlocksOffer,
} from "../src/autosave.js";
import { GD_MAPS } from "../server/game_data.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// --- pure rules ---

Deno.test("autosave: the offer is skipped for ?room=, ?map= and ?agent=", () => {
  assert(Autosave_UrlBlocksOffer("") === false, "empty");
  assert(
    Autosave_UrlBlocksOffer("?game=rogue&skill=2") === false,
    "other params",
  );
  assert(Autosave_UrlBlocksOffer("?room=abc") === true, "room");
  assert(Autosave_UrlBlocksOffer("?map=e1m1&skill=1") === true, "map");
  assert(Autosave_UrlBlocksOffer("?agent=lockstep") === true, "agent");
});

Deno.test("autosave: meta records expire, and bad ones are ignored", () => {
  const now = 1_000_000_000_000;
  assert(
    Autosave_ParseMeta(Autosave_EncodeMeta(now - 1000, "e1m1"), now).map ===
      "e1m1",
    "fresh",
  );
  assert(
    Autosave_ParseMeta(
      Autosave_EncodeMeta(now - AUTOSAVE_MAX_AGE_MS - 1, "e1m1"),
      now,
    ) === null,
    "stale",
  );
  assert(
    Autosave_ParseMeta(Autosave_EncodeMeta(now + 5000, "e1m1"), now) === null,
    "from the future",
  );
  assert(Autosave_ParseMeta(null, now) === null, "missing");
  assert(Autosave_ParseMeta("not json", now) === null, "malformed");
  assert(Autosave_ParseMeta('{"t":"x","map":1}', now) === null, "wrong types");
});

Deno.test("autosave: offer decision", () => {
  const now = 1_000_000_000_000;
  const base = {
    search: "",
    now,
    metaText: Autosave_EncodeMeta(now - 1000, "e1m1"),
    saveExists: true,
    connected: false,
    dedicated: false,
    modalActive: false,
    ready: true,
  };
  const decide = (over) => Autosave_OfferDecision({ ...base, ...over });

  assert(decide({}) === "offer", "offer");
  assert(decide({ ready: false }) === "wait", "not ready");
  assert(decide({ modalActive: true }) === "wait", "modal up");
  assert(decide({ search: "?room=x" }) === "skip", "room");
  assert(decide({ search: "?map=e1m1" }) === "skip", "map");
  assert(decide({ search: "?agent=realtime" }) === "skip", "agent");
  assert(decide({ connected: true }) === "skip", "game already started");
  assert(decide({ dedicated: true }) === "skip", "dedicated");
  assert(decide({ metaText: null }) === "skip", "consumed");
  assert(
    decide({
      metaText: Autosave_EncodeMeta(now - AUTOSAVE_MAX_AGE_MS - 1, "e1m1"),
    }) === "skip",
    "stale",
  );
  assert(decide({ saveExists: false }) === "skip", "save gone");
});

// --- the save slot on the headless host (shares one host, runs in order) ---

await headless_init();

const SLOT_KEY = "quake_save_autosave";

Deno.test("autosave: hiding a running game writes the reserved slot only", async () => {
  await headless_map(GD_MAPS.level);
  for (let i = 0; i < 30; i++) headless_frame();

  localStorage.setItem("quake_save_s0", "player save");
  localStorage.removeItem(SLOT_KEY);
  localStorage.removeItem(AUTOSAVE_META_KEY);

  assert(Host_AutoSave() === true, "saved");
  assert(
    localStorage.getItem("quake_save_s0") === "player save",
    "s0 was overwritten",
  );
  const text = localStorage.getItem(SLOT_KEY);
  assert(text !== null && text.split("\n").length > 100, "no save in the slot");
  assert(
    text.split("\n")[0] === "5",
    "save version line: " + text.split("\n")[0],
  );
  assert(
    text.split("\n")[19] === GD_MAPS.level,
    "map line: " + text.split("\n")[19],
  );
  assert(
    Autosave_ParseMeta(localStorage.getItem(AUTOSAVE_META_KEY), Date.now())
      .map === GD_MAPS.level,
    "meta",
  );

  // pagehide after visibilitychange: same moment, no second write
  assert(Host_AutoSave() === false, "saved the same moment twice");

  // the player came back: the live game is the one to keep
  Host_AutosaveVisible();
  assert(
    localStorage.getItem(AUTOSAVE_META_KEY) === null,
    "meta not consumed on visible",
  );
});

Deno.test("autosave: coming back to the page keeps an autosave an earlier page wrote", () => {
  Host_AutosaveVisible(); // forget any write by an earlier test
  localStorage.setItem(
    AUTOSAVE_META_KEY,
    Autosave_EncodeMeta(Date.now(), GD_MAPS.level),
  );
  try {
    Host_AutosaveVisible();
    assert(
      localStorage.getItem(AUTOSAVE_META_KEY) !== null,
      "an earlier page's autosave was consumed",
    );
  } finally {
    localStorage.removeItem(AUTOSAVE_META_KEY);
  }
});

Deno.test("autosave: a full localStorage writes nothing and leaves no meta", async () => {
  await headless_map(GD_MAPS.level);
  for (let i = 0; i < 30; i++) headless_frame();
  Host_AutosaveVisible(); // a fresh moment for the duplicate guard
  localStorage.removeItem(SLOT_KEY);
  localStorage.removeItem(AUTOSAVE_META_KEY);

  // headless_init's localStorage is a plain in-memory object, so its
  // setItem can be swapped (on a real Storage this would store a key)
  const setItem = localStorage.setItem;
  localStorage.setItem = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  let saved;
  try {
    saved = Host_AutoSave();
  } finally {
    localStorage.setItem = setItem;
  }
  assert(saved === false, "reported a save that failed");
  assert(localStorage.getItem(SLOT_KEY) === null, "slot written");
  assert(
    localStorage.getItem(AUTOSAVE_META_KEY) === null,
    "meta written with no save behind it",
  );
});

Deno.test("autosave: refusals match save, without printing", () => {
  const check = (what, setup) => {
    localStorage.removeItem(SLOT_KEY);
    localStorage.removeItem(AUTOSAVE_META_KEY);
    Host_AutosaveVisible();
    const restore = setup();
    try {
      assert(Host_AutoSave() === false, what + ": saved");
      assert(
        localStorage.getItem(SLOT_KEY) === null,
        what + ": wrote the slot",
      );
    } finally {
      restore();
    }
  };

  check("intermission", () => {
    const old = cl.intermission;
    cl.intermission = 1;
    return () => {
      cl.intermission = old;
    };
  });
  check("multiplayer", () => {
    const old = svs.maxclients;
    svs.maxclients = 2;
    return () => {
      svs.maxclients = old;
    };
  });
  check("nomonsters", () => {
    const old = sv.nomonsters;
    sv.nomonsters = true;
    return () => {
      sv.nomonsters = old;
    };
  });
  check("demo playback", () => {
    const old = cls.demoplayback;
    cls.demoplayback = true;
    return () => {
      cls.demoplayback = old;
    };
  });
  check("dead player", () => {
    const v = svs.clients[0].edict.v;
    const old = v.health;
    v.health = 0;
    return () => {
      v.health = old;
    };
  });
  check("not spawned", () => {
    const old = svs.clients[0].spawned;
    svs.clients[0].spawned = false;
    return () => {
      svs.clients[0].spawned = old;
    };
  });
  check("no local game", () => {
    const old = sv.active;
    sv.active = false;
    return () => {
      sv.active = old;
    };
  });
  check("web_autosave 0", () => {
    const old = Cvar_FindVar("web_autosave").value;
    Cvar_SetValue("web_autosave", 0);
    return () => {
      Cvar_SetValue("web_autosave", old);
    };
  });
});

Deno.test("autosave: the offer loads the autosave on yes and consumes it", async () => {
  await headless_map(GD_MAPS.level);
  for (let i = 0; i < 30; i++) headless_frame();
  assert(Host_AutoSave() === true, "saved");

  // a fresh page load: no game running
  cbufRun("disconnect");
  assert(sv.active === false, "server still active");

  // the browser plays the title demo behind the main menu: not a game, so
  // the offer still comes
  const state = cls.state;
  cls.state = ca_connected;
  cls.demoplayback = true;
  let offered = false;
  try {
    for (let i = 0; i < 10 && offered === false; i++) {
      offered = Host_MaybeOfferContinue();
    }
  } finally {
    cls.state = state;
    cls.demoplayback = false;
  }

  assert(
    offered === true && Key_ModalActive() === true,
    "no prompt over the title demo",
  );

  Key_Event("y".charCodeAt(0), true);
  Key_Event("y".charCodeAt(0), false);
  assert(Key_ModalActive() === false, "prompt still up");
  assert(localStorage.getItem(AUTOSAVE_META_KEY) === null, "not consumed");

  await headless_wait_signon();
  assert(
    sv.active === true && sv.name === GD_MAPS.level,
    "autosave not loaded: " + sv.name,
  );
});

Deno.test("autosave: no on declines and map consumes", () => {
  localStorage.setItem(
    AUTOSAVE_META_KEY,
    Autosave_EncodeMeta(Date.now(), GD_MAPS.level),
  );
  cbufRun("disconnect");
  let offered = false;
  for (let i = 0; i < 10 && offered === false; i++) {
    offered = Host_MaybeOfferContinue();
  }
  assert(Key_ModalActive() === true, "no prompt");
  Key_Event("n".charCodeAt(0), true);
  Key_Event("n".charCodeAt(0), false);
  assert(sv.active === false, "a decline started a game");
  assert(
    localStorage.getItem(AUTOSAVE_META_KEY) === null,
    "decline did not consume",
  );

  localStorage.setItem(
    AUTOSAVE_META_KEY,
    Autosave_EncodeMeta(Date.now(), GD_MAPS.level),
  );
  cbufRun("map " + GD_MAPS.level);
  assert(
    localStorage.getItem(AUTOSAVE_META_KEY) === null,
    "map did not consume",
  );
});

function cbufRun(text) {
  Cbuf_AddText(text + "\n");
  headless_frame();
}
