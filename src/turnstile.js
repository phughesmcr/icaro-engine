// Cloudflare Turnstile widget for lobby room requests. Web-only addition,
// with no C counterpart.
//
// A lobby that checks room creation answers a request without a token with
// LOBBY_VERIFY { sitekey, action } (server/turnstile.js). NET_CreateRoom
// then calls Turnstile_GetToken, which shows the widget over the game,
// resolves to a single-use token, and removes the widget again, so every
// request gets a fresh one. Nothing here touches the DOM until it is called.

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Above the touch controls (touch.js, z-index up to 202)
const TURNSTILE_Z_INDEX = 300;

let turnstile_script = null; // Promise of window.turnstile, once loading starts
let turnstile_active = null; // The widget on screen: { overlay, box, widgetId, finish }

/** Load Cloudflare's api.js once, for explicit rendering. */
function _Turnstile_LoadScript() {
  if (turnstile_script !== null) return turnstile_script;

  turnstile_script = new Promise((resolve, reject) => {
    if (window.turnstile != null) {
      resolve(window.turnstile);
      return;
    }

    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.turnstile != null) resolve(window.turnstile);
      else reject(new Error("Verification widget failed to load"));
    };
    script.onerror = () =>
      reject(new Error("Verification widget failed to load"));
    document.head.appendChild(script);
  });

  // Let a later request try again after a failed load
  turnstile_script.catch(() => {
    turnstile_script = null;
  });

  return turnstile_script;
}

function _Turnstile_BuildOverlay(onCancel) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position: fixed; inset: 0; z-index: " +
    TURNSTILE_Z_INDEX + ";" +
    " display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;" +
    " background: rgba( 0, 0, 0, 0.7 ); color: #ddd; font: 16px sans-serif; text-align: center;";

  const label = document.createElement("div");
  label.textContent = "Checking you are human before starting a room";
  overlay.appendChild(label);

  const box = document.createElement("div");
  box.style.minHeight = "65px";
  overlay.appendChild(box);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.style.cssText =
    "padding: 8px 20px; font: inherit; color: #ddd; background: #333; border: 1px solid #777; border-radius: 4px;";
  cancel.addEventListener("click", onCancel);
  overlay.appendChild(cancel);

  return { overlay, box };
}

/**
 * Show the widget for sitekey and action. Resolves to its token; rejects if
 * the widget fails, expires or times out, or Turnstile_Cancel is called.
 */
export function Turnstile_GetToken(sitekey, action) {
  Turnstile_Cancel();

  return new Promise((resolve, reject) => {
    const state = { overlay: null, box: null, widgetId: null, finish: null };

    state.finish = (error, token) => {
      if (turnstile_active !== state) return;
      turnstile_active = null;

      if (state.widgetId !== null && window.turnstile != null) {
        try {
          window.turnstile.remove(state.widgetId);
        } catch { /* already gone */ }
      }

      state.overlay.remove();
      if (error !== null) reject(error);
      else resolve(token);
    };

    const built = _Turnstile_BuildOverlay(() =>
      state.finish(new Error("Verification cancelled"))
    );
    state.overlay = built.overlay;
    state.box = built.box;
    turnstile_active = state;

    // The widget needs the mouse
    if (
      document.pointerLockElement != null &&
      typeof document.exitPointerLock === "function"
    ) {
      document.exitPointerLock();
    }

    document.body.appendChild(state.overlay);

    _Turnstile_LoadScript().then((turnstile) => {
      if (turnstile_active !== state) return;
      let widgetId;
      try {
        widgetId = turnstile.render(state.box, {
          sitekey,
          action,
          theme: "dark",
          callback: (token) => state.finish(null, token),
          "error-callback": () =>
            state.finish(new Error("Verification failed. Try again.")),
          "expired-callback": () =>
            state.finish(new Error("Verification expired. Try again.")),
          "timeout-callback": () =>
            state.finish(new Error("Verification timed out. Try again.")),
        });
      } catch (error) {
        // A sitekey the API rejects throws here
        state.finish(
          error instanceof Error ?
            error :
            new Error("Verification failed. Try again."),
        );
        return;
      }

      if (turnstile_active === state) {
        state.widgetId = widgetId;
      } else if (widgetId != null) {
        // A callback already finished the request during render
        try {
          turnstile.remove(widgetId);
        } catch { /* already gone */ }
      }
    }, (error) => state.finish(error));
  });
}

/** Remove the widget, if one is on screen, and reject its request. */
export function Turnstile_Cancel() {
  if (turnstile_active !== null) {
    turnstile_active.finish(new Error("Verification cancelled"));
  }
}
