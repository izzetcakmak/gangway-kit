// node --test test/unit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Kit = require("../arc-bridge-kit.js");
const { parseUsdc, formatUsdc, toBytes32Address, computeFees, isAddress } = Kit.utils;

test("constants match Circle's published CCTP V2 values", () => {
  assert.equal(Kit.ARC_DOMAIN, 26);
  // bytes32("cctp-forward")
  assert.equal(Kit.FORWARD_HOOK, "0x" + Buffer.from("cctp-forward").toString("hex").padEnd(64, "0"));
  assert.equal(Kit.CCTP.mainnet.tokenMessenger, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
  assert.equal(Kit.CCTP.mainnet.messageTransmitter, "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
  assert.equal(Kit.CCTP.testnet.tokenMessenger, "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
  assert.equal(Kit.CCTP.testnet.messageTransmitter, "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");
  assert.equal(Kit.ARC.mainnet.chainId, 5042);
  assert.equal(Kit.ARC.testnet.chainId, 5042002);
  assert.equal(Kit.FINALITY.fast, 1000);
  assert.equal(Kit.FINALITY.standard, 2000);
});

test("source chain tables are internally consistent", () => {
  for (const net of ["mainnet", "testnet"]) {
    const seenKey = new Set(), seenId = new Set(), seenDomain = new Set();
    for (const c of Kit.SOURCES[net]) {
      assert.ok(!seenKey.has(c.key), `dup key ${c.key}`); seenKey.add(c.key);
      assert.ok(!seenId.has(c.chainId), `dup chainId ${c.chainId}`); seenId.add(c.chainId);
      assert.ok(!seenDomain.has(c.domain), `dup domain ${c.domain}`); seenDomain.add(c.domain);
      assert.ok(isAddress(c.usdc), `${c.key} usdc`);
      assert.ok(c.rpcs.length >= 1, `${c.key} needs a read RPC`);
      assert.ok(c.explorer.startsWith("https://"), `${c.key} explorer`);
      assert.notEqual(c.domain, 26, "a source can never be Arc itself");
      assert.equal(typeof c.fast, "boolean");
    }
  }
});

test("parseUsdc / formatUsdc round-trip", () => {
  assert.equal(parseUsdc("10"), 10_000_000n);
  assert.equal(parseUsdc("10.5"), 10_500_000n);
  assert.equal(parseUsdc(" 0.000001 "), 1n);
  assert.equal(parseUsdc("1,25"), 1_250_000n);
  assert.equal(parseUsdc(".5"), 500_000n);
  assert.throws(() => parseUsdc("abc"));
  assert.throws(() => parseUsdc("1.2345678"), /6 decimals/);
  assert.throws(() => parseUsdc(""));
  assert.equal(formatUsdc(10_000_000n), "10.00");
  assert.equal(formatUsdc(10_500_000n), "10.50");
  assert.equal(formatUsdc(1n), "0.000001");
  assert.equal(formatUsdc(19_125n, 4), "0.0191");
  assert.equal(formatUsdc("2500000"), "2.50");
});

test("toBytes32Address is strict", () => {
  assert.equal(
    toBytes32Address("0xD4F1254C0d2b7C1A5c1C4b5b3c3B1b1b1B1b1B1b"),
    "0x000000000000000000000000d4f1254c0d2b7c1a5c1c4b5b3c3b1b1b1b1b1b1b"
  );
  assert.throws(() => toBytes32Address("0x1234"));
  assert.throws(() => toBytes32Address("D4F1254C0d2b7C1A5c1C4b5b3c3B1b1b1B1b1B1b"));
  assert.throws(() => toBytes32Address(""));
});

// Real Iris response shape for mainnet 6 -> 26 (captured 13 Sep 2026)
const FEES = [
  { finalityThreshold: 1000, minimumFee: 0.325, forwardFee: { low: 18663, med: 19488, high: 20313 } },
  { finalityThreshold: 2000, minimumFee: 0,     forwardFee: { low: 18663, med: 19488, high: 20313 } },
];

test("computeFees: fast tier uses bps protocol fee + high forward fee, 2x headroom", () => {
  const q = computeFees(FEES, 10_000_000n, "fast");
  assert.equal(q.minFinalityThreshold, 1000);
  assert.equal(q.protocolFee, 325n);           // ceil(10e6 * 0.325 / 10000)
  assert.equal(q.forwardFee, 20313n);
  assert.equal(q.expectedFee, 20638n);
  assert.equal(q.maxFee, 41276n);
  assert.equal(q.expectedReceive, 9_979_362n);
  assert.equal(q.minReceive, 9_958_724n);
});

test("computeFees: standard tier has no protocol fee", () => {
  const q = computeFees(FEES, 10_000_000n, "standard");
  assert.equal(q.minFinalityThreshold, 2000);
  assert.equal(q.protocolFee, 0n);
  assert.equal(q.expectedFee, 20313n);
});

test("computeFees: null when the route is not forwarded or the response is junk", () => {
  assert.equal(computeFees(null, 1n), null);
  assert.equal(computeFees([], 1n), null);
  assert.equal(computeFees([{ finalityThreshold: 1000, minimumFee: 0 }], 1n), null);
  assert.equal(computeFees([{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { high: 0 } }], 1n), null);
});

test("computeFees: tiny amounts cannot go negative", () => {
  const q = computeFees(FEES, 1000n, "fast");
  assert.equal(q.expectedReceive, 0n);
  assert.equal(q.minReceive, 0n);
  assert.ok(q.maxFee > 1000n, "the engine must refuse this amount (maxFee >= amount)");
});

test("ArcBridge constructs headless with a fake ethers and filters sources", () => {
  const fakeEthers = { getAddress: (a) => a };
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  const b = new Kit.ArcBridge({ ethers: fakeEthers, network: "mainnet", sources: ["base", "arbitrum"], storage, arcRpcs: ["https://example.invalid"] });
  assert.deepEqual(b.sources().map((s) => s.key), ["base", "arbitrum"]);
  assert.equal(b.source(8453).key, "base");
  assert.equal(b.source("nope"), null);
  assert.equal(b.arc.rpcs[0], "https://example.invalid");
  assert.equal(b.explorerTx(b.source("base"), "0xabc"), "https://basescan.org/tx/0xabc");
  // persistence
  b._save({ id: "0x1", status: "burned" });
  b._save({ id: "0x2", status: "minted" });
  assert.equal(b.transfers().length, 2);
  assert.deepEqual(b.pending().map((t) => t.id), ["0x1"]);
  b.dismiss("0x1");
  assert.equal(b.pending().length, 0);
  assert.throws(() => new Kit.ArcBridge({}), /ethers/);
});

test("pending(): a minted transfer stays in flight until its destination leg is done", () => {
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "testnet", storage });
  b._save({ id: "a", status: "minted" });                              // plain bridge: done
  b._save({ id: "b", status: "minted", dest: { status: "pending" } }); // buy not yet sent
  b._save({ id: "c", status: "minted", dest: { status: "failed" } });  // buy reverted: retryable
  b._save({ id: "d", status: "minted", dest: { status: "done" } });    // buy mined
  b._save({ id: "e", status: "attesting", dest: { status: "pending" } });
  assert.deepEqual(b.pending().map((t) => t.id).sort(), ["b", "c", "e"]);
  assert.equal(b.receivedOf({ received: "980000" }), 980000n);
  assert.equal(b.receivedOf({ amount: "1000000", expectedFee: "20000" }), 980000n);
});

test("runDestination refuses a transfer that has not landed", async () => {
  const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "testnet", storage: { get: () => null, set() {} } });
  await assert.rejects(() => b.runDestination({ status: "attesting" }, { build: async () => ({}) }), /not landed/);
  await assert.rejects(() => b.runDestination({ status: "minted" }, {}), /build missing/);
});
