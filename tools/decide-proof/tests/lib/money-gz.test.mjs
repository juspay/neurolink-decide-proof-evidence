// Unit tests of lib/money.mjs (exact decimals) and lib/gz.mjs (reproducible gzip).
import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { gunzipIfGzip, gzipReproducible, isGzip } from "../../lib/gz.mjs";
import { formatUsd, MoneyError, parsePricePerMillion, parseUsd, tokenCost, UNITS_PER_USD } from "../../lib/money.mjs";

test("prices and caps are exact decimals", () => {
  const luna = parsePricePerMillion("0.10");
  assert.equal(tokenCost(11145418, luna), 1114541800000000000n);
  assert.equal(formatUsd(tokenCost(11145418, luna)), "1.1145418");
  assert.equal(formatUsd(tokenCost(965, parsePricePerMillion("0.042"))), "0.00004053");
  assert.equal(formatUsd(tokenCost(0, luna)), "0");
  assert.equal(formatUsd(UNITS_PER_USD), "1");
  assert.equal(parseUsd("0.05"), 5n * UNITS_PER_USD / 100n);
  assert.equal(formatUsd(parseUsd("12.340")), "12.34");
});

test("sums of many small costs do not drift", () => {
  const price = parsePricePerMillion("0.10");
  let total = 0n;
  for (let i = 0; i < 10000; i++) total += tokenCost(1, price);
  assert.equal(formatUsd(total), "0.001");
});

test("bad decimals and token counts are refused", () => {
  for (const bad of ["", "-1", "1e3", "0.1.2", "abc", "1,5"]) assert.throws(() => parsePricePerMillion(bad), MoneyError);
  assert.throws(() => parsePricePerMillion("0.0000000000001"), MoneyError);
  assert.throws(() => tokenCost(1.5, 1n), MoneyError);
  assert.throws(() => tokenCost(-1, 1n), MoneyError);
});

test("gzip output is the same bytes every time, with no timestamp", async () => {
  const data = Buffer.from('{"a":1}\n'.repeat(5000));
  const first = gzipReproducible(data);
  await new Promise((r) => setTimeout(r, 1100));
  const second = gzipReproducible(data);
  assert.ok(first.equals(second));
  assert.deepEqual([...first.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(first[9], 255);
  assert.ok(gunzipSync(first).equals(data));
  assert.ok(isGzip(first));
  assert.ok(gunzipIfGzip(first).equals(data));
  assert.ok(gunzipIfGzip(data).equals(data));
});
