// node --test test/unit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Kit = require("../gangway-kit.js");
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
      if (c.vm === "svm") assert.ok(Kit.utils.isSolAddress(c.usdc), `${c.key} usdc mint`);
      else assert.ok(isAddress(c.usdc), `${c.key} usdc`);
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
    assert.equal(new URL(seen[1]).searchParams.get("integrator"), "gangway-kit");
  } finally { globalThis.fetch = realFetch; }
  assert.throws(() => new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, lifiFee: 1.5 }), /fraction/);
});

test("nonceFromMessage reads bytes 12..44 of a CCTP V2 header", () => {
  const { nonceFromMessage } = Kit.utils;
  const nonce = "e2018fc7769f7366457350bca0e515c614733b25782f2276ad0c64aea628d58e";
  const header = "00000001" + "00000006" + "0000001a" + nonce + "00".repeat(32 * 3 + 8) + "00".repeat(20);
  assert.equal(nonceFromMessage("0x" + header), "0x" + nonce);
  assert.equal(nonceFromMessage("0x1234"), null);
  assert.equal(nonceFromMessage(null), null);
});

test("judgeMint: on-chain nonce beats everything, RPC silence is unknown, not pending", () => {
  const { judgeMint } = Kit.utils;
  assert.equal(judgeMint({ nonceUsed: 1n }), "minted");
  assert.equal(judgeMint({ nonceUsed: 0n, irisForward: { state: "PENDING" } }), "pending");
  // Iris says COMPLETE (its real casing) even if the balance baseline is useless
  assert.equal(judgeMint({ nonceUsed: null, irisForward: { state: "COMPLETE", txHash: "0xabc" } }), "minted");
  assert.equal(judgeMint({ nonceUsed: null, irisForward: { state: "complete" } }), "minted");
  // a destination tx hash alone is proof
  assert.equal(judgeMint({ nonceUsed: null, irisForward: { state: null, txHash: "0xabc" } }), "minted");
  // balance delta counts only when the baseline predates the attestation
  assert.equal(judgeMint({ nonceUsed: null, balance: { now: 200n, start: 100n, baselineBeforeAttest: true } }), "minted");
  assert.equal(judgeMint({ nonceUsed: null, balance: { now: 200n, start: 200n, baselineBeforeAttest: false } }), "pending");
  assert.equal(judgeMint({ nonceUsed: null, balance: { now: 300n, start: 300n, baselineBeforeAttest: false } }), "pending");
  // nothing readable this round: unknown (keep polling, never "late")
  assert.equal(judgeMint({ nonceUsed: null, irisForward: null, balance: { now: null, start: 100n } }), "unknown");
  assert.equal(judgeMint({}), "unknown");
});

test("LI.FI refusing the integrator fee does not kill the swap: retry without fee, remember, notify", async () => {
  const seen = []; let refusedMsg = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const u = new URL(String(url));
    if (u.searchParams.has("fee")) return { ok: false, json: async () => ({ message: 'Integrator "anewone" is not configured for collecting fees. Please sign up on https://portal.li.fi/ and configure your fee wallet.', code: 1011 }) };
    return { ok: true, json: async () => ({ tool: "x", type: "lifi", estimate: { toAmount: "100", toAmountMin: "99", approvalAddress: null, executionDuration: 1, gasCosts: [], feeCosts: [] }, transactionRequest: { to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0x00", value: "0x0" } }) };
  };
  try {
    const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", storage: { get: () => null, set() {} },
      lifiIntegrator: "anewone", lifiFee: 0.0025, onLifiFeeRefused: (m) => { refusedMsg = m; } });
    assert.equal(b.lifiFeeActive, true);
    const q = await b.lifiQuote({ fromChain: 8453, toChain: 8453, fromToken: Kit.NATIVE, toToken: Kit.SOURCES.mainnet[0].usdc, fromAmount: 10n ** 16n });
    assert.equal(q.available, true, "the swap quote must survive the refused fee");
    assert.equal(seen.length, 2);
    assert.equal(new URL(seen[0]).searchParams.get("fee"), "0.0025");
    assert.equal(new URL(seen[1]).searchParams.get("fee"), null);
    assert.match(refusedMsg, /not configured/);
    assert.equal(b.lifiFeeActive, false);
    // the next quote goes straight out without the fee (one call, no second refusal)
    await b.lifiQuote({ fromChain: 8453, toChain: 8453, fromToken: Kit.NATIVE, toToken: Kit.SOURCES.mainnet[0].usdc, fromAmount: 2n * 10n ** 16n });
    assert.equal(seen.length, 3);
    assert.equal(new URL(seen[2]).searchParams.get("fee"), null);
  } finally { globalThis.fetch = realFetch; }
});

test("chooseRoute: LI.FI must beat CCTP on both landing amount and time", () => {
  const { chooseRoute } = Kit.utils;
  const cctp = { available: true, expectedReceive: 19_930_000n, estSeconds: 20 };
  assert.equal(chooseRoute(cctp, { available: true, expectedReceive: 17_955_000n, estSeconds: 60 }), "cctp");   // launch night: 10% less
  assert.equal(chooseRoute(cctp, { available: true, expectedReceive: 19_990_000n, estSeconds: 1500 }), "cctp"); // more, but 25 min
  assert.equal(chooseRoute(cctp, { available: true, expectedReceive: 19_990_000n, estSeconds: 25 }), "lifi");   // more and as fast
  assert.equal(chooseRoute(cctp, { available: true, expectedReceive: 19_915_000n, estSeconds: 10 }), "lifi");   // within 0.1%, faster
  assert.equal(chooseRoute(cctp, { available: true, expectedReceive: 19_900_000n, estSeconds: 10 }), "cctp");   // 0.15% less: no
  assert.equal(chooseRoute(cctp, null), "cctp");
  assert.equal(chooseRoute(null, { available: true, expectedReceive: 1n, estSeconds: 999 }), "lifi");           // CCTP cannot serve: take what exists
  assert.equal(chooseRoute({ available: false }, { available: false }), "cctp");
});

// ---- Solana

test("Solana source: shape, helpers, base58", () => {
  const { isSolAddress, isSvm, base58Encode, b64ToBytes, bytesToB64, toSvmTx } = Kit.utils;
  const sol = Kit.SOURCES.mainnet.find((c) => c.key === "solana");
  assert.ok(sol, "solana is a mainnet source");
  assert.equal(isSvm(sol), true);
  assert.equal(sol.chainId, Kit.SOL_LIFI_CHAIN_ID);
  assert.equal(sol.domain, 5, "CCTP's Solana domain");
  assert.equal(sol.native.decimals, 9);
  assert.ok(isSolAddress(sol.usdc));
  assert.ok(isSolAddress(Kit.SOL_NATIVE));
  assert.equal(isSolAddress("0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9"), false);
  assert.equal(isSolAddress("0OIl"), false, "base58 has no 0, O, I, l");
  assert.equal(isSvm(Kit.SOURCES.mainnet[0]), false);
  // bs58's own README example, and leading zero bytes become leading 1s
  assert.equal(base58Encode(new TextEncoder().encode("hello")), "Cn8eVZg");
  assert.equal(base58Encode(Uint8Array.from([0, 0, 1])), "112");
  assert.equal(base58Encode(Uint8Array.from([0, 0])), "11");
  const bytes = Uint8Array.from([1, 2, 3, 250, 251]);
  assert.deepEqual([...b64ToBytes(bytesToB64(bytes))], [...bytes]);
  assert.deepEqual(toSvmTx({ data: "AQID" }), { data: "AQID" });
  assert.throws(() => toSvmTx({}));
  assert.throws(() => toSvmTx(null));
});

test("payShortlist on Solana: SOL first, USDC second, Solana's own symbol list, exact-case matching", () => {
  const { payShortlist } = Kit.utils;
  const sol = Kit.SOURCES.mainnet.find((c) => c.key === "solana");
  const tokens = [
    { address: Kit.SOL_NATIVE, symbol: "SOL", name: "SOL", decimals: 9 },
    { address: sol.usdc, symbol: "USDC", name: "USD Coin", decimals: 6 },
    { address: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", name: "Bonk", decimals: 5 },
    { address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", name: "Tether", decimals: 6 },
    { address: "4200000000000000000000000000000000000006zzzz", symbol: "WETH", name: "not on this list", decimals: 18 },
  ];
  const out = payShortlist(tokens, sol);
  // BONK and WIF are guaranteed by the kit's own known-mint list: LI.FI's entry wins when it
  // has one under the symbol (BONK here, listed once, not twice), the kit's fills in otherwise (WIF)
  assert.deepEqual(out.map((t) => t.symbol), ["SOL", "USDC", "USDT", "BONK", "WIF"]);
  assert.equal(out[3].decimals, 5);
  assert.equal(out[4].address, "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
  // WETH is on the EVM list only: an EVM chain still gets it, Solana never does
  assert.deepEqual(payShortlist(null, sol).map((t) => t.symbol), ["SOL", "USDC", "BONK", "WIF"]);
  assert.equal(payShortlist(null, sol)[0].address, Kit.SOL_NATIVE);
});

test("explainLifi never tells a Solana user to 'bridge over CCTP'", () => {
  const { explainLifi } = Kit.utils;
  const sol = Kit.SOURCES.mainnet.find((c) => c.key === "solana");
  for (const reason of ["No available quotes for the requested transfer", "Could not find token", "something else"]) {
    const m = explainLifi(reason, sol, "mainnet");
    assert.doesNotMatch(m, /CCTP/);
    assert.match(m, /Solana/);
  }
});

test("plan() on Solana is one LI.FI route even with router 'cctp', quoted for the connected account", async () => {
  const mem = new Map();
  const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", router: "cctp",
    storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) } });
  const sol = b.source("solana");
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: true, json: async () => ({ tool: "relaydepository", type: "lifi",
      estimate: { toAmount: "11327819", toAmountMin: "11271180", executionDuration: 1, gasCosts: [], feeCosts: [] },
      transactionRequest: { data: "AQID" } }) };
  };
  try {
    const p = await b.plan({ source: sol, payToken: Kit.SOL_NATIVE, fromAmount: 100_000_000n,
      fromAddress: "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy", recipient: "0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9" });
    assert.equal(p.available, true);
    assert.equal(p.router, "lifi");
    assert.equal(p.expectedReceive, 11_327_819n);
    assert.equal(p.minReceive, 11_271_180n);
    assert.deepEqual(p.lifi.tx, { data: "AQID" });
    assert.equal(seen.length, 1, "one LI.FI call, no Iris fee quote, no same-chain swap");
    const u = new URL(seen[0]);
    assert.equal(u.searchParams.get("fromChain"), String(Kit.SOL_LIFI_CHAIN_ID));
    assert.equal(u.searchParams.get("toChain"), "5042");
    assert.equal(u.searchParams.get("fromAddress"), "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy", "base58 sender passes through untouched");
    assert.equal(u.searchParams.get("toAddress"), "0xd4f1254c803662c46d9c21f80f4f3c15ff57e2c9");
    // no wallet yet: a placeholder pubkey is quoted for, a burn address receives, nothing is ever sent
    await b.plan({ source: sol, payToken: Kit.SOL_NATIVE, fromAmount: 100_000_000n });
    const u2 = new URL(seen[1]);
    assert.match(u2.searchParams.get("fromAddress"), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.equal(u2.searchParams.get("toAddress"), "0x000000000000000000000000000000000000dead");
  } finally { globalThis.fetch = realFetch; }
  // a Solana wallet is required to send; nothing was connected
  await assert.rejects(() => b.bridge({ source: sol, amount: 1n, recipient: "0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9" }), /Connect a Solana wallet/);
  assert.equal(b.solanaAccount(), null);
});

test("Solana balances: lamports for SOL, summed token accounts for a mint, null for a bad owner", async () => {
  const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", storage: { get: () => null, set() {} } });
  const sol = b.source("solana");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === "getBalance") return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: 123456789 } }) };
    if (req.method === "getTokenAccountsByOwner") return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [
      { account: { data: { parsed: { info: { tokenAmount: { amount: "1000000" } } } } } },
      { account: { data: { parsed: { info: { tokenAmount: { amount: "250000" } } } } } },
    ] } }) };
    return { ok: false, json: async () => null };
  };
  try {
    assert.equal(await b.tokenBalance(sol, Kit.SOL_NATIVE, "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy"), 123456789n);
    assert.equal(await b.usdcBalance(sol, "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy"), 1_250_000n);
    assert.equal(await b.tokenBalance(sol, Kit.SOL_NATIVE, "0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9"), null, "an EVM address is not a Solana owner");
  } finally { globalThis.fetch = realFetch; }
});
