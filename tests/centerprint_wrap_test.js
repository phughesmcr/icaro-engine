// Tests for the 2021 rerelease centerprint word wrap (Ironwail COM_WordWrap,
// COM_AdvanceLineWrapped, SCR_GetCenterPrintWrapLimit and SCR_CenterPrint
// with scr_usekfont). The expected strings were worked out by hand from
// Ironwail's C, not taken from the port's output.

const common = await import("../src/common.js");
const draw = await import("../src/gl_draw.js");
const scr = await import("../src/gl_screen.js");

globalThis.window ??= { devicePixelRatio: 1 }; // gl_draw.js sizes the UI from it

scr.SCR_SetExternals({
  cl: { intermission: 0, paused: false, worldmodel: null, time: 0 },
});

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

// Sets the physical size with a UI scale of 1, so the centerprint canvas is
// width units wide; returns a restore function
function useScreen(width, height) {
  const savedConHeight = draw.SCR_GetConHeight();
  draw.Draw_SetExternals({ vid: { width, height } });
  draw.SCR_SetConHeight(height);
  return () => {
    draw.Draw_SetExternals({ vid: { width: 640, height: 480 } });
    draw.SCR_SetConHeight(savedConHeight);
  };
}

Deno.test("COM_WordWrap wraps at word boundaries as Ironwail does", () => {
  const wrap = (s, cols) => common.COM_WordWrap(s, 1024, cols);

  // a word pushed to the next line keeps the space before it
  assertEqual(wrap("hello world foo", 10), "hello \nworld foo", "push word");
  // a line that ends exactly at the limit eats the one space after it
  assertEqual(wrap("abcde fghij klm", 11), "abcde fghij\nklm", "exact fit");
  assertEqual(wrap("abcd  efgh", 5), "abcd \nefgh", "only one space eaten");
  assertEqual(
    wrap("abcdefghijklmno", 10),
    "abcdefghij\nklmno",
    "overlong word split at the limit",
  );
  assertEqual(
    wrap("ab cdefghijklmnop", 10),
    "ab cdefghi\njklmnop",
    "overlong word after another fills the line",
  );
  assertEqual(wrap("a\n\nb", 10), "a\n\nb", "blank lines preserved");
  assertEqual(wrap("\nx", 10), "\nx", "leading newline preserved");
  assertEqual(wrap("hi\n", 10), "hi", "a trailing newline is dropped");
  assertEqual(wrap("", 10), "", "empty string");
});

Deno.test("COM_WordWrap copies unwrapped when maxcols <= 0, and caps at dstsize - 1", () => {
  const long = "x".repeat(2000);
  assertEqual(common.COM_WordWrap("a\n", 1024, 0), "a\n", "plain copy");
  assertEqual(
    common.COM_WordWrap(long, 1024, 0),
    long.substring(0, 1023),
    "plain copy cut to 1023",
  );

  // 20 lines of 50 plus their newlines make 1020; 3 more chars fill 1023
  const wrapped = common.COM_WordWrap(long, 1024, 50);
  assertEqual(wrapped.length, 1023, "wrapped copy cut to 1023");
  assertEqual(wrapped.split("\n").length, 21, "21 lines");
  assertEqual(wrapped.endsWith("\nxxx"), true, "last line cut short");
});

Deno.test("SCR_GetCenterPrintWrapLimit is 40 to 50 columns, a quarter of the way to the screen width", () => {
  for (
    const [width, height, cols] of [
      [320, 200, 40],
      [400, 300, 42], // LERP( 320, 400, 0.25 ) = 340
      [640, 480, 50],
      [4000, 480, 50], // clamped at 400
    ]
  ) {
    const restore = useScreen(width, height);
    try {
      assertEqual(scr.SCR_GetCenterPrintWrapLimit(), cols, `${width} wide`);
    } finally {
      restore();
    }
  }
});

Deno.test("SCR_CenterPrint wraps only when scr_usekfont is set", () => {
  const restore = useScreen(320, 200); // 40 columns
  const saved = scr.scr_usekfont.value;
  const text = "You need the gold key to open this door, " +
    "and the silver key to open the other one";

  try {
    scr.scr_usekfont.value = 0;
    scr.SCR_CenterPrint(text);
    let center = scr.SCR_GetCenterString();
    assertEqual(center.text, text, "id behaviour: unchanged");
    assertEqual(center.lines, 1, "one line");

    scr.scr_usekfont.value = 1;
    scr.SCR_CenterPrint(text + "\nSecond line");
    center = scr.SCR_GetCenterString();
    assertEqual(
      center.text,
      "You need the gold key to open this door,\n" +
        "and the silver key to open the other one\n" +
        "Second line",
      "wrapped at 40",
    );
    assertEqual(center.lines, 3, "lines counted on the wrapped string");
  } finally {
    scr.scr_usekfont.value = saved;
    restore();
  }
});
