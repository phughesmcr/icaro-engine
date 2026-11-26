// What an installed app does when launched again while open
// (src/pwa_launch.js).

const { PWA_InitLaunchQueue, PWA_LaunchURL } = await import(
  "../src/pwa_launch.js"
);

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const BASE = "https://quake.example/";

const playing = () => true;
const idle = () => false;

Deno.test("an icon launch keeps the running game", () => {
  assertEqual(
    PWA_LaunchURL(BASE, BASE + "?map=e1m1", true),
    null,
    "start URL",
  );
  assertEqual(
    PWA_LaunchURL(BASE + "index.html", BASE + "?room=abc", false),
    null,
    "index.html",
  );
});

Deno.test("a link that asks for something new is loaded", () => {
  const link = BASE + "?room=xyz";
  assertEqual(PWA_LaunchURL(link, BASE, true), link, "from the menu");
  assertEqual(
    PWA_LaunchURL(link, BASE + "?room=abc", true),
    link,
    "other room",
  );
  assertEqual(
    PWA_LaunchURL(link, BASE + "index.html?room=xyz", true),
    link,
    "other path",
  );
});

Deno.test("the page's own link reloads only when no game is running", () => {
  const link = BASE + "?room=xyz";
  assertEqual(PWA_LaunchURL(link, link, true), null, "playing");
  assertEqual(PWA_LaunchURL(link, link, false), link, "game over");
});

Deno.test("another origin or a bad URL is ignored", () => {
  assertEqual(
    PWA_LaunchURL("https://evil.example/?room=a", BASE, false),
    null,
    "origin",
  );
  assertEqual(PWA_LaunchURL("not a url", BASE, false), null, "bad target");
  assertEqual(PWA_LaunchURL(undefined, BASE, false), null, "no target");
});

function fakeWindow(href, navigationType = "navigate") {
  const win = {
    assigned: [],
    consumer: null,
    location: {
      href,
      assign: (url) => win.assigned.push(url),
    },
    launchQueue: {
      setConsumer: (fn) => win.consumer = fn,
    },
    performance: {
      getEntriesByType: () => [{ type: navigationType }],
    },
  };
  return win;
}

Deno.test("the launch that opened the page doesn't reload it", () => {
  const opened = BASE + "?room=abc";
  const win = fakeWindow(opened);
  PWA_InitLaunchQueue(win, idle);
  // the game dropped ?room= before the launch was delivered
  win.location.href = BASE;
  win.consumer({ targetURL: opened });
  assertEqual(win.assigned.length, 0, "opening launch");

  // tapping the same link later is a real launch
  win.consumer({ targetURL: opened });
  assertEqual(win.assigned.join(), opened, "later launch");
});

Deno.test("a first launch that differs from the page's URL is followed", () => {
  const win = fakeWindow(BASE);
  PWA_InitLaunchQueue(win, playing);
  win.consumer({ targetURL: BASE + "?room=new" });
  assertEqual(win.assigned.join(), BASE + "?room=new", "followed");
});

Deno.test("a reload doesn't go back to the launch it came from", () => {
  const win = fakeWindow(BASE, "reload");
  PWA_InitLaunchQueue(win, idle);
  win.consumer({ targetURL: BASE + "?room=old" });
  assertEqual(win.assigned.length, 0, "first launch after a reload");
  win.consumer({ targetURL: BASE + "?room=new" });
  assertEqual(win.assigned.join(), BASE + "?room=new", "next launch");
});

Deno.test("the game state is read at each launch", () => {
  const link = BASE + "?room=abc";
  const win = fakeWindow(BASE);
  let connected = true;
  PWA_InitLaunchQueue(win, () => connected);
  win.location.href = link;
  win.consumer({ targetURL: link });
  assertEqual(win.assigned.length, 0, "while playing");
  connected = false;
  win.consumer({ targetURL: link });
  assertEqual(win.assigned.join(), link, "after the game ended");
});

Deno.test("a browser without launchQueue is left alone", () => {
  PWA_InitLaunchQueue({ location: { href: BASE } }, idle);
});
