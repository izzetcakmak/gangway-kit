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

test("toTxRequest: LI.FI transactionRequest -> ethers request (hex value/gasLimit, no gasPrice)", () => {
  const { toTxRequest } = Kit.utils;
  const r = toTxRequest({ to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0xabcd", value: "0x1c6bf52634000", gasLimit: "0x1050ef", chainId: 8453, gasPrice: "0x5f5e100", from: "0xdead" });
  assert.equal(r.to, "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
  assert.equal(r.value, 500000000000000n);
  assert.equal(r.gasLimit, 1069295n);
  assert.equal(r.chainId, 8453);
  assert.equal("gasPrice" in r, false);
  assert.equal("from" in r, false);
  assert.throws(() => toTxRequest(null));
  assert.throws(() => toTxRequest({ to: "0x1" }));
});

test("payShortlist: native first, USDC second, curated symbols in order, no duplicates", () => {
  const { payShortlist } = Kit.utils;
  const base = Kit.SOURCES.mainnet.find((c) => c.key === "base");
  const tokens = [
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
    { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", name: "ETH", decimals: 18 },
    { address: base.usdc, symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", name: "Coinbase BTC", decimals: 8 },
    { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", name: "Tether", decimals: 6 },
    { address: "0xdeadbeef00000000000000000000000000000000", symbol: "JUNK", name: "junk", decimals: 18 },
  ];
  const out = payShortlist(tokens, base);
  assert.deepEqual(out.map((t) => t.symbol), ["ETH", "USDC", "WETH", "USDT", "cbBTC"]);
  assert.equal(out[4].decimals, 8);
  // no LI.FI list at all: still native + USDC from the chain config
  assert.deepEqual(payShortlist(null, base).map((t) => t.symbol), ["ETH", "USDC"]);
});

test("parseUnits / formatUnits handle 18 and 8 decimals", () => {
  const { parseUnits, formatUnits } = Kit.utils;
  assert.equal(parseUnits("0.0005", 18), 500000000000000n);
  assert.equal(parseUnits("1.5", 8), 150000000n);
  assert.equal(formatUnits(500000000000000n, 18, 6), "0.0005");
  assert.equal(formatUnits(150000000n, 8), "1.50");
  assert.throws(() => parseUnits("1.123456789", 8), /8 decimals/);
});

test("pending(): swapped-but-not-burned and LI.FI routing transfers stay in flight", () => {
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", storage });
  b._save({ id: "s", status: "swapped", amount: "1250000" });
  b._save({ id: "r", status: "routing", router: "lifi" });
  b._save({ id: "f", status: "failed" });
  assert.deepEqual(b.pending().map((t) => t.id).sort(), ["r", "s"]);
  assert.equal(b.router, "auto");
  assert.equal(b.slippage, 0.005);
});

test("explainLifi turns LI.FI refusals into actionable messages", () => {
  const { explainLifi } = Kit.utils;
  const base = Kit.SOURCES.testnet.find((c) => c.key === "base-sepolia");
  assert.match(explainLifi("No available quotes for the requested transfer", base, "testnet"), /smaller amount .*0\.001–0\.002 ETH/);
  assert.match(explainLifi("No available quotes for the requested transfer", Kit.SOURCES.mainnet[0], "mainnet"), /10% price impact/);
  assert.match(explainLifi("Rate limit exceeded, retry in 2 hours", base, "testnet"), /rate limit/i);
  assert.match(explainLifi("Could not find token '0x79..' on chain '480'", base, "mainnet"), /does not list/);
  assert.match(explainLifi("/fromChain must be equal to one of the allowed values", base, "testnet"), /does not serve/);
  assert.match(explainLifi("something odd", base, "testnet"), /something odd/);
});

test("lifiFee / lifiIntegrator reach the LI.FI quote URL (mainnet-style 0.25%)", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: false, json: async () => ({ message: "stub" }) }; };
  try {
    const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", storage: { get: () => null, set() {} },
      lifiIntegrator: "anewone", lifiFee: 0.0025 });
    await b.lifiQuote({ fromChain: 8453, toChain: 8453, fromToken: Kit.NATIVE, toToken: Kit.SOURCES.mainnet[0].usdc, fromAmount: 10n ** 16n, fromAddress: null });
    const u = new URL(seen[0]);
    assert.equal(u.searchParams.get("integrator"), "anewone");
    assert.equal(u.searchParams.get("fee"), "0.0025");
    // no fee configured: the parameter is absent, not "0"
    const b0 = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "testnet", storage: { get: () => null, set() {} } });
    await b0.lifiQuote({ fromChain: 84532, toChain: 84532, fromToken: Kit.NATIVE, toToken: Kit.SOURCES.testnet[0].usdc, fromAmount: 10n ** 15n, fromAddress: null });
    assert.equal(new URL(seen[1]).searchParams.get("fee"), null);
    assert.equal(new URL(seen[1]).searchParams.get("integrator"), "arc-bridge-kit");
  } finally { globalThis.fetch = realFetch; }
  assert.throws(() => new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, lifiFee: 1.5 }), /fraction/);
});
