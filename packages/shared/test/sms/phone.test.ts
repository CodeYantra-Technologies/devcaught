import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskPhone, maskPhoneSms, PHONE_PLACEHOLDER } from "../../src/sms/phone.ts";

describe("maskPhone() — pure phone masking", () => {
  it("masks every digit except the final four, keeping the sign", () => {
    assert.equal(maskPhone("+1 415 555 0123"), "+*******0123");
    assert.equal(maskPhone("+44 20 7193 8000"), "+********8000");
  });

  it("masks dashed and parenthesised numbers", () => {
    assert.equal(maskPhone("555-0123"), "***0123");
    assert.equal(maskPhone("(415) 555-0123"), "******0123");
  });

  it("leaves a four-digit number untouched", () => {
    assert.equal(maskPhone("1234"), "1234");
  });

  it("rejects non-string input", () => {
    assert.equal(maskPhone(undefined), null);
    assert.equal(maskPhone(null), null);
    assert.equal(maskPhone(1234), null);
    assert.equal(maskPhone({}), null);
  });

  it("rejects empty / whitespace-only input", () => {
    assert.equal(maskPhone(""), null);
    assert.equal(maskPhone("   "), null);
    assert.equal(maskPhone("\t\n"), null);
  });

  it("rejects too-short numbers", () => {
    assert.equal(maskPhone("123"), null);
    assert.equal(maskPhone("12"), null);
  });

  it("still masks when fewer than six digits but at least four are present", () => {
    assert.equal(maskPhone("12345"), "*2345");
  });

  it("does not mutate its input", () => {
    const input = "+1 415 555 0123";
    maskPhone(input);
    assert.equal(input, "+1 415 555 0123");
  });
});

describe("maskPhoneSms() — SMS phone presentation", () => {
  it("masks a raw number the same way as maskPhone", () => {
    assert.equal(maskPhoneSms("+1 415 555 0123"), "+*******0123");
    assert.equal(maskPhoneSms("555-0123"), "***0123");
    assert.equal(maskPhoneSms("12345"), "*2345");
  });

  it("preserves a value that is already masked", () => {
    assert.equal(maskPhoneSms("+*******0123"), "+*******0123");
    assert.equal(maskPhoneSms("*9999"), "*9999");
  });

  it("displays a safe placeholder for empty input", () => {
    assert.equal(maskPhoneSms(""), PHONE_PLACEHOLDER);
    assert.equal(maskPhoneSms("   "), PHONE_PLACEHOLDER);
    assert.equal(maskPhoneSms("\t\n"), PHONE_PLACEHOLDER);
  });

  it("displays a safe placeholder for invalid input", () => {
    assert.equal(maskPhoneSms("123"), PHONE_PLACEHOLDER);
    assert.equal(maskPhoneSms("12"), PHONE_PLACEHOLDER);
    assert.equal(maskPhoneSms(null as unknown), PHONE_PLACEHOLDER);
    assert.equal(maskPhoneSms(undefined), PHONE_PLACEHOLDER);
    assert.equal(maskPhoneSms(1234), PHONE_PLACEHOLDER);
  });
});
