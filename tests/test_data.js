// The repository's game data (server/game_data.js) for tests that set up
// the engine's modules themselves rather than through headless_init.

import { GD_PAK_PATH, GD_PAK_SEQUENCE } from "../server/game_data.js";

/**
 * Mounts GD_PAK, and the paks after it when GD_PAK_SEQUENCE is set, as
 * headless_init does by default. Without the sequence a local pak1.pak beside
 * the pak isn't mounted, so it can't change what a test sees. Returns the
 * number of paks mounted; throws when there is none.
 */
export async function TD_Mount() {
  const pak = await import("../src/pak.js");
  if (GD_PAK_SEQUENCE === true) {
    const count = await pak.COM_AddPakSequence(GD_PAK_PATH);
    if (count === 0) throw new Error(GD_PAK_PATH + " missing");
    return count;
  }
  const name = GD_PAK_PATH.slice(GD_PAK_PATH.lastIndexOf("/") + 1);
  const pack = await pak.COM_FetchPak(GD_PAK_PATH, name);
  if (pack === null) throw new Error(GD_PAK_PATH + " missing");
  pak.COM_AddPack(pack);
  return 1;
}
