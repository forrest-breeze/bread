import { describe, expect, it } from "vitest";
import { loginErrorMessage, resolveLoginErrorReason } from "./login-error";

describe("resolveLoginErrorReason", () => {
  it("maps an expired magic link to the link_expired reason", () => {
    const params = new URLSearchParams(
      "error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired"
    );

    expect(resolveLoginErrorReason(params)).toBe("link_expired");
  });

  it("maps a denied consent screen to access_denied", () => {
    expect(resolveLoginErrorReason(new URLSearchParams("error=access_denied"))).toBe(
      "access_denied"
    );
  });

  it("falls back to the generic reason for unknown or absent codes", () => {
    expect(resolveLoginErrorReason(new URLSearchParams("error_code=server_error"))).toBe("auth");
    expect(resolveLoginErrorReason(new URLSearchParams())).toBe("auth");
  });
});

describe("loginErrorMessage", () => {
  it("returns null when no error is present", () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage("")).toBeNull();
  });

  it("returns expiry-specific copy for link_expired", () => {
    expect(loginErrorMessage("link_expired")).toMatch(/expired/i);
  });

  it("never echoes an unrecognized reason back into the UI", () => {
    expect(loginErrorMessage("<script>")).toBe(loginErrorMessage("auth"));
  });
});
