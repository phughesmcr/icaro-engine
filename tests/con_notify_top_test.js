// Tests for Con_SetNotifyTop: the notify lines start below the touch controls'
// top buttons (a deviation from the C, which draws them from row 0)

await import("../src/gl_rsurf.js");
const cmd = await import("../src/cmd.js");
const con = await import("../src/console.js");
const { Draw_GetVirtualHeight } = await import("../src/gl_draw.js");

globalThis.window = { devicePixelRatio: 1, innerWidth: 412, innerHeight: 891 };
cmd.Cbuf_Init();
cmd.Cmd_Init();
con.Con_Init();

const realtime = 1;
let top = -1;
con.Con_SetExternals({
  Draw_Character: (_x, y) => {
    if (top < 0 || y < top) top = y;
  },
  getRealtime: () => realtime,
});

function firstNotifyRow() {
  top = -1;
  con.Con_DrawNotify();
  return top;
}

Deno.test("notify lines start at row 0 with no offset, as in the C", () => {
  try {
    con.Con_SetNotifyTop(0);
    con.Con_Printf("You got the shells\n");
    const row = firstNotifyRow();
    if (row !== 0) throw new Error(`expected row 0, got ${row}`);
  } finally {
    con.Con_SetNotifyTop(0);
  }
});

Deno.test("Con_SetNotifyTop moves the notify lines below the buttons", () => {
  try {
    con.Con_Printf("You got the nails\n");
    con.Con_SetNotifyTop(56);
    const expected = Math.ceil(56 * Draw_GetVirtualHeight() / 891);
    const row = firstNotifyRow();
    if (expected <= 0 || row !== expected) {
      throw new Error(`expected row ${expected}, got ${row}`);
    }

    // Touch_Disable passes 0: back to the top
    con.Con_SetNotifyTop(0);
    if (firstNotifyRow() !== 0) throw new Error("offset not cleared");
  } finally {
    con.Con_SetNotifyTop(0);
  }
});
