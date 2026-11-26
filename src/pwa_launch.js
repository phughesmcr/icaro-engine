// Web-only (no C equivalent): what an installed app does when it is launched
// again while it is already open. manifest.webmanifest asks for
// "focus-existing", so the browser focuses the open window and leaves the
// page alone; this module then decides whether to load the launched URL.
// Chromium only: where window.launchQueue is missing, nothing happens.

/**
 * The URL to load for a launch of targetURL while the page is at currentURL,
 * or null to keep the running game.
 *
 * Only a launch that asks for something replaces the game: a link with a
 * query (?room=, ?map=, ?server=, ...). Opening the app from its icon launches
 * the bare start URL, which keeps the game. So does a link to the page's own
 * URL while playing; with no game (the server ended it, say) the address can
 * still name the room, and the link loads it again.
 */
export function PWA_LaunchURL(targetURL, currentURL, playing) {
  let target, current;
  try {
    target = new URL(targetURL);
    current = new URL(currentURL);
  } catch {
    return null;
  }

  if (target.origin !== current.origin) return null;
  if (target.search === "") return null;
  if (
    playing === true && target.pathname === current.pathname &&
    target.search === current.search
  ) {
    return null;
  }

  return target.href;
}

/**
 * Takes the launches Chromium queues for this window. isPlaying says whether a
 * game is running (not a demo). pageURL is the URL the page was loaded with:
 * the first launch delivered can be the one that opened the page, and the game
 * may have rewritten the address since.
 */
export function PWA_InitLaunchQueue(
  win,
  isPlaying,
  pageURL = win.location.href,
) {
  if (typeof win.launchQueue?.setConsumer !== "function") return;

  // A reloaded page may be handed the launch it already acted on (unverified),
  // so its first one is ignored too. If it was a new tap, the next one works.
  const reloaded = win.performance?.getEntriesByType("navigation")[0]?.type ===
    "reload";

  let first = true;
  win.launchQueue.setConsumer((params) => {
    const opening = first && (reloaded || params.targetURL === pageURL);
    first = false;
    if (opening) return;

    const url = PWA_LaunchURL(
      params.targetURL,
      win.location.href,
      isPlaying(),
    );
    // pagehide autosaves a single-player game before the new page loads. A
    // ?map= link then starts a new game, which like `map` withdraws the offer
    // to continue; the save stays in the "autosave" slot.
    if (url !== null) win.location.assign(url);
  });
}
