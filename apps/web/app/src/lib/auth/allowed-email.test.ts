import { describe, expect, it } from "vitest";
import { isAllowedEmail } from "./allowed-email";

describe("isAllowedEmail", () => {
  it.each(["a@breeze.com", "A.B@Breeze.Cash", " a@breeze.com "])(
    "allows %s",
    (email) => expect(isAllowedEmail(email)).toBe(true),
  );

  it.each([
    "a@gmail.com",
    "a@breeze.com.evil.io",
    "a@evilbreeze.com",
    "a@sub.breeze.com",
    "a@b@breeze.com",
    "@breeze.com",
    "breeze.com",
    "",
    undefined,
    null,
    42,
  ])("rejects %s", (email) => expect(isAllowedEmail(email)).toBe(false));
});
