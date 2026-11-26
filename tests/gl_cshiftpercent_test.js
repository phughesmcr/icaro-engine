// QuakeSpasm's gl_cshiftpercent_contents/_damage/_bonus/_powerup scale each
// colour shift on top of gl_cshiftpercent.

// Bootstrap the client renderer graph in its established safe import order.
await import("../src/gl_rsurf.js");

const { V_CalcBlend, V_Init, v_blend } = await import("../src/view.js");
const { cl, CSHIFT_CONTENTS, CSHIFT_DAMAGE, NUM_CSHIFTS } = await import(
  "../src/client.js"
);
const { Cvar_SetValue, Cvar_FindVar } = await import("../src/cvar.js");

function assertNear(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-5) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

if (Cvar_FindVar("gl_cshiftpercent_damage") === null) {
  V_Init();
}

Deno.test("gl_cshiftpercent_* scale each colour shift", () => {
  const saved = cl.cshifts.map((c) => c.percent);
  try {
    for (let i = 0; i < NUM_CSHIFTS; i++) {
      cl.cshifts[i].percent = 0;
    }
    cl.cshifts[CSHIFT_DAMAGE].percent = 102;

    V_CalcBlend();
    assertNear(v_blend[3], 102 / 255, "all at 100: id blend");

    Cvar_SetValue("gl_cshiftpercent_damage", 50);
    V_CalcBlend();
    assertNear(v_blend[3], 51 / 255, "damage at 50%");

    Cvar_SetValue("gl_cshiftpercent", 50);
    V_CalcBlend();
    assertNear(v_blend[3], 25.5 / 255, "multiplies with gl_cshiftpercent");

    Cvar_SetValue("gl_cshiftpercent_contents", 0); // other types are unaffected
    V_CalcBlend();
    assertNear(v_blend[3], 25.5 / 255, "contents cvar leaves damage alone");

    cl.cshifts[CSHIFT_CONTENTS].percent = 128;
    V_CalcBlend();
    assertNear(v_blend[3], 25.5 / 255, "contents at 0% adds nothing");
  } finally {
    for (
      const name of [
        "gl_cshiftpercent",
        "gl_cshiftpercent_contents",
        "gl_cshiftpercent_damage",
      ]
    ) {
      Cvar_SetValue(name, 100);
    }
    saved.forEach((p, i) => cl.cshifts[i].percent = p);
    V_CalcBlend();
  }
});
