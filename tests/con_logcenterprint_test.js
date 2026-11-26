// Tests for con_logcenterprint (johnfitz/Ironwail Con_LogCenterPrint):
// centerprints echoed to the console between Quake bars.

await import("../src/gl_rsurf.js");
const cmd = await import("../src/cmd.js");
const con = await import("../src/console.js");
const scr = await import("../src/gl_screen.js");
const { GAME_DEATHMATCH, svc_centerprint, svc_finale, svc_cutscene } =
  await import("../src/protocol.js");
const { CL_ParseServerMessage } = await import("../src/cl_parse.js");
const { cl: client_cl } = await import("../src/client.js");
const net = await import("../src/net.js");
const common = await import("../src/common.js");

globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the console from it
cmd.Cbuf_Init();
cmd.Cmd_Init();
con.Con_Init();

// Console output, read back by drawing the console
const drawn = new Map();
con.Con_SetExternals({
  Draw_Character: (x, y, c) => {
    const row = drawn.get(y) ?? [];
    row[(x >> 3) - 1] = c;
    drawn.set(y, row);
  },
  getRealtime: () => realtime,
});
let realtime = 0;

function consoleText() {
  drawn.clear();
  con.Con_DrawConsole(8 * 200, false);
  const rows = [...drawn.keys()].sort((a, b) => a - b);
  return rows.map((y) =>
    String.fromCharCode(...drawn.get(y).map((c) => c ?? 32)).trimEnd()
  ).join("\n");
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const cl = {
  intermission: 0,
  paused: false,
  worldmodel: null,
  time: 0,
  gametype: 0,
};
scr.SCR_SetExternals({ cl });

// Bars and centring use min( 40, con_linewidth ); the test console is 38 wide
const W = Math.min(40, con.con_linewidth);
const BAR = "\x1d" + "\x1e".repeat(W - 2) + "\x1f";

Deno.test("con_logcenterprint 0 keeps id behaviour: nothing is logged", () => {
  scr.con_logcenterprint.value = 0;
  scr.Con_ClearLastCenterString();
  con.Con_Clear_f();
  scr.Con_LogCenterPrint("The Silver Key");
  if (consoleText().includes("The Silver Key")) {
    throw new Error("centerprint logged with con_logcenterprint 0");
  }
});

Deno.test("con_logcenterprint 1 logs centred lines between bars, once per string", () => {
  try {
    scr.con_logcenterprint.value = 1;
    cl.gametype = 0;
    scr.Con_ClearLastCenterString();
    con.Con_Clear_f();

    scr.Con_LogCenterPrint("You got the\nSilver Key");
    let text = consoleText();
    if (count(text, BAR) !== 2) {
      throw new Error(`expected 2 bars, got:\n${text}`);
    }
    if (!text.includes("\n" + " ".repeat((W - 11) >> 1) + "You got the\n")) {
      throw new Error(`first line not centred:\n${text}`);
    }
    if (!text.includes("\n" + " ".repeat((W - 10) >> 1) + "Silver Key\n")) {
      throw new Error(`second line not centred:\n${text}`);
    }

    // duplicate ignored
    scr.Con_LogCenterPrint("You got the\nSilver Key");
    text = consoleText();
    if (count(text, "Silver Key") !== 1) {
      throw new Error("duplicate centerprint logged");
    }

    // a new server clears the last string, so it logs again
    scr.Con_ClearLastCenterString();
    scr.Con_LogCenterPrint("You got the\nSilver Key");
    if (count(consoleText(), "Silver Key") !== 2) {
      throw new Error("not logged after reset");
    }
  } finally {
    scr.con_logcenterprint.value = 0;
  }
});

Deno.test("con_logcenterprint skips deathmatch unless set to 2", () => {
  try {
    cl.gametype = GAME_DEATHMATCH;
    scr.Con_ClearLastCenterString();
    con.Con_Clear_f();

    scr.con_logcenterprint.value = 1;
    scr.Con_LogCenterPrint("Fraglimit hit");
    if (consoleText().includes("Fraglimit hit")) {
      throw new Error("logged in deathmatch with 1");
    }

    scr.con_logcenterprint.value = 2;
    scr.Con_LogCenterPrint("Fraglimit hit");
    if (!consoleText().includes("Fraglimit hit")) {
      throw new Error("not logged in deathmatch with 2");
    }
  } finally {
    scr.con_logcenterprint.value = 0;
    cl.gametype = 0;
  }
});

Deno.test("Con_Quakebar caps the bar at 40 columns and the console width", () => {
  // no newline when the bar fills the console line
  const bar = scr.Con_Quakebar(60);
  if (bar !== BAR + (W < con.con_linewidth ? "\n" : "")) {
    throw new Error(`unexpected bar ${JSON.stringify(bar)}`);
  }
  const short = scr.Con_Quakebar(5);
  if (short !== "\x1d\x1e\x1e\x1e\x1f\n") {
    throw new Error(`unexpected short bar ${JSON.stringify(short)}`);
  }
});

Deno.test("an empty centerprint logs one blank line, a trailing newline adds none", () => {
  try {
    scr.con_logcenterprint.value = 1;
    cl.gametype = 0;
    scr.Con_ClearLastCenterString();
    con.Con_Clear_f();

    // QuakeC clears the centerprint with ""; Ironwail logs it as "\n".
    // Right after a reset "" matches the cleared last string, so log text first.
    scr.Con_LogCenterPrint("First");
    con.Con_Clear_f();
    scr.Con_LogCenterPrint("");
    let text = consoleText();
    if (!text.includes(BAR + "\n\n" + BAR)) {
      throw new Error(`no blank line between bars:\n${text}`);
    }

    con.Con_Clear_f();
    scr.Con_LogCenterPrint("Hello\n");
    text = consoleText();
    if (
      !text.includes(BAR + "\n" + " ".repeat((W - 5) >> 1) + "Hello\n" + BAR)
    ) {
      throw new Error(`trailing newline not handled:\n${text}`);
    }
  } finally {
    scr.con_logcenterprint.value = 0;
  }
});

Deno.test("con_logcenterprint 0 still records the last string", () => {
  try {
    cl.gametype = 0;
    scr.Con_ClearLastCenterString();
    con.Con_Clear_f();

    scr.con_logcenterprint.value = 0;
    scr.Con_LogCenterPrint("Recorded");
    scr.con_logcenterprint.value = 1;
    scr.Con_LogCenterPrint("Recorded");
    if (consoleText().includes("Recorded")) {
      throw new Error("string seen with 0 was not treated as a duplicate");
    }
  } finally {
    scr.con_logcenterprint.value = 0;
  }
});

Deno.test("logging clears the notify lines", () => {
  try {
    scr.con_logcenterprint.value = 1;
    cl.gametype = 0;
    scr.Con_ClearLastCenterString();
    realtime = 100; // Con_Print stamps notify times with it

    const notified = () => {
      drawn.clear();
      con.Con_DrawNotify();
      return drawn.size;
    };

    con.Con_Printf("notify me\n");
    if (notified() === 0) {
      throw new Error("test setup: Con_Printf drew no notify line");
    }
    scr.Con_LogCenterPrint("Cleared");
    if (notified() !== 0) throw new Error("notify lines left after logging");
  } finally {
    scr.con_logcenterprint.value = 0;
    realtime = 0;
  }
});

Deno.test("svc_centerprint, svc_finale and svc_cutscene are logged", () => {
  const saved = {
    data: net.net_message.data,
    maxsize: net.net_message.maxsize,
    cursize: net.net_message.cursize,
  };
  const savedCommon = common.net_message;
  const savedIntermission = client_cl.intermission;
  try {
    scr.con_logcenterprint.value = 1;
    cl.gametype = 0;
    scr.Con_ClearLastCenterString();
    con.Con_Clear_f();

    common.COM_SetNetMessage(net.net_message); // Host_Init does this
    net.net_message.data = new Uint8Array(1024);
    net.net_message.maxsize = 1024;
    common.SZ_Clear(net.net_message);
    common.MSG_WriteByte(net.net_message, svc_centerprint);
    common.MSG_WriteString(net.net_message, "Parsed centerprint");
    common.MSG_WriteByte(net.net_message, svc_finale);
    common.MSG_WriteString(net.net_message, "Parsed finale");
    common.MSG_WriteByte(net.net_message, svc_cutscene);
    common.MSG_WriteString(net.net_message, "Parsed cutscene");
    CL_ParseServerMessage();

    const text = consoleText();
    for (
      const s of ["Parsed centerprint", "Parsed finale", "Parsed cutscene"]
    ) {
      if (!text.includes(s)) throw new Error(`${s} not logged:\n${text}`);
    }
  } finally {
    scr.con_logcenterprint.value = 0;
    client_cl.intermission = savedIntermission;
    net.net_message.data = saved.data;
    net.net_message.maxsize = saved.maxsize;
    net.net_message.cursize = saved.cursize;
    common.COM_SetNetMessage(savedCommon);
  }
});
