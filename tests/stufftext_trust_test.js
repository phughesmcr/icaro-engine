// svc_stufftext from a remote host is untrusted: only the allowlisted commands
// in cmd.js run, never a bind, alias, exec, connect or file write, and the
// cvars it changes are not saved. Text from the player's own local server (a
// loopback client of an active server) runs as in id's C. The engine runs
// headless (server/headless_host.js), so the commands are the real ones.

import { headless_init, headless_map } from "../server/headless_host.js";
import {
  CL_ClearStuffText,
  CL_ParseServerMessage,
  CL_ParseStuffText,
  CL_StuffTextIsLocal,
} from "../src/cl_parse.js";
import { CL_Disconnect } from "../src/cl_main.js";
import { cl, cls, CSHIFT_BONUS } from "../src/client.js";
import {
  Cbuf_AddText,
  Cbuf_Execute,
  Cmd_AddCommand,
  cmd_alias,
  Cmd_Argv,
  Cmd_ExecuteString,
  src_command,
} from "../src/cmd.js";
import { MSG_WriteByte, MSG_WriteString, SZ_Clear } from "../src/common.js";
import { net_message } from "../src/net.js";
import { svc_stufftext } from "../src/protocol.js";
import { Cvar_FindVar, Cvar_WriteVariables } from "../src/cvar.js";
import { Con_SetAgentHook } from "../src/console.js";
import { Host_WriteConfiguration } from "../src/host.js";
import { K_F11, K_F12, keybindings } from "../src/keys.js";
import { in_attack } from "../src/cl_input.js";
import { Fog_GetState } from "../src/gl_fog.js";
import { sv } from "../src/server.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// Host_Init runs once per process; the tests share this host and run in order
await headless_init();
await headless_map("e1m1");

function aliasExists(name) {
  for (let a = cmd_alias; a !== null; a = a.next) {
    if (a.name.toLowerCase() === name) return true;
  }
  return false;
}

function storageSnapshot() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    out[key] = localStorage.getItem(key);
  }
  return JSON.stringify(out, Object.keys(out).sort());
}

// Runs fn with the client on a remote connection: any socket but the
// loopback one. Nothing here runs a frame, so the fake socket is never used.
function asRemote(fn) {
  const saved = cls.netcon;
  cls.netcon = { address: "wss://host.example/room" };
  try {
    fn();
  } finally {
    cls.netcon = saved;
  }
}

// Stuffs each message in turn and runs the command buffer, collecting the
// console lines (developer 1 shows the refusals)
function stuff(...messages) {
  const lines = [];
  Cmd_ExecuteString("developer 1", src_command);
  Con_SetAgentHook((txt) => lines.push(txt));
  try {
    for (const m of messages) CL_ParseStuffText(m);
    Cbuf_Execute();
  } finally {
    Con_SetAgentHook(null);
    Cmd_ExecuteString("developer 0", src_command);
  }
  return lines.join("");
}

Deno.test("stufftext: the player's own server is local and fully trusted", () => {
  assert(CL_StuffTextIsLocal() === true, "a loopback game is local");
  CL_ClearStuffText();
  try {
    stuff('bind F12 "impulse 9"\nalias stufftest_local "echo x"\n');
    assert(keybindings[K_F12] === "impulse 9", "local bind ran");
    assert(aliasExists("stufftest_local") === true, "local alias ran");
  } finally {
    Cmd_ExecuteString("unbind F12", src_command);
    Cmd_ExecuteString("unalias stufftest_local", src_command);
  }
});

// Records the arguments of each "stufftest" command Cbuf_Execute runs
const stuffed = [];
Cmd_AddCommand("stufftest", () => stuffed.push(Cmd_Argv(1)));

Deno.test("stufftext runs a command split across messages only once whole", () => {
  stuffed.length = 0;
  CL_ClearStuffText();

  CL_ParseStuffText("stufftest ab");
  Cbuf_Execute();
  assert(stuffed.length === 0, "half a command is held back");

  CL_ParseStuffText("cd\nstufftest e");
  Cbuf_Execute();
  assert(
    stuffed.join(",") === "abcd",
    "the completed line runs, the next fragment waits: " + stuffed,
  );

  CL_ClearStuffText(); // CL_ClearState: a new server starts clean
  CL_ParseStuffText("stufftest f\n");
  Cbuf_Execute();
  assert(stuffed.join(",") === "abcd,f", "cleared fragment is dropped");
});

Deno.test("a short message flushes stufftext that never sends a newline", () => {
  stuffed.length = 0;
  CL_ClearStuffText();

  const saved = {
    data: net_message.data,
    maxsize: net_message.maxsize,
    cursize: net_message.cursize,
  };
  try {
    net_message.data = new Uint8Array(1024);
    net_message.maxsize = 1024;
    SZ_Clear(net_message);
    MSG_WriteByte(net_message, svc_stufftext);
    MSG_WriteString(net_message, "stufftest g");
    CL_ParseServerMessage();
  } finally {
    Object.assign(net_message, saved);
  }

  Cbuf_Execute();
  assert(stuffed.join(",") === "g", "flushed at the end of the message");
});

Deno.test("stufftext: demos and remote hosts are not local", () => {
  asRemote(() => assert(CL_StuffTextIsLocal() === false, "remote socket"));
  cls.demoplayback = true;
  try {
    assert(CL_StuffTextIsLocal() === false, "demo playback");
  } finally {
    cls.demoplayback = false;
  }
  const active = sv.active;
  sv.active = false;
  try {
    assert(CL_StuffTextIsLocal() === false, "loopback with no server");
  } finally {
    sv.active = active;
  }
});

Deno.test("stufftext: a remote host can't bind, alias, exec, connect or write a file", () => {
  const before = storageSnapshot();
  const netcon = cls.netcon;
  const binding = keybindings[K_F11];
  let out = "";
  asRemote(() => {
    CL_ClearStuffText();
    out = stuff(
      'bind F11 "quit"\n',
      "alias stufftest_evil quit\n",
      "exec quake.rc\n",
      'connect "wss://evil.example/x"\n',
      "save stufftest\n",
      "record stufftest\n",
      "screenshot\n",
      "stuffcmds\n",
      "unbindall\n",
      "cmd say hi\n",
    );
  });

  assert(keybindings[K_F11] === binding, "F11 was rebound");
  assert(aliasExists("stufftest_evil") === false, "alias was made");
  assert(cls.netcon === netcon, "the client connected elsewhere");
  assert(storageSnapshot() === before, "something was written to storage");
  for (
    const cmd of [
      "bind",
      "alias",
      "exec",
      "connect",
      "save",
      "record",
      "screenshot",
      "stuffcmds",
      "unbindall",
      "cmd",
    ]
  ) {
    assert(
      out.includes("Server tried to " + cmd),
      "no refusal line for " + cmd + " in:\n" + out,
    );
  }
});

Deno.test("stufftext: a remote host can't slip a command past the allowlist", () => {
  const binding = keybindings[K_F11];
  asRemote(() => {
    CL_ClearStuffText();
    stuff(
      "bf;bind F11 quit\n", // a second command on an allowed line
      "bf;bf;bind F11 quit\n",
      '"bind" F11 quit\n', // quoted name
      "BIND F11 quit\n", // case
      "/* x */bind F11 quit\n", // a comment COM_Parse skips
      " \tbind F11 quit\n",
      "bf\nbind F11 quit\n",
      "bi", // split across messages
      "nd F11 quit\n",
    );
  });
  assert(keybindings[K_F11] === binding, "F11 was rebound");

  // an allowed cvar name never reaches the player's alias of that name
  Cmd_ExecuteString('alias r_skyfog "bind F11 quit"', src_command);
  try {
    asRemote(() => {
      CL_ClearStuffText();
      stuff("r_skyfog 0.25\n");
    });
    assert(keybindings[K_F11] === binding, "the alias ran");
    assert(
      Cvar_FindVar("r_skyfog").string === "0.25",
      "the cvar was set instead",
    );
  } finally {
    Cmd_ExecuteString("unalias r_skyfog", src_command);
  }

  // text left in the buffer without its newline doesn't take the host's
  // line into an unmarked command
  Cbuf_AddText(" ");
  asRemote(() => {
    CL_ClearStuffText();
    stuff("bind F11 quit\n");
  });
  assert(keybindings[K_F11] === binding, "F11 was rebound after a blank");

  // a remote fragment is never completed by local text
  asRemote(() => {
    CL_ClearStuffText();
    CL_ParseStuffText("bind F11 qu");
  });
  stuff("it\n");
  assert(keybindings[K_F11] === binding, "a remote fragment ran as local");
});

Deno.test("stufftext: allowed commands from a remote host still run", () => {
  cl.cshifts[CSHIFT_BONUS].percent = 0;
  in_attack.state = 1;
  asRemote(() => {
    CL_ClearStuffText();
    stuff("bf\n", "-attack\n", "fog 0.5 0.1 0.2 0.3\n");
  });
  assert(cl.cshifts[CSHIFT_BONUS].percent === 50, "bf ran");
  assert((in_attack.state & 1) === 0, "-attack ran");
  assert(Fog_GetState().density === 0.5, "fog ran");
});

Deno.test("stufftext: a remote host's settings aren't saved and go on disconnect", () => {
  const color = Cvar_FindVar("_cl_color");
  const viewsize = Cvar_FindVar("viewsize");
  const skyfog = Cvar_FindVar("r_skyfog");
  Cmd_ExecuteString("color 1 2", src_command); // the player's own
  Cmd_ExecuteString("viewsize 100", src_command);
  Cmd_ExecuteString("r_skyfog 0.5", src_command);
  const storedColor = localStorage.getItem("quake_cvar__cl_color");
  assert(storedColor === color.string, "the player's colour is saved");

  asRemote(() => {
    CL_ClearStuffText();
    stuff("color 4 5\n", "sizedown\n", "r_skyfog 0.1\n");
  });
  assert(color.value === 4 * 16 + 5, "the host's colour is used");
  assert(viewsize.value === 90, "sizedown ran");
  assert(skyfog.string === "0.1", "r_skyfog ran");
  assert(
    localStorage.getItem("quake_cvar__cl_color") === storedColor,
    "the host's colour reached localStorage",
  );
  const vars = Cvar_WriteVariables();
  assert(
    vars.includes('_cl_color "' + storedColor + '"'),
    "Cvar_WriteVariables wrote the host's colour",
  );
  assert(
    vars.includes('viewsize "100"'),
    "Cvar_WriteVariables wrote the host's viewsize",
  );
  Host_WriteConfiguration();
  const config = localStorage.getItem("quake_config");
  assert(
    config.includes('_cl_color "' + storedColor + '"') &&
      config.includes('viewsize "100"'),
    "the saved config has the host's values",
  );

  // the player's own change afterwards is saved as usual
  Cmd_ExecuteString("viewsize 110", src_command);
  assert(
    Cvar_WriteVariables().includes('viewsize "110"'),
    "the player's viewsize isn't saved",
  );

  CL_Disconnect();
  assert(color.string === storedColor, "colour not restored on disconnect");
  assert(viewsize.value === 110, "the player's own viewsize was undone");
  assert(skyfog.string === "0.5", "r_skyfog not restored on disconnect");
});
