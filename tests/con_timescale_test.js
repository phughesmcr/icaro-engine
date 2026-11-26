// Tests for the console slide under host_timescale (johnfitz, Ironwail
// SCR_SetUpToDrawConsole) and the declared cls.demopaused field.

await import("../src/gl_rsurf.js");
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const scr = await import("../src/gl_screen.js");
const host = await import("../src/host.js");
const { client_static_t } = await import("../src/client.js");
const cmd = await import("../src/cmd.js");
const con = await import("../src/console.js");

cmd.Cbuf_Init();
cmd.Cmd_Init();
con.Con_Init(); // Con_CheckResize needs the text buffer

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("the console slides at the same speed at any host_timescale", () => {
  const cl = { intermission: 0, paused: false, worldmodel: null, time: 0 };
  const cls = { state: 2, signon: 4, demoplayback: false };
  scr.SCR_SetExternals({ cl, cls });

  const savedScale = host.host_timescale.value;
  const savedFrametime = host.host_frametime;
  try {
    // host_frametime is real time * host_timescale (host.js _Host_FilterTime)
    for (const timescale of [0, 0.5, 2]) {
      // No world: the console is forced fully down
      cl.worldmodel = null;
      scr.SCR_SetUpToDrawConsole();
      const full = scr.scr_con_current;

      // In game with the console closed it slides up 300 * 0.1 = 30 lines
      // for 0.1 s of real time, whatever the timescale
      cl.worldmodel = {};
      host.host_timescale.value = timescale;
      host.set_host_frametime(0.1 * (timescale > 0 ? timescale : 1));
      scr.SCR_SetUpToDrawConsole();
      assertEqual(
        Math.round((full - scr.scr_con_current) * 1000) / 1000,
        30,
        "slide at host_timescale " + timescale,
      );
    }
  } finally {
    host.host_timescale.value = savedScale;
    host.set_host_frametime(savedFrametime);
  }
});

Deno.test("client_static_t declares demopaused", () => {
  const cls = new client_static_t();
  assertEqual(cls.demopaused, false, "demopaused");
});
