import { describe, expect, it, vi } from "vitest";
import {
  parseMacOSSystemProxy,
  resolveHermesNetworkEnvironment,
} from "../src/main/services/hermes/network-environment";

describe("Hermes trusted network environment", () => {
  it("converts enabled macOS HTTP and HTTPS proxies into a frozen safe snapshot", () => {
    const environment = parseMacOSSystemProxy(`
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}
`);

    expect(environment).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it.each([
    ["credential-bearing host", "proxy-user:proxy-pass@127.0.0.1"],
    ["URL-shaped host", "https://127.0.0.1"],
    ["path-bearing host", "127.0.0.1/escape"],
    ["control-character host", "127.0.0.1\tescape"],
  ])("fails closed for a %s", (_label, proxyHost) => {
    expect(
      parseMacOSSystemProxy(`
<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : ${proxyHost}
}
`),
    ).toEqual({});
  });

  it.each(["0", "65536", "not-a-port"])('fails closed for invalid port "%s"', (port) => {
    expect(
      parseMacOSSystemProxy(`
<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : ${port}
  HTTPSProxy : 127.0.0.1
}
`),
    ).toEqual({});
  });

  it("does not read macOS settings on another platform", () => {
    const readSystemProxy = vi.fn(() => {
      throw new Error("must not run");
    });

    expect(resolveHermesNetworkEnvironment({ platform: "linux", readSystemProxy })).toEqual({});
    expect(readSystemProxy).not.toHaveBeenCalled();
  });

  it("fails closed when macOS proxy discovery fails", () => {
    expect(
      resolveHermesNetworkEnvironment({
        platform: "darwin",
        readSystemProxy: () => {
          throw new Error("scutil unavailable");
        },
      }),
    ).toEqual({});
  });
});
