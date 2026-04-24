import { describe, expect, it } from "vitest";
import { parseAuthStatus, redactEmail } from "../src";

describe("parseAuthStatus", () => {
  it("parses real CC 2.1.119 subscription output", () => {
    const raw = [
      "Login method: Claude Pro account",
      "Organization: Acme Corp",
      "Email: user@example.com",
    ].join("\n");
    expect(parseAuthStatus(raw)).toEqual({
      loggedIn: true,
      method: "subscription",
      email: "user@example.com",
      organization: "Acme Corp",
    });
  });

  it("classifies Claude Max as subscription", () => {
    const out = parseAuthStatus("Login method: Claude Max account\nEmail: a@b");
    expect(out.method).toBe("subscription");
  });

  it("classifies API key as api_key", () => {
    const out = parseAuthStatus("Login method: Anthropic API key\nEmail: a@b");
    expect(out.method).toBe("api_key");
  });

  it("treats missing Login method line as not logged in", () => {
    expect(parseAuthStatus("not logged in\n").loggedIn).toBe(false);
    expect(parseAuthStatus("").loggedIn).toBe(false);
  });

  it("accepts CRLF line separators (Windows output)", () => {
    const raw = "Login method: Claude Pro account\r\nEmail: u@e.com\r\n";
    expect(parseAuthStatus(raw).loggedIn).toBe(true);
  });

  it("leaves method undefined for unrecognized label (future CC versions)", () => {
    const out = parseAuthStatus("Login method: Some Future Auth\nEmail: a@b");
    expect(out.loggedIn).toBe(true);
    expect(out.method).toBeUndefined();
  });
});

describe("redactEmail", () => {
  it("masks local-part to first char + ***", () => {
    expect(redactEmail("truman@example.com")).toBe("t***@example.com");
  });

  it("keeps domain intact", () => {
    expect(redactEmail("x@gmx.es")).toBe("x***@gmx.es");
  });

  it("returns *** for malformed input without @", () => {
    expect(redactEmail("no-at-sign")).toBe("***");
    expect(redactEmail("")).toBe("***");
  });
});
