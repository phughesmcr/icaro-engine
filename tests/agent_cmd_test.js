// src/agent.js Agent_Command over the headless host: each call returns the
// console output of its own command, in lockstep (through server/agent_mcp.ts)
// and in realtime, where the host's own frames run the game.

import { mcp_session } from "./agent_mcp_client.js";
import { Agent_Attach, Agent_Command, Agent_Tics } from "../src/agent.js";
import { headless_frame } from "../server/headless_host.js";
import { host_framecount } from "../src/host.js";
import { GD_MAPS } from "../server/game_data.js";

function assert(cond, message) {
  if (cond !== true) {
    throw new Error(message);
  }
}

// One host per process, kept across tests (see agent_mcp_test.js)
const ENGINE_TEST = { sanitizeResources: false, sanitizeOps: false };

let session = null;
async function call(name, args = {}) {
  if (session === null) {
    session = await mcp_session();
  }
  const r = await session.raw(name, args);
  assert(r.isError !== true, name + " failed: " + r.content[0].text);
  return r.content[0].text;
}

Deno.test({
  name: "agent cmd: lockstep returns each command's own output",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
    // The client's first two moves after a load aren't sent, so step past
    // them: from then on a server command waits behind each tic's move
    await call("step", { tics: 4 });
    let tic = Agent_Tics();
    const on = await call("cmd", { text: "god" });
    assert(on.includes("godmode ON"), "god:\n" + on);
    assert(Agent_Tics() - tic === 2, "god ran " + (Agent_Tics() - tic));
    tic = Agent_Tics();
    const echo = await call("cmd", { text: "echo lockstep-echo" });
    assert(echo.includes("lockstep-echo"), "echo:\n" + echo);
    assert(!echo.includes("godmode"), "echo repeats god:\n" + echo);
    assert(Agent_Tics() - tic === 1, "echo ran " + (Agent_Tics() - tic));
    const off = await call("cmd", { text: "god" });
    assert(off.includes("godmode OFF"), "god again:\n" + off);
  },
});

Deno.test({
  name: "agent cmd: realtime returns each command's own output",
  ...ENGINE_TEST,
  fn: async () => {
    await call("start", { map: GD_MAPS.level, skill: 1, seed: 1 });
    // The host runs its own frames, slower than one per tic, as a busy or
    // throttled browser tab does
    Agent_Attach("realtime");
    const driver = setInterval(() => headless_frame(), 60);
    try {
      const frame = host_framecount;
      const echo = await Agent_Command("echo realtime-echo");
      assert(echo.includes("realtime-echo"), "echo:\n" + echo);
      // In a game it waits for a frame, so the command has taken effect
      assert(host_framecount !== frame, "echo returned before a frame ran");

      // god runs on the server: its reply comes back over the connection
      const on = await Agent_Command("god");
      assert(on.includes("godmode ON"), "god:\n" + on);
      const next = await Agent_Command("echo after-god");
      assert(next.includes("after-god"), "echo:\n" + next);
      assert(!next.includes("godmode"), "echo repeats god:\n" + next);
      const off = await Agent_Command("god");
      assert(off.includes("godmode OFF"), "god again:\n" + off);
    } finally {
      clearInterval(driver);
      Agent_Attach("lockstep");
    }
  },
});
