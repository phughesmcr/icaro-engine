// Entering WebXR: the on-page ENTER VR button is shown alongside Quest
// Browser's offerSession prompt, and a session from one path is not
// clobbered by a late session from the other.

// Bootstrap the renderer's existing circular module graph in its safe order.
await import("../src/gl_rsurf.js");

const webxr = await import("../src/webxr.js");

function assert(cond, message) {
  if (cond !== true) throw new Error(message);
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeGroup {
  constructor() {
    this.position = { set() {} };
    this.scale = { setScalar() {} };
  }

  add() {}
}

function fakeRenderer() {
  const listeners = {};
  const xr = {
    enabled: false,
    sessions: [],
    setReferenceSpaceType() {},
    getController() {
      return { userData: {}, addEventListener() {} };
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    setSession(session) {
      xr.sessions.push(session);
      listeners.sessionstart();
      return Promise.resolve();
    },
    endSession() {
      listeners.sessionend();
    },
  };
  return { xr: xr };
}

function fakeSession() {
  const session = {
    ended: false,
    requestReferenceSpace: () => Promise.resolve({}),
    end: () => {
      session.ended = true;
      return Promise.resolve();
    },
  };
  return session;
}

function fakeDocument() {
  const appended = [];
  return {
    appended: appended,
    createElement() {
      return {
        style: {},
        addEventListener(type, fn) {
          if (type === "click") this.click = fn;
        },
      };
    },
    body: {
      appendChild(el) {
        appended.push(el);
      },
    },
  };
}

Deno.test("webxr: ENTER VR button alongside offerSession, first session wins", async () => {
  const renderer = fakeRenderer();
  const doc = fakeDocument();
  const offers = []; // { resolve, reject } per offerSession call
  const requested = [];

  const xr = {
    isSessionSupported: () => Promise.resolve(true),
    offerSession() {
      return new Promise((resolve, reject) => offers.push({ resolve, reject }));
    },
    requestSession: () => {
      const s = fakeSession();
      requested.push(s);
      return Promise.resolve(s);
    },
  };

  const hadXR = Object.getOwnPropertyDescriptor(navigator, "xr");
  const hadDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldLog = console.log;

  Object.defineProperty(navigator, "xr", { value: xr, configurable: true });
  Object.defineProperty(globalThis, "document", {
    value: doc,
    configurable: true,
    writable: true,
  });
  console.log = () => {};
  webxr.XR_SetTestOverrides({
    renderer: renderer,
    THREE: { Group: FakeGroup },
  });

  try {
    webxr.XR_Init(null);
    await flush();

    assert(
      offers.length === 1,
      `offerSession called once, got ${offers.length}`,
    );
    assert(
      doc.appended.length === 1,
      "the ENTER VR button is shown when offerSession exists",
    );
    const button = doc.appended[0];
    assert(button.textContent === "ENTER VR", "button label");

    // Click the button: requestSession starts the session
    button.click();
    await flush();
    assert(requested.length === 1, "click calls requestSession");
    assert(
      renderer.xr.sessions.length === 1 &&
        renderer.xr.sessions[0] === requested[0],
      "requested session is set",
    );
    assert(webxr.isXRActive() === true, "XR active after the click");
    assert(button.style.display === "none", "button hidden in VR");

    // A click while in VR does nothing
    button.click();
    await flush();
    assert(
      requested.length === 1,
      "no requestSession while a session is active",
    );

    // The still-pending offer resolves late: that session is ended, not set
    const late = fakeSession();
    offers[0].resolve(late);
    await flush();
    assert(late.ended === true, "late offered session is ended");
    assert(
      renderer.xr.sessions.length === 1,
      "late offered session is not set",
    );

    // Leaving VR shows the button again and offers again
    renderer.xr.endSession();
    await flush();
    assert(webxr.isXRActive() === false, "XR inactive after sessionend");
    assert(button.style.display === "", "button shown again after sessionend");
    assert(offers.length === 2, "offerSession called again after sessionend");
    assert(doc.appended.length === 1, "button is not duplicated");

    // A dismissed offer is offered again after the next sessionend
    offers[1].reject(new Error("dismissed"));
    await flush();
    renderer.xr.endSession();
    await flush();
    assert(
      offers.length === 3,
      `re-offered after dismissal, got ${offers.length}`,
    );

    // Accepting that offer starts VR through the offer path
    const offered = fakeSession();
    offers[2].resolve(offered);
    await flush();
    assert(
      renderer.xr.sessions.length === 2 && renderer.xr.sessions[1] === offered,
      "offered session is set",
    );
    assert(webxr.isXRActive() === true, "XR active through the offer");

    // A session that arrives while another is still starting is ended
    renderer.xr.endSession();
    await flush();
    assert(offers.length === 4, "offered after the offered session ended");
    const realSetSession = renderer.xr.setSession;
    let finishSetSession = null;
    renderer.xr.setSession = (session) =>
      new Promise((resolve) => {
        finishSetSession = () => realSetSession(session).then(resolve);
      });
    button.click();
    await flush();
    assert(
      requested.length === 2 && finishSetSession !== null,
      "second click is starting a session",
    );
    const racing = fakeSession();
    offers[3].resolve(racing);
    await flush();
    assert(
      racing.ended === true,
      "offered session ended while another is starting",
    );
    button.click();
    await flush();
    assert(
      requested.length === 2,
      "no requestSession while a session is starting",
    );
    finishSetSession();
    await flush();
    assert(
      renderer.xr.sessions.length === 3 &&
        renderer.xr.sessions[2] === requested[1],
      "only the first session is set",
    );
    assert(
      webxr.isXRActive() === true,
      "XR active after the starting session finishes",
    );

    // setSession failing ends the session, offers again and allows another try
    renderer.xr.endSession();
    await flush();
    assert(offers.length === 5, "offered after the session ended");
    renderer.xr.setSession = () =>
      Promise.reject(new Error("setSession failed"));
    button.click();
    await flush();
    assert(
      requested.length === 3 && requested[2].ended === true,
      "failed session is ended",
    );
    assert(offers.length === 6, "offered again after the failure");
    assert(webxr.isXRActive() === false, "XR inactive after the failure");
    button.click();
    await flush();
    assert(
      requested.length === 4,
      "a click after the failure requests a session again",
    );
    renderer.xr.setSession = realSetSession;
  } finally {
    if (webxr.isXRActive()) renderer.xr.endSession();
    webxr.XR_SetTestOverrides();
    console.log = oldLog;
    if (hadXR !== undefined) Object.defineProperty(navigator, "xr", hadXR);
    else delete navigator.xr;
    if (hadDocument !== undefined) {
      Object.defineProperty(globalThis, "document", hadDocument);
    } else delete globalThis.document;
  }
});
