// Unit tests of lib/mask.mjs: forms, header rules, longest secret first, secrets inside JSON strings, purity.
import assert from "node:assert/strict";
import test from "node:test";
import { BodyText, createMasker, headerToken, maskRecord, maskText, MaskError, secretForms, sha256, valueToken } from "../../lib/mask.mjs";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const masker = createMasker([
  { name: "TYPESAFE_API_KEY", value: KEY },
  { name: "CLOUDFLARE_ACCOUNT_ID", value: ACCOUNT },
]);

test("the plain value is masked wherever it appears", () => {
  const { text, masked } = maskText(`GET /accounts/${ACCOUNT}/ai?k=${KEY}&k2=${KEY}`, masker);
  assert.equal(text, `GET /accounts/${valueToken("CLOUDFLARE_ACCOUNT_ID")}/ai?k=${valueToken("TYPESAFE_API_KEY")}&k2=${valueToken("TYPESAFE_API_KEY")}`);
  assert.deepEqual(masked, ["CLOUDFLARE_ACCOUNT_ID", "TYPESAFE_API_KEY"]);
});

test("URL-encoded, base64 and JSON-escaped forms are masked", () => {
  const value = 'Ab/cd+ef gh%12:xyz"q\\z';
  const m = createMasker([{ name: "ODD_SECRET", value }]);
  const forms = secretForms(value);
  assert.ok(forms.includes(value));
  assert.ok(forms.includes(encodeURIComponent(value)), "encodeURIComponent form");
  assert.ok(forms.includes(Buffer.from(value).toString("base64")), "base64 form");
  assert.ok(forms.includes(JSON.stringify(value).slice(1, -1)), "JSON-escaped form");
  for (const form of forms) {
    const { text, masked } = maskText(`before ${form} after`, m);
    assert.equal(text, `before ${valueToken("ODD_SECRET")} after`, `form ${form.length} chars`);
    assert.deepEqual(masked, ["ODD_SECRET"]);
  }
});

test("base64 inside a longer base64 text is masked at every byte alignment", () => {
  const secret = "s3cr3t-Value-ABCDEFGH";
  const m = createMasker([{ name: "EMBEDDED", value: secret }]);
  for (const prefix of ["", "a", "ab", "abc", "user:", "user:x"]) {
    for (const suffix of ["", "z", "zz", "zzz"]) {
      const text = Buffer.from(prefix + secret + suffix).toString("base64");
      const { masked } = maskText(text, m);
      assert.deepEqual(masked, ["EMBEDDED"], `prefix ${JSON.stringify(prefix)} suffix ${JSON.stringify(suffix)}`);
    }
  }
});

test("a secret that was escaped twice by a server echoing a JSON body is masked", () => {
  const value = 'pa"ss\\word-12345678';
  const m = createMasker([{ name: "TWICE", value }]);
  const once = JSON.stringify({ k: value });
  const twice = JSON.stringify({ echo: once });
  const { record, masked } = maskRecord({ response: { body: new BodyText(twice) } }, m);
  assert.deepEqual(masked, ["TWICE"]);
  assert.ok(!JSON.stringify(record).includes("12345678"));
});

test("the longest secret wins where secrets overlap", () => {
  const short = "abcdefgh-0123456789";
  const long = "abcdefgh-0123456789-extra";
  const m = createMasker([
    { name: "SHORT", value: short },
    { name: "LONG", value: long },
  ]);
  assert.deepEqual(maskText(`x ${long} y`, m), { text: `x ${valueToken("LONG")} y`, masked: ["LONG"] });
  assert.deepEqual(maskText(`x ${short} y`, m), { text: `x ${valueToken("SHORT")} y`, masked: ["SHORT"] });
  const both = maskText(`${short} and ${long}`, m);
  assert.equal(both.text, `${valueToken("SHORT")} and ${valueToken("LONG")}`);
  // a key that contains the account id is masked as the key, with nothing of the id left over
  const m2 = createMasker([
    { name: "ACCOUNT", value: ACCOUNT },
    { name: "COMBINED", value: `key-${ACCOUNT}` },
  ]);
  assert.equal(maskText(`/k/key-${ACCOUNT}/z`, m2).text, `/k/${valueToken("COMBINED")}/z`);
  assert.equal(maskText(`/a/${ACCOUNT}/z`, m2).text, `/a/${valueToken("ACCOUNT")}/z`);
});

test("a secret inside a JSON string body is masked, and the body stays parseable", () => {
  const value = 'pa"ss\\word-12345678';
  const m = createMasker([{ name: "BODY_SECRET", value }]);
  const text = JSON.stringify({ note: `my secret is ${value} ok`, nested: { list: [value, 1] } });
  const { record, masked } = maskRecord({ request: { body: new BodyText(text) } }, m);
  assert.deepEqual(masked, ["BODY_SECRET"]);
  assert.deepEqual(record.request.body, { note: `my secret is ${valueToken("BODY_SECRET")} ok`, nested: { list: [valueToken("BODY_SECRET"), 1] } });
  assert.ok(!JSON.stringify(record).includes("12345678"));
});

test("sensitive headers are masked as a whole unless a variable already matched", () => {
  const { record, masked, headerMasked } = maskRecord(
    {
      request: {
        headers: {
          Authorization: `Bearer ${KEY}`,
          "x-api-key": "some-other-secret",
          "api-key": "k2",
          cookie: "a=b; c=d",
          "x-auth-token": "tok",
          "proxy-authorization": "Basic dXNlcjpwYXNz",
          "content-type": "application/json",
          "x-note": `key ${KEY}`,
        },
      },
      response: { headers: { "set-cookie": ["a=1", `b=${KEY}`], authorization: "bearer lower-case-token", "x-empty": "" } },
    },
    masker,
  );
  assert.equal(record.request.headers.Authorization, `Bearer ${valueToken("TYPESAFE_API_KEY")}`);
  assert.equal(record.request.headers["x-api-key"], headerToken("x-api-key"));
  assert.equal(record.request.headers["api-key"], headerToken("api-key"));
  assert.equal(record.request.headers.cookie, headerToken("cookie"));
  assert.equal(record.request.headers["x-auth-token"], headerToken("x-auth-token"));
  assert.equal(record.request.headers["proxy-authorization"], `Basic ${headerToken("proxy-authorization")}`);
  assert.equal(record.request.headers["content-type"], "application/json");
  assert.equal(record.request.headers["x-note"], `key ${valueToken("TYPESAFE_API_KEY")}`);
  assert.deepEqual(record.response.headers["set-cookie"], [headerToken("set-cookie"), `b=${valueToken("TYPESAFE_API_KEY")}`]);
  assert.equal(record.response.headers.authorization, `bearer ${headerToken("authorization")}`);
  assert.equal(record.response.headers["x-empty"], "");
  assert.deepEqual(masked, ["TYPESAFE_API_KEY"]);
  assert.deepEqual(headerMasked, ["api-key", "authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key", "x-auth-token"]);
});

test("a body is parsed after masking and hashed as the masked text", () => {
  const compact = JSON.stringify({ a: 1, k: KEY });
  const r1 = maskRecord({ body: new BodyText(compact) }, masker).record;
  const maskedText = compact.replace(KEY, valueToken("TYPESAFE_API_KEY"));
  assert.deepEqual(r1.body, { a: 1, k: valueToken("TYPESAFE_API_KEY") });
  assert.equal(r1.body_sha256, sha256(maskedText));
  assert.equal(r1.body_sha256, sha256(JSON.stringify(r1.body)));
  assert.equal(r1.body_bytes, Buffer.byteLength(compact));
  assert.ok(!("body_raw" in r1), "a compact body needs no body_raw");

  const pretty = `{ "a": 1.0,\n  "k": "${KEY}" }`;
  const r2 = maskRecord({ body: new BodyText(pretty) }, masker).record;
  assert.equal(r2.body.a, 1);
  assert.equal(r2.body_raw, pretty.replace(KEY, valueToken("TYPESAFE_API_KEY")));
  assert.equal(sha256(r2.body_raw), r2.body_sha256);

  const r3 = maskRecord({ body: new BodyText(`<html>${KEY}</html>`) }, masker).record;
  assert.deepEqual(r3.body, { _text: `<html>${valueToken("TYPESAFE_API_KEY")}</html>` });
  assert.equal(sha256(r3.body._text), r3.body_sha256);

  const r4 = maskRecord({ body: new BodyText("") }, masker).record;
  assert.deepEqual(r4.body, { _text: "" });
  assert.equal(r4.body_sha256, sha256(""));
});

test("URLs, error messages and keys are masked too", () => {
  const { record, masked } = maskRecord({ url: `https://api.example/accounts/${ACCOUNT}/run`, error: { message: `failed for ${KEY}`, cause: { message: encodeURIComponent(KEY) } }, [`k-${KEY}`]: 1 }, masker);
  assert.equal(record.url, `https://api.example/accounts/${valueToken("CLOUDFLARE_ACCOUNT_ID")}/run`);
  assert.equal(record.error.message, `failed for ${valueToken("TYPESAFE_API_KEY")}`);
  assert.equal(record.error.cause.message, valueToken("TYPESAFE_API_KEY"));
  assert.deepEqual(Object.keys(record).filter((k) => k.startsWith("k-")), [`k-${valueToken("TYPESAFE_API_KEY")}`]);
  assert.deepEqual(masked, ["CLOUDFLARE_ACCOUNT_ID", "TYPESAFE_API_KEY"]);
});

test("the input record is not changed and masking twice gives the same record", () => {
  const input = { request: { headers: { "content-type": "x" }, nested: [{ v: KEY }] }, n: 3, t: true, z: null };
  const frozen = JSON.parse(JSON.stringify(input));
  const deepFreeze = (o) => {
    if (o && typeof o === "object") Object.values(o).forEach(deepFreeze);
    return Object.freeze(o);
  };
  deepFreeze(input);
  const once = maskRecord(input, masker);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), frozen);
  const twice = maskRecord(once.record, masker);
  assert.deepEqual(twice.record, once.record);
  assert.deepEqual(twice.masked, []);
});

test("a value that only looks masked is not trusted in a sensitive header", () => {
  const { record } = maskRecord({ headers: { authorization: `Bearer real-token «masked:TYPESAFE_API_KEY»` } }, masker);
  assert.equal(record.headers.authorization, `Bearer ${headerToken("authorization")}`);
});

test("every form of every secret is gone from a record that holds them all", () => {
  const secrets = [
    { name: "A_KEY", value: "Zk9/+abc DEF=ghij\"k" },
    { name: "B_TOKEN", value: "tok-0123456789-ABCDEF" },
  ];
  const m = createMasker(secrets);
  const forms = secrets.flatMap((s) => secretForms(s.value));
  const record = {
    url: `https://h/${forms.join("/")}`,
    request: { headers: { "x-extra": forms.join(" ") }, body: new BodyText(JSON.stringify({ list: forms })) },
    error: { message: forms.join(" | ") },
  };
  const out = JSON.stringify(maskRecord(record, m).record);
  for (const form of forms) assert.ok(!out.includes(form), `form of ${form.length} chars left in the record`);
});

test("a secret that is too short is refused by name, without its value", () => {
  assert.throws(
    () => createMasker([{ name: "TINY", value: "abc" }]),
    (e) => e instanceof MaskError && e.message.includes("TINY") && !e.message.includes("abc"),
  );
  assert.throws(() => createMasker([{ name: "bad name", value: KEY }]), MaskError);
});

test("a URL secret also masks its host", () => {
  const m = createMasker([{ name: "XOR_BASE_URL", value: "https://xor.internal.example:8443/base" }]);
  const { text } = maskText("POST https://xor.internal.example:8443/v1/systemone; host xor.internal.example", m);
  assert.ok(!text.includes("xor.internal.example"));
  assert.ok(text.includes(valueToken("XOR_BASE_URL")));
});

test("alternative spellings of a value (alts) are masked under the same name", () => {
  const m = createMasker([{ name: "WITH_ALT", value: "abcd1234efgh", alts: ['"abcd1234efgh" # note'] }]);
  assert.deepEqual(maskText('x "abcd1234efgh" # note y', m).masked, ["WITH_ALT"]);
});

test("with no secrets only the header rule applies", () => {
  const m = createMasker([]);
  const { record, masked } = maskRecord({ a: "plain", headers: { authorization: "Bearer x" } }, m);
  assert.equal(record.a, "plain");
  assert.equal(record.headers.authorization, `Bearer ${headerToken("authorization")}`);
  assert.deepEqual(masked, []);
});

test("an IPv4 address that is not loopback is masked in any text, with or without a secret list; versions and loopback stay", async () => {
  const { maskIpv4, countIpv4, IPV4_NAME } = await import("../../lib/mask.mjs");
  const used = new Set();
  assert.equal(maskIpv4("http://10.20.30.40:38006/v1/systemone", used), `http://${valueToken(IPV4_NAME)}/v1/systemone`);
  assert.deepEqual([...used], [IPV4_NAME]);
  assert.equal(createMasker([]).mask("Your IP address: 13.1.2.3</li>"), `Your IP address: ${valueToken(IPV4_NAME)}</li>`);
  for (const keep of ["127.0.0.1:4411", "0.0.0.0", "via 1.1 google", "v1.2.3", "1.2.3.4.5", "999.1.1.1", "2026-10-17"]) {
    assert.equal(maskIpv4(keep), keep, keep);
    assert.equal(countIpv4(keep), 0, keep);
  }
  const { record, masked } = maskRecord({ response: { headers: { "x-gw-api-base": "http://10.0.0.9:80/x" }, body: new BodyText('{"e":"from 10.0.0.9"}') } }, masker);
  assert.equal(JSON.stringify(record).includes("10.0.0.9"), false);
  assert.deepEqual(masked, [IPV4_NAME]);
});

test("remask: an old record gets the IPv4 rule, a body its new sha256, and the masked list the name", async () => {
  const { remaskLines } = await import("../../bin/remask.mjs");
  const body = '<li>Your IP address: 13.1.2.3</li>';
  const line = JSON.stringify({ seq: 1, response: { status: 522, body: { _text: body }, body_sha256: sha256(body), body_bytes: body.length }, error: { message: "attempted addresses: 104.18.2.1:443" }, masked: ["TYPESAFE_API_KEY"] });
  const clean = JSON.stringify({ seq: 2, response: { status: 200, body: { ok: 1 } }, masked: [] });
  const { text, changed, ips } = remaskLines(`${line}\n${clean}\n`);
  assert.deepEqual([changed, ips], [1, 2]);
  const [a, b] = text.split("\n").map((l) => (l ? JSON.parse(l) : null));
  assert.equal(a.response.body._text, `<li>Your IP address: ${valueToken("IPV4_ADDRESS")}</li>`);
  assert.equal(a.response.body_sha256, sha256(a.response.body._text));
  assert.equal(a.response.body_bytes, body.length);
  assert.equal(a.error.message, `attempted addresses: ${valueToken("IPV4_ADDRESS")}`);
  assert.deepEqual(a.masked, ["IPV4_ADDRESS", "TYPESAFE_API_KEY"]);
  assert.equal(JSON.stringify(b), clean);
});
