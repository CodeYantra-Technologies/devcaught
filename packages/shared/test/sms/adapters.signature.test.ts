import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  twilioSignature,
  twilioVerifySignature,
  twilioVerifyWithBody,
} from "../../src/sms/adapters.ts";

/**
 * Independent oracle: the published algorithm from the official Twilio node
 * SDK (twilio/twilio-node, src/webhooks/webhooks.ts, getExpectedTwilioSignature).
 * Reproduced verbatim so this test checks the implementation against the
 * official SDK's behavior, not against our own recollection.
 *
 * The fixture values in this file (auth tokens, URLs, parameters, bodies) are
 * self-chosen test fixtures computed from this algorithm. None are claimed to
 * be the official Twilio published vector.
 */
function toFormUrlEncodedParam(paramName: string, paramValue: string | string[]): string {
  if (paramValue instanceof Array) {
    return Array.from(new Set(paramValue))
      .sort()
      .map((val) => toFormUrlEncodedParam(paramName, val))
      .reduce((acc, val) => acc + val, "");
  }
  return paramName + paramValue;
}

function twilioSignatureOracle(authToken: string, url: string, params: Record<string, string | string[]>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + toFormUrlEncodedParam(key, params[key]), url);
  return createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

describe("twilioSignature — known correct form signature", () => {
  // Documented Twilio webhook example (Secure webhooks).
  const url = "https://mycompany.com/myapp";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };
  // Self-chosen auth token for this test fixture only; not part of any
  // official Twilio published vector.
  const authToken = "sk_test_devcaught_sig_test_0001";

  it("matches the official Twilio SDK algorithm", () => {
    const actual = twilioSignature(authToken, url, params);
    const expected = twilioSignatureOracle(authToken, url, params);
    assert.equal(actual, expected, "deviates from the official Twilio SDK algorithm");
  });
});

describe("twilioVerifySignature — tampered form parameters", () => {
  const authToken = "sk_test_devcaught_sig_test_0001";
  const url = "https://mycompany.com/myapp";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };
  const signature = twilioSignature(authToken, url, params);

  it("rejects a tampered parameter value", () => {
    const tampered = { ...params, Digits: "9999" };
    assert.equal(
      twilioVerifySignature(authToken, url, tampered, signature),
      false,
    );
  });
});

describe("twilioVerifySignature — incorrect public URL", () => {
  const authToken = "sk_test_devcaught_sig_test_0001";
  const url = "https://mycompany.com/myapp";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };
  const signature = twilioSignature(authToken, url, params);

  it("rejects a request whose public webhook URL differs from the configured one", () => {
    assert.equal(
      twilioVerifySignature(authToken, "https://evil.example.com/myapp", params, signature),
      false,
    );
  });
});

describe("twilioVerifyWithBody — JSON webhook verification", () => {
  // Self-chosen auth token for this test fixture only; not part of any
  // official Twilio published vector. Signature values are computed below at
  // runtime with the independent oracle — they are fixtures, not official
  // Twilio vectors.
  const authToken = "«redacted:sk_test_…»";
  const urlBase = "https://mycompany.com/myapp";

  // Independent oracle (the official Twilio SDK algorithm) — signature over
  // the URL with no form params; used to generate fixture signatures.
  function signatureFor(url: string): string {
    return twilioSignatureOracle(authToken, url, {});
  }

  // 1. Valid JSON body, matching bodySHA256 and valid signature.
  it("accepts a valid JSON webhook whose body sha256 matches and signature is valid", () => {
    const body = '{"msg":"hello"}';
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const url = `${urlBase}?bodySHA256=${bodyHash}`;
    // Fixture signature: computed at runtime by the independent oracle.
    const expectedSignature = signatureFor(url);

    const { bodyOk, signatureOk } = twilioVerifyWithBody(authToken, url, body, bodyHash, expectedSignature);

    // Body integrity and signature validation are checked separately.
    assert.equal(bodyOk, true, "body sha256 must match");
    assert.equal(signatureOk, true, "signature must be valid");
    // Overall acceptance requires BOTH to be true.
    assert.equal(bodyOk && signatureOk, true, "overall acceptance must be true");
  });

  // 2. Genuinely modified JSON body with unchanged bodySHA256 must fail body
  //    integrity (signature is still valid over the unchanged URL).
  it("rejects a genuinely modified JSON body when bodySHA256 is unchanged", () => {
    const originalBody = '{"msg":"hello"}';
    const originalBodyHash = createHash("sha256").update(originalBody, "utf8").digest("hex");
    const modifiedBody = '{"msg":"world"}';
    // bodySHA256 deliberately unchanged even though the body was modified.
    const url = `${urlBase}?bodySHA256=${originalBodyHash}`;
    // Fixture signature: computed by the independent oracle over the URL.
    const expectedSignature = signatureFor(url);

    const { bodyOk, signatureOk } = twilioVerifyWithBody(authToken, url, modifiedBody, originalBodyHash, expectedSignature);

    // Body integrity must fail; signature must still pass.
    assert.equal(bodyOk, false, "modified body must fail body integrity");
    assert.equal(signatureOk, true, "signature over the unchanged URL must be valid");
    // Overall acceptance requires both; here it fails through bodyOk.
    assert.equal(bodyOk && signatureOk, false, "overall acceptance must be false");
  });

  // 3. Modified bodySHA256 in the public URL must fail signature validation
  //    (the body hash argument is still correct, but the signed URL changed).
  it("rejects a request whose public URL bodySHA256 was modified", () => {
    const body = '{"msg":"hello"}';
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const originalUrl = `${urlBase}?bodySHA256=${bodyHash}`;
    // Tamper the bodySHA256 query value so the signed URL differs.
    const tamperedHash = bodyHash.replace("0", "1").replace("0", "2").replace("0", "3");
    const tamperedUrl = `${urlBase}?bodySHA256=${tamperedHash}`;
    // Fixture signature: computed by the independent oracle over the ORIGINAL
    // URL (the signature covers the URL, which carries bodySHA256).
    const expectedSignature = signatureFor(originalUrl);

    const { bodyOk, signatureOk } = twilioVerifyWithBody(authToken, tamperedUrl, body, bodyHash, expectedSignature);

    // Body hash argument still matches; signature must fail because the
    // signed URL now differs from what the fixture signature covers.
    assert.equal(bodyOk, true, "body hash argument must still match");
    assert.equal(signatureOk, false, "signature over the modified URL must be invalid");
    // Overall acceptance requires both; here it fails through signatureOk.
    assert.equal(bodyOk && signatureOk, false, "overall acceptance must be false");
  });

  // 4. Incorrect auth token must fail signature validation.
  it("rejects a valid signature computed with a different auth token", () => {
    const body = '{"msg":"hello"}';
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const url = `${urlBase}?bodySHA256=${bodyHash}`;
    // Fixture signature: computed by the independent oracle over the correct
    // URL with the correct auth token.
    const expectedSignature = signatureFor(url);
    // Self-generated fixture: an incorrect auth token (not used to compute the
    // fixture signature above).
    const wrongAuthToken = "«redacted:wrong_sk_test_…»";

    const { bodyOk, signatureOk } = twilioVerifyWithBody(wrongAuthToken, url, body, bodyHash, expectedSignature);

    // Body hash argument still matches; signature must fail because the
    // signature was computed over the wrong auth token.
    assert.equal(bodyOk, true, "body hash must still match");
    assert.equal(signatureOk, false, "signature over the wrong auth token must be invalid");
    // Overall acceptance requires both; here it fails through signatureOk.
    assert.equal(bodyOk && signatureOk, false, "overall acceptance must be false");
  });
});

describe("twilioVerifySignature — webhook edge cases", () => {
  // Shared fixture (self-chosen; not an official Twilio vector).
  const authToken = "«redacted:sk_test_…»";
  const url = "https://mycompany.com/myapp";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+123****3030",
    Digits: "1234",
    From: "+123****3030",
    To: "+180****1212",
  };

  // Independent oracle (official Twilio SDK algorithm) — signature over the
  // URL plus the given form parameters, alphabet-sorted.
  function signatureFor(params: Record<string, string | string[]>): string {
    return twilioSignatureOracle(authToken, url, params);
  }

  // Helper for the byte-flip fixture (test 3).
  function flipChar(s: string, index: number, replacement: string): string {
    if (index >= s.length) throw new Error("signature index out of range");
    return s.slice(0, index) + replacement + s.slice(index + 1);
  }

  // 1. Missing X-Twilio-Signature. An empty (missing) signature must fail
  //    signature validation, while body integrity can still be assessed.
  it("rejects a request with a missing X-Twilio-Signature", () => {
    const body = '{"msg":"hello"}';
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const urlWithBodyHash = `${url}?bodySHA256=${bodyHash}`;
    // Empty string: the missing-signature case.
    const result = twilioVerifyWithBody(authToken, urlWithBodyHash, body, bodyHash, "");

    assert.equal(result.bodyOk, true, "body sha256 must still match");
    assert.equal(result.signatureOk, false, "signature must be rejected when missing");
    assert.equal(result.bodyOk && result.signatureOk, false, "overall acceptance must be false");
  });

  // 2. Malformed or invalid Base64 signature. A signature that is not valid
  //    Base64 (or otherwise not a plausible X-Twilio-Signature value) must
  //    fail signature validation.
  it("rejects a signature that is not valid Base64", () => {
    const body = '{"msg":"hello"}';
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const expectedSignature = signatureFor(params);
    // Self-generated fixture: deliberately not a Base64 HMAC output.
    const malformed = "!!!not-a-base64-signature!!!";

    const result = twilioVerifyWithBody(authToken, url, body, bodyHash, malformed);

    assert.equal(result.bodyOk, true, "body sha256 must still match");
    assert.equal(result.signatureOk, false, "signature must be rejected when malformed");
    assert.equal(result.bodyOk && result.signatureOk, false, "overall acceptance must be false");
  });

  // 3. Modified signature bytes. One byte of an otherwise valid signature
  //    must fail signature validation.
  it("rejects a signature with a single byte modified", () => {
    const body = '{"msg":"hello"}';
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    const expectedSignature = signatureFor(params);
    // Self-generated fixture: the valid signature with one character flipped.
    const modified = flipChar(expectedSignature, 10, "B");

    const result = twilioVerifyWithBody(authToken, url, body, bodyHash, modified);

    assert.equal(result.bodyOk, true, "body sha256 must still match");
    assert.equal(result.signatureOk, false, "signature must be rejected when bytes are modified");
    assert.equal(result.bodyOk && result.signatureOk, false, "overall acceptance must be false");
  });

  // 4. Reordered form parameters must still verify. The Twilio algorithm
  //    sorts parameter names, so the order in which the client submits them
  //    must not change the expected signature.
  it("accepts a request whose form parameters are in a different order", () => {
    // Same parameter set as the fixture, but submitted in a different order.
    const reordered = {
      To: "+180****1212",
      CallSid: "CA1234567890ABCDE",
      Digits: "1234",
      From: "+123****3030",
      Caller: "+123****3030",
    };
    // Fixture signature: computed by the independent oracle over the same
    // parameter set (order does not matter to the algorithm).
    const expectedSignature = signatureFor(params);

    assert.equal(
      twilioVerifySignature(authToken, url, reordered, expectedSignature),
      true,
      "reordered form parameters must still verify",
    );
  });

  // 5. Extra unexpected form parameter must invalidate the original
  //    signature. Adding a parameter the provider never sends changes the
  //    signed string and thus the signature.
  it("rejects a request with an extra unexpected form parameter", () => {
    const extraParam = { ...params, ExtraField: "unexpected" };
    // Fixture signature: computed by the independent oracle over the original
    // (expected) parameter set.
    const expectedSignature = signatureFor(params);

    assert.equal(
      twilioVerifySignature(authToken, url, extraParam, expectedSignature),
      false,
      "extra unexpected form parameter must invalidate the original signature",
    );
  });

  // 6. Different public URL scheme, host, port or query string must
  //    invalidate the signature. The URL (including its query string) is part
  //    of the signed string, so any of these changes must fail.
  it("rejects a request whose public URL differs in scheme, host, port or query", () => {
    const expectedSignature = signatureFor(params);
    const cases: Array<[string, string]> = [
      ["scheme http", "http://mycompany.com/myapp"],
      ["different host", "https://evil.example.com/myapp"],
      ["different port", "https://mycompany.com:8443/myapp"],
      ["different query string", "https://mycompany.com/myapp?foo=bar"],
    ];
    for (const [label, badUrl] of cases) {
      assert.equal(
        twilioVerifySignature(authToken, badUrl, params, expectedSignature),
        false,
        `signature must be invalid for public URL ${label}`,
      );
    }
  });
});
