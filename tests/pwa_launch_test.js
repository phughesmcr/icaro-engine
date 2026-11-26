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

Deno.test("an icon launch keeps the running game", () => {
  assertEqual(PWA_LaunchURL(BASE, BASE + "?map=e1m1"), null, "start URL");
  assertEqual(
    PWA_LaunchURL(BASE + "index.html", BASE + "?room=abc"),
    null,
    "index.html",
  );
});

Deno.test("a link that asks for something new is loaded", () => {
  const link = BASE + "?room=xyz";
  assertEqual(PWA_LaunchURL(link, BASE), link, "from the menu");
  assertEqual(PWA_LaunchURL(link, BASE + "?room=abc"), link, "other room");
  assertEqual(PWA_LaunchURL(link, link), null, "same room");
});

Deno.test("another origin or a bad URL is ignored", () => {
  assertEqual(
    PWA_LaunchURL("https://evil.example/?room=a", BASE),
    null,
    "origin",
  );
  assertEqual(PWA_LaunchURL("not a url", BASE), null, "bad target");
});

function fakeWindow(href) {
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
  };
  return win;
}

Deno.test("the launch that opened the page doesn't reload it", () => {
  const opened = BASE + "?room=abc";
  const win = fakeWindow(opened);
  PWA_InitLaunchQueue(win);
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
  PWA_InitLaunchQueue(win);
  win.consumer({ targetURL: BASE + "?room=new" });
  assertEqual(win.assigned.join(), BASE + "?room=new", "followed");
});

Deno.test("a browser without launchQueue is left alone", () => {
  PWA_InitLaunchQueue({ location: { href: BASE } });
});
