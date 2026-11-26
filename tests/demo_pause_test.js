// Demo pause (QuakeSpasm Host_Pause_f / CL_GetDemoMessage, ericw): "pause"
// during demo playback freezes the demo instead of going to the server

await import("../src/gl_rsurf.js");
const common = await import("../src/common.js");
const cmd = await import("../src/cmd.js");
const zone = await import("../src/zone.js");
const host_cmd = await import("../src/host_cmd.js");
const client = await import("../src/client.js");
const demo = await import("../src/cl_demo.js");
const consolejs = await import("../src/console.js");

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

common.Con_SetPrintFunctions(
  (
    fmt,
    ...args
  ) => (args.length === 0 ? String(fmt) : consolejs._sprintf(fmt, ...args)),
  () => {},
);

zone.Memory_Init();
cmd.Cbuf_Init();
cmd.Cmd_Init();
host_cmd.Host_InitCommands();

// A demo of two one-byte messages after the "-1\n" track line
function demoData() {
  const data = new Uint8Array(3 + 2 * 17);
  data.set([0x2d, 0x31, 0x0a]);
  const view = new DataView(data.buffer);
  for (let m = 0; m < 2; m++) {
    const at = 3 + m * 17;
    view.setInt32(at, 1, true);
    data[at + 16] = 1; // svc_nop
  }

  return data.buffer;
}

Deno.test("pause during a demo freezes it, and a second pause resumes", () => {
  const { cl, cls } = client;
  const oldMessage = common.net_message;
  const message = new common.sizebuf_t();
  message.data = new Uint8Array(16);
  message.maxsize = 16;
  common.COM_SetNetMessage(message);
  try {
    demo.CL_PlayDemoFromData(demoData());
    assertEqual(cls.demoplayback, true, "playing");
    assertEqual(cls.demopaused, false, "starts unpaused");
    cls.signon = 0; // always grab until fully connected

    cmd.Cmd_ExecuteString("pause", cmd.src_command);
    assertEqual(cls.demopaused, true, "paused");
    assertEqual(Boolean(cl.paused), true, "cl.paused shows the plaque");

    // CL_ReadFromServer has just advanced cl.time; a paused demo undoes it
    cl.oldtime = 1;
    cl.time = 1.5;
    const pos = cls.demopos;
    assertEqual(demo.CL_GetMessage(), 0, "no message while paused");
    assertEqual(cl.time, 1, "cl.time held");
    assertEqual(cls.demopos, pos, "nothing read");

    cmd.Cmd_ExecuteString("pause", cmd.src_command);
    assertEqual(cls.demopaused, false, "resumed");
    assertEqual(Boolean(cl.paused), false, "plaque gone");
    assertEqual(demo.CL_GetMessage(), 1, "reads again");

    // stopping a paused demo clears the pause
    cmd.Cmd_ExecuteString("pause", cmd.src_command);
    demo.CL_StopPlayback();
    assertEqual(cls.demopaused, false, "stop clears demopaused");
    assertEqual(Boolean(cl.paused), false, "stop clears cl.paused");
  } finally {
    common.COM_SetNetMessage(oldMessage);
    client.cls.demoplayback = false;
    client.cls.demodata = null;
    client.cls.state = client.ca_disconnected;
  }
});
