// Unit tests of facts-util.mjs and the small rules of facts-core.mjs: half-up rounding in integer arithmetic, exact decimals,
// UTC parsing without a clock, display formats, canonical JSON, the error-group table, nearest-rank percentiles, the line reader.
// Run: node --test tests/facts-node/format.test.mjs
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import { errorGroup, nearestRank, readLines } from "../../facts/facts-core.mjs";
import {
  FactsError, canonicalJson, costDecimal, decimalFromNumber, decimalString, displayFor, fmtDateDmy, fmtInt, fmtMs1, fmtPct, fmtS0, fmtUsd, fmtUtcHm,
  parseDecimal, parseIsoUs, ratioUnits,
} from "../../facts/facts-util.mjs";
import { cleanup, WORK, freshDir } from "./fixture.mjs";

const dirs = [];
after(() => cleanup(dirs));

describe("half-up rounding (the blog's controls)", () => {
  test("12.5 -> 13 and 37.5 -> 38, never banker's or float rounding", () => {
    assert.equal(fmtPct(25n, 200n, 0), "13%");
    assert.equal(fmtPct(75n, 200n, 0), "38%");
    assert.equal(fmtPct(125n, 1000n, 0), "13%");
    assert.equal(fmtPct(2n, 8n, 0), "25%");
    assert.equal(fmtPct(5n, 8n, 0), "63%");
  });
  test("991/2787 -> 35.6% and 5042/5500 -> 92%", () => {
    assert.equal(fmtPct(991n, 2787n, 1), "35.6%");
    assert.equal(fmtPct(5042n, 5500n, 0), "92%");
  });
  test("the blog's exact percents", () => {
    assert.equal(fmtPct(2899n, 3080n, 2), "94.12%");
    assert.equal(fmtPct(3472n, 5500n, 2), "63.13%");
    assert.equal(fmtPct(951n, 971n, 2), "97.94%");
    assert.equal(fmtPct(1000n, 5500n, 1), "18.2%");
    assert.equal(fmtPct(1n, 8n, 1), "12.5%");
    assert.equal(fmtPct(1n, 8n, 2), "12.50%");
  });
  test("the integer rule is the contract's formula, whole = (200*num + den) // (2*den)", () => {
    for (const [num, den] of [[1n, 3n], [2n, 3n], [7n, 16n], [999n, 1000n], [0n, 5n], [5n, 5n]]) {
      assert.equal(ratioUnits(num, den, 0), (200n * num + den) / (2n * den));
      assert.equal(ratioUnits(num, den, 1), (2000n * num + den) / (2n * den));
    }
  });
  test("zero and full, and an empty denominator is n/a rather than a number", () => {
    assert.equal(fmtPct(0n, 5n, 1), "0.0%");
    assert.equal(fmtPct(5n, 5n, 1), "100.0%");
    assert.equal(fmtPct(0n, 0n, 0), "n/a");
  });
  test("int groups thousands with commas and handles zero and negatives", () => {
    assert.equal(fmtInt(0), "0");
    assert.equal(fmtInt(999), "999");
    assert.equal(fmtInt(1000), "1,000");
    assert.equal(fmtInt(1234567n), "1,234,567");
    assert.equal(fmtInt(-1234), "-1,234");
  });
});

describe("exact decimals and money", () => {
  test("a binary float never decides a tie: 0.115 and 0.125 round half up at two places", () => {
    assert.equal(fmtUsd("0.125", 2), "$0.13");
    assert.equal(fmtUsd("0.115", 2), "$0.12");
    assert.equal(fmtUsd("0.005", 2), "$0.01");
    assert.equal(fmtUsd("0.0049", 2), "$0.00");
    assert.equal(fmtUsd("1234.5", 2), "$1,234.50");
    assert.equal(fmtUsd("0.0000225", 6), "$0.000023");
  });
  test("a JS number becomes the decimal it prints as, exponents expanded", () => {
    assert.equal(decimalString(decimalFromNumber(1e-7)), "0.0000001");
    assert.equal(decimalString(decimalFromNumber(0.0000123)), "0.0000123");
    assert.equal(decimalString(decimalFromNumber(1.5e21)), "1500000000000000000000");
    assert.equal(decimalString(decimalFromNumber(0)), "0");
    assert.equal(decimalString(decimalFromNumber(0.1)), "0.1");
    assert.throws(() => decimalFromNumber(-1), FactsError);
    assert.throws(() => decimalFromNumber(Number.NaN), FactsError);
  });
  test("cost is tokens x price per million without rounding", () => {
    assert.equal(decimalString(costDecimal(4500, 81, parseDecimal("0.10"), parseDecimal("0"))), "0.00045");
    assert.equal(decimalString(costDecimal(12000, 6, parseDecimal("1.5"), parseDecimal("4"))), "0.018024");
    assert.equal(decimalString(costDecimal(1, 0, parseDecimal("0.07"), parseDecimal("0"))), "0.00000007");
    assert.equal(decimalString(costDecimal(0, 0, parseDecimal("0.07"), parseDecimal("1"))), "0");
  });
  test("canonical spelling: no exponent, no trailing zeros", () => {
    assert.equal(decimalString({ n: 1500n, s: 3 }), "1.5");
    assert.equal(decimalString({ n: 100n, s: 0 }), "100");
    assert.equal(decimalString({ n: 5n, s: 4 }), "0.0005");
    assert.throws(() => parseDecimal("1e-3"), FactsError);
    assert.throws(() => parseDecimal("-1"), FactsError);
  });
});

describe("recorded times", () => {
  test("microseconds since the epoch match Date.UTC, fractions kept", () => {
    assert.equal(parseIsoUs("1970-01-01T00:00:00Z"), 0n);
    assert.equal(parseIsoUs("2026-10-17T10:02:03.123Z"), BigInt(Date.UTC(2026, 9, 17, 10, 2, 3, 123)) * 1000n);
    assert.equal(parseIsoUs("2024-02-29T23:59:59.999999Z"), BigInt(Date.UTC(2024, 1, 29, 23, 59, 59, 999)) * 1000n + 999n);
    assert.equal(parseIsoUs("2026-10-17T10:02:04Z") - parseIsoUs("2026-10-17T10:02:03.5Z"), 500000n);
  });
  test("not a timestamp, not a date, not a time: refused", () => {
    for (const bad of ["2026-10-17 10:02:03Z", "2026-10-17T10:02:03+00:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-17T24:00:00Z", "", "x"]) {
      assert.throws(() => parseIsoUs(bad), FactsError, bad);
    }
  });
  test("display formats", () => {
    assert.equal(fmtUtcHm("2026-10-17T10:02:59.999Z"), "10:02 UTC");
    assert.equal(fmtUtcHm("2026-10-17T09:05:00Z"), "09:05 UTC");
    assert.equal(fmtDateDmy("2026-10-17T10:02:03Z"), "17 Oct 2026");
    assert.equal(fmtDateDmy("2026-01-05T00:00:00Z"), "5 Jan 2026");
    assert.equal(fmtMs1(388012n), "388.0 ms");
    assert.equal(fmtMs1(1234567n), "1234.6 ms");
    assert.equal(fmtMs1(50n), "0.1 ms");
    assert.equal(fmtMs1(49n), "0.0 ms");
    assert.equal(fmtS0(2500000n), "3 s");
    assert.equal(fmtS0(1499999n), "1 s");
    assert.equal(fmtS0(110900000n), "111 s");
  });
  test("every unit gets exactly its formats", () => {
    assert.deepEqual(Object.keys(displayFor("count", 5)), ["int"]);
    assert.deepEqual(Object.keys(displayFor("ratio", { num: 1n, den: 3n })), ["pct0", "pct1", "pct2"]);
    assert.deepEqual(Object.keys(displayFor("usd", "0.5")), ["usd2", "usd4", "usd6"]);
    assert.deepEqual(Object.keys(displayFor("neurons", "19854.08")), ["neurons0", "neurons2"]);
    assert.deepEqual(Object.keys(displayFor("us", 5n)), ["ms1", "s0"]);
    assert.deepEqual(Object.keys(displayFor("utc", "2026-10-17T10:02:03Z")), ["utc_hm", "date_dmy"]);
    assert.deepEqual(displayFor("text", "x"), { text: "x" });
    assert.throws(() => displayFor("text", 5), FactsError);
    assert.throws(() => displayFor("furlongs", 1), FactsError);
  });
});

describe("canonical JSON", () => {
  test("sorted keys, 2 spaces, LF, final LF, BigInt as integers, empty containers", () => {
    assert.equal(canonicalJson({ b: 1n, a: [1, { d: null, c: true }], e: {}, f: [] }), '{\n  "a": [\n    1,\n    {\n      "c": true,\n      "d": null\n    }\n  ],\n  "b": 1,\n  "e": {},\n  "f": []\n}\n');
  });
  test("a float, NaN or an undefined type is refused, undefined properties are dropped", () => {
    assert.throws(() => canonicalJson({ x: 0.5 }), FactsError);
    assert.throws(() => canonicalJson({ x: Number.NaN }), FactsError);
    assert.throws(() => canonicalJson({ x: () => 1 }), FactsError);
    assert.equal(canonicalJson({ x: undefined, y: 1 }), '{\n  "y": 1\n}\n');
  });
  test("integer-looking keys sort as strings, the same way as the Python side", () => {
    assert.equal(canonicalJson({ 200: 1, 1000: 2, 503: 3 }), '{\n  "1000": 2,\n  "200": 1,\n  "503": 3\n}\n');
  });
});

describe("rules", () => {
  test("error group of a failed final line, first match wins (4a item 7)", () => {
    const err = (error, exception) => errorGroup({ status: "error", error, exception });
    assert.equal(errorGroup({ status: "abstained", error: "Server error '502" }), "abstained");
    assert.equal(errorGroup({ status: "unsupported", error: "Type mismatch" }), "unsupported");
    assert.equal(err("Incomplete/invalid probability distribution: sum is 0.99"), "probability_distribution_check");
    assert.equal(err("Question keys mismatch"), "question_keys_mismatch");
    assert.equal(err("Type mismatch: x"), "answer_type_mismatch");
    assert.equal(err("Invalid chosen answer option_9"), "chosen_answer_not_an_option");
    assert.equal(err("Invalid noul probability 0.4"), "noul_probability_check");
    assert.equal(err("Client error '429 Too Many Requests' for url"), "http_4xx");
    assert.equal(err("Server error '502 Bad Gateway' for url"), "http_5xx");
    assert.equal(err("Client error '499 x'"), "http_4xx");
    assert.equal(err("Server error '599 x'"), "http_5xx");
    assert.equal(err("something", "ConnectError"), "network");
    assert.equal(err("something", "ReadTimeout"), "network");
    assert.equal(err("something", "RemoteProtocolError"), "network");
    assert.equal(err("something", "NetworkError"), "network");
    assert.equal(err("something", "TimeoutException"), "network");
    assert.equal(err("something", "SomeNewTimeout"), "network");
    assert.equal(err("Read timed out", "RuntimeError"), "other");
    assert.equal(err("All connection attempts failed", undefined), "other");
    assert.equal(err(undefined, undefined), "other");
    assert.equal(err("weird", "RuntimeError"), "other");
  });
  test("first match wins: an error text beats an HTTP code, an HTTP code beats the exception name", () => {
    assert.equal(errorGroup({ status: "error", error: "Type mismatch after Server error '502", exception: "ReadTimeout" }), "answer_type_mismatch");
    assert.equal(errorGroup({ status: "error", error: "Server error '502 Bad Gateway'", exception: "ReadTimeout" }), "http_5xx");
    assert.equal(errorGroup({ status: "error", error: "Invalid chosen answer, Invalid noul probability" }), "chosen_answer_not_an_option");
  });
  test("nearest rank: rank = ceil(n * p / 100), 1-based", () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(nearestRank(hundred, 50), 50);
    assert.equal(nearestRank(hundred, 90), 90);
    assert.equal(nearestRank(hundred, 99), 99);
    const ten = hundred.slice(0, 10);
    assert.equal(nearestRank(ten, 50), 5);
    assert.equal(nearestRank(ten, 90), 9);
    assert.equal(nearestRank(ten, 99), 10);
    assert.equal(nearestRank([7], 50), 7);
    assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9], 50), 5);
    assert.equal(nearestRank(Array.from({ length: 101 }, (_, i) => i + 1), 99), 100);
  });
});

describe("line reader", () => {
  test("a multi-byte character cut by a chunk boundary survives, plain and gzipped", async () => {
    const dir = freshDir("lines");
    dirs.push(dir);
    const line = `${"a".repeat(65535)}€tail`;
    const text = `first\n${line}\n\nlast-without-newline`;
    writeFileSync(join(dir, "t.txt"), text);
    writeFileSync(join(dir, "t.txt.gz"), gzipSync(Buffer.from(text)));
    for (const name of ["t.txt", "t.txt.gz"]) {
      const got = [];
      for await (const l of readLines(join(dir, name))) got.push(l);
      assert.deepEqual(got, ["first", line, "", "last-without-newline"], name);
    }
  });
  test("a file that is not gzip fails loudly", async () => {
    const dir = freshDir("lines");
    dirs.push(dir);
    writeFileSync(join(dir, "bad.gz"), "not gzip at all");
    await assert.rejects(async () => {
      for await (const _ of readLines(join(dir, "bad.gz"))) { /* drain */ }
    });
  });
});

test("the work folder is the test folder's own", () => {
  assert.ok(WORK.endsWith(join("tests", "facts-node", ".work")));
});
