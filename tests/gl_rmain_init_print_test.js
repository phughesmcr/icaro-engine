// R_Init's console prints are whole lines, so neither runs into the next one.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const gl_rmain = await import("../src/gl_rmain.js");
const { Con_SetPrintFunctions } = await import("../src/common.js");

Deno.test("R_Init prints whole lines", () => {
  const printed = [];
  Con_SetPrintFunctions((fmt) => printed.push(String(fmt)), () => {});
  try {
    gl_rmain.R_Init();
  } finally {
    Con_SetPrintFunctions(null, null);
  }

  const lines = printed.filter((text) => text.startsWith("R_Init"));
  const got = JSON.stringify(lines);
  const want = JSON.stringify([
    "R_Init\n",
    "R_Init: Three.js renderer ready\n",
  ]);
  if (got !== want) throw new Error(`expected ${want}, got ${got}`);
});
