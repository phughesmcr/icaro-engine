import {
  QUIC_CloseEndpoints,
  QUIC_OpenEndpoints,
  type QuicEndpointFactory,
} from "../server/quic_listen.ts";

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

interface FakeEndpoint {
  hostname: string;
  closed: boolean;
  close(): void;
}

// Each entry is what binding that hostname does: succeed, or throw the error.
function fakeFactory(outcomes: Record<string, Error | null>): {
  create: QuicEndpointFactory;
  calls: string[];
  made: FakeEndpoint[];
} {
  const calls: string[] = [];
  const made: FakeEndpoint[] = [];
  const create: QuicEndpointFactory = ({ hostname, port }) => {
    assertEqual(port, 4433, "port passed through");
    calls.push(hostname);
    const outcome = outcomes[hostname];
    if (outcome !== null) throw outcome;
    const endpoint: FakeEndpoint = {
      hostname,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    made.push(endpoint);
    return endpoint as unknown as Deno.QuicEndpoint;
  };
  return { create, calls, made };
}

function assertThrows(fn: () => unknown, expected: Error, message: string) {
  try {
    fn();
  } catch (error) {
    assertEqual(error, expected, message);
    return;
  }
  throw new Error(`${message}: did not throw`);
}

const inUse = () => new Deno.errors.AddrInUse("Address already in use");

Deno.test("QUIC_OpenEndpoints: dual-stack [::] covers IPv4", () => {
  const f = fakeFactory({ "::": null, "0.0.0.0": inUse() });
  const bound = QUIC_OpenEndpoints(4433, f.create);
  assertEqual(f.calls.join(","), "::,0.0.0.0", "binds IPv6 first");
  assertEqual(bound.endpoints.length, 1, "one endpoint");
  assertEqual(
    (bound.endpoints[0] as unknown as FakeEndpoint).hostname,
    "::",
    "kept [::]",
  );
  assertEqual(bound.description, "[::] (IPv6 and IPv4)", "description");
  assertEqual(f.made[0].closed, false, "[::] left open");
});

Deno.test("QUIC_OpenEndpoints: IPv6-only [::] also binds 0.0.0.0", () => {
  const f = fakeFactory({ "::": null, "0.0.0.0": null });
  const bound = QUIC_OpenEndpoints(4433, f.create);
  assertEqual(bound.endpoints.length, 2, "two endpoints");
  assertEqual(
    bound.description,
    "[::] (IPv6) and 0.0.0.0 (IPv4)",
    "description",
  );
  QUIC_CloseEndpoints(bound.endpoints);
  assertEqual(f.made.every((e) => e.closed), true, "close closes both");
});

Deno.test("QUIC_OpenEndpoints: no IPv6 falls back to IPv4", () => {
  const f = fakeFactory({
    "::": new Error("Address family not supported by protocol (os error 97)"),
    "0.0.0.0": null,
  });
  const bound = QUIC_OpenEndpoints(4433, f.create);
  assertEqual(bound.endpoints.length, 1, "one endpoint");
  assertEqual(bound.description, "0.0.0.0 (IPv4 only)", "description");
});

Deno.test("QUIC_OpenEndpoints: port in use on [::] fails", () => {
  const error = inUse();
  const f = fakeFactory({ "::": error, "0.0.0.0": null });
  assertThrows(() => QUIC_OpenEndpoints(4433, f.create), error, "rethrown");
  assertEqual(f.calls.join(","), "::", "IPv4 not tried");
});

Deno.test("QUIC_OpenEndpoints: missing --allow-net grant fails", () => {
  const v6Denied = new Deno.errors.NotCapable("Requires net access");
  const f1 = fakeFactory({ "::": v6Denied, "0.0.0.0": null });
  assertThrows(() => QUIC_OpenEndpoints(4433, f1.create), v6Denied, "[::]");
  assertEqual(f1.calls.join(","), "::", "IPv4 not tried");

  const v4Denied = new Deno.errors.NotCapable("Requires net access");
  const f2 = fakeFactory({ "::": null, "0.0.0.0": v4Denied });
  assertThrows(() => QUIC_OpenEndpoints(4433, f2.create), v4Denied, "0.0.0.0");
  assertEqual(f2.made[0].closed, true, "[::] closed again");
});

Deno.test("QUIC_OpenEndpoints: nothing bound fails", () => {
  const error = inUse();
  const f = fakeFactory({ "::": new Error("no IPv6"), "0.0.0.0": error });
  assertThrows(() => QUIC_OpenEndpoints(4433, f.create), error, "rethrown");
});
