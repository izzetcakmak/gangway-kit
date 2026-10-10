// node --test test/sui.test.mjs
// Sui as a source: Circle CCTP V2 on Sui (domain 8), one programmable transaction signed by a Wallet Standard wallet.
// Offline and deterministic: fetch is stubbed, the wallet is a fake. The golden transactions in fixtures/sui-burn.json are what
// the real @mysten/sui SDK prints (transaction.toJSON()) for the same burns; the kit must keep matching them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const Kit = require("../gangway-kit.js");
const golden = JSON.parse(readFileSync(new URL("./fixtures/sui-burn.json", import.meta.url), "utf8"));
const { buildSuiBurnTx, isSuiAddress, normSuiAddress, normMoveType, bcsVecU8, leBytes, hexToBytes, payShortlist, explainLifi, bytesToB64 } = Kit.utils;
const sui = Kit.SOURCES.mainnet.find((c) => c.key === "sui");
const cc = Kit.SUI_CCTP.mainnet;
const OWNER = "0x" + "5e".repeat(32);
const RECIPIENT = "0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9";
const SUI_USDC = sui.usdc;

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch; globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
};
const json = (body, ok = true) => ({ ok, json: async () => body });

test("Sui source: shape, ids and address helpers", () => {
  assert.ok(sui, "sui is a mainnet source");
  assert.equal(sui.vm, "move");
  assert.equal(Kit.utils.isMove(sui), true);
  assert.equal(Kit.utils.isMove(Kit.SOURCES.mainnet[0]), false);
  assert.equal(sui.domain, 8, "CCTP's Sui domain");
  assert.equal(sui.chainId, Kit.SUI_LIFI_CHAIN_ID);
  assert.equal(sui.fast, false, "Circle offers no Fast Transfer on Sui: standard is already about half a second");
  assert.equal(sui.native.decimals, 9);
  assert.equal(sui.usdc, "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", "Circle's native USDC on Sui, not a bridged copy");
  assert.ok(sui.rpcs[0].endsWith("/graphql"), "reads go to GraphQL: public JSON-RPC was switched off");
  // not a listed testnet source: Circle's sandbox quotes no forwarded route from Sui yet
  assert.equal(Kit.SOURCES.testnet.some((c) => c.vm === "move"), false);
  const t = Kit.SUI_TESTNET_SOURCE;
  assert.ok(t.vm === "move" && t.domain === 8 && t.key === "sui-testnet");
  assert.equal(t.usdc, "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC");
  for (const net of ["mainnet", "testnet"]) {
    const c = Kit.SUI_CCTP[net];
    for (const k of ["tokenMessengerPkg", "handlerPkg", "tokenMessenger", "messageTransmitter", "handler", "treasury"]) assert.ok(isSuiAddress(c[k]), net + " " + k);
    assert.equal(c.chain, "sui:" + net);
  }
  assert.equal(isSuiAddress(OWNER), true);
  assert.equal(isSuiAddress("0x2"), false, "short ids are not addresses");
  assert.equal(isSuiAddress(RECIPIENT), false, "an EVM address is not a Sui address");
  assert.equal(normSuiAddress("0x2"), "0x" + "0".repeat(63) + "2");
  assert.equal(normSuiAddress("0x403"), "0x" + "0".repeat(61) + "403");
  assert.equal(normMoveType("0x2::sui::SUI"), Kit.SUI_NATIVE);
  assert.equal(normMoveType(SUI_USDC.replace("0xdba3", "0xDBA3")), SUI_USDC, "case does not matter in the package address");
});

test("BCS encoders: little-endian integers and a vector<u8> length", () => {
  assert.deepEqual([...leBytes(26, 4)], [26, 0, 0, 0]);
  assert.deepEqual([...leBytes(1_000_000n, 8)], [64, 66, 15, 0, 0, 0, 0, 0]);
  assert.equal(leBytes(31602n, 32).length, 32);
  assert.deepEqual([...leBytes(31602n, 32).slice(0, 3)], [114, 123, 0]);
  assert.throws(() => leBytes(2n ** 32n, 4), /does not fit/);
  assert.throws(() => leBytes(-1, 4), /negative/);
  assert.deepEqual([...bcsVecU8(Uint8Array.from([7, 8, 9]))], [3, 7, 8, 9]);
  const long = bcsVecU8(new Uint8Array(200));
  assert.deepEqual([...long.slice(0, 2)], [200, 1], "ULEB128: 200 = 0xC8 0x01");
  assert.equal(long.length, 202);
  assert.equal(bytesToB64(bcsVecU8(hexToBytes(Kit.FORWARD_HOOK))), "IGNjdHAtZm9yd2FyZAAAAAAAAAAAAAAAAAAAAAAAAAAA", "the 32-byte forwarding hook as the SDK encodes it");
  assert.throws(() => hexToBytes("0xabc"), /not hex/);
  assert.throws(() => hexToBytes("0xzz"), /not hex/);
});

test("burn transactions equal what the real SDK prints, case by case", () => {
  assert.ok(golden.cases.length >= 5);
  for (const c of golden.cases) {
    const mine = buildSuiBurnTx({ cctp: cc, usdcType: SUI_USDC, sender: golden.sender, amount: BigInt(c.input.amount),
      coins: c.input.coins.map((x) => ({ id: x.id, balance: BigInt(x.balance) })), addressBalance: BigInt(c.input.addressBalance),
      destinationDomain: 26, mintRecipient: golden.mintRecipient, maxFee: BigInt(golden.maxFee), minFinalityThreshold: 2000, hookData: Kit.FORWARD_HOOK });
    assert.deepEqual(JSON.parse(mine), c.expected, c.name);
  }
});

test("buildSuiBurnTx refuses what cannot be burned, before a wallet is asked", () => {
  const base = { cctp: cc, usdcType: SUI_USDC, sender: OWNER, destinationDomain: 26, mintRecipient: golden.mintRecipient, maxFee: 35600n, minFinalityThreshold: 2000, hookData: Kit.FORWARD_HOOK };
  const coin = (n, b) => ({ id: "0x" + n.toString(16).padStart(64, "0"), balance: BigInt(b) });
  assert.throws(() => buildSuiBurnTx({ ...base, amount: 0n, coins: [coin(1, 5)], addressBalance: 0n }), /positive/);
  assert.throws(() => buildSuiBurnTx({ ...base, amount: 10n, coins: [coin(1, 5)], addressBalance: 2n }), /Not enough USDC/);
  assert.throws(() => buildSuiBurnTx({ ...base, amount: 10n, coins: [], addressBalance: 0n }), /Not enough USDC/);
  assert.throws(() => buildSuiBurnTx({ ...base, amount: 1n, coins: [coin(1, 5)], addressBalance: 0n, mintRecipient: "0x1234" }), /32 bytes/);
  // a wallet that holds its USDC in hundreds of dust coins: merge them first, the kit will not build a transaction that cannot fit
  const dust = Array.from({ length: 300 }, (_, i) => coin(i + 1, 10));
  assert.throws(() => buildSuiBurnTx({ ...base, amount: 2600n, coins: dust, addressBalance: 0n }), /small coins/);
  // but the same dust is fine while the largest coins cover it
  const ok = JSON.parse(buildSuiBurnTx({ ...base, amount: 2000n, coins: dust, addressBalance: 0n }));
  assert.equal(ok.commands.filter((c) => c.MergeCoins).length, 1);
  assert.equal(ok.commands.find((c) => c.MergeCoins).MergeCoins.sources.length, 199, "200 coins of 10 cover 2000: one primary, 199 merged in");
  // zero-balance coins are ignored, and the biggest coin is the one that is kept
  const sorted = JSON.parse(buildSuiBurnTx({ ...base, amount: 3n, coins: [coin(1, 0), coin(2, 2), coin(3, 9)], addressBalance: 0n }));
  assert.equal(sorted.inputs[0].UnresolvedObject.objectId, coin(3, 9).id);
  assert.equal(sorted.commands[0].SplitCoins.coin.Input, 0);
});

test("payShortlist on Sui: SUI first, USDC second, only the pinned coin types, never a look-alike", () => {
  const usdt = Kit.MOVE_KNOWN.find((k) => k.symbol === "USDT");
  const wal = Kit.MOVE_KNOWN.find((k) => k.symbol === "WAL");
  const tokens = [
    { address: normSuiAddress("0x2") + "::sui::SUI", symbol: "SUI", name: "SUI", decimals: 9 },
    { address: SUI_USDC, symbol: "USDC", name: "USDC", decimals: 6 },
    { address: "0x" + "d".repeat(64) + "::coin::COIN", symbol: "USDC", name: "USD Coin", decimals: 6 },       // a Wormhole copy
    { address: "0x" + "c".repeat(64) + "::coin::COIN", symbol: "USDT", name: "Tether USD", decimals: 6 },     // not the pinned USDT
    { address: usdt.address, symbol: "USDT", name: "Tether", decimals: 6 },
    { address: wal.address.replace("0x356a26", "0x356A26"), symbol: "WAL", name: "WAL Token", decimals: 9 },  // same type, other case
  ];
  const out = payShortlist(tokens, sui);
  assert.deepEqual(out.map((t) => t.symbol), ["SUI", "USDC", "USDT", "WAL"]);
  assert.equal(out[1].address, SUI_USDC, "the native USDC, not the copy");
  assert.equal(out[2].address, usdt.address, "the pinned USDT, not the look-alike");
  assert.equal(out[3].address, wal.address);
  assert.deepEqual(payShortlist(null, sui).map((t) => t.symbol), ["SUI", "USDC"], "with no LI.FI list, only SUI and USDC are offered");
  assert.equal(payShortlist(null, sui)[0].address, Kit.SUI_NATIVE);
  for (const k of Kit.MOVE_KNOWN) assert.match(k.address, /^0x[0-9a-f]{50,64}::[a-z_]+::[A-Z_]+$/i);
  assert.equal(new Set(Kit.MOVE_KNOWN.map((k) => normMoveType(k.address))).size, Kit.MOVE_KNOWN.length, "no coin type twice");
});

test("explainLifi on Sui points at USDC, never at Solana", () => {
  for (const reason of ["No available quotes for the requested transfer", "Could not find token", "something else"]) {
    const m = explainLifi(reason, sui, "mainnet");
    assert.match(m, /Sui/);
    assert.doesNotMatch(m, /Solana|SOL /);
  }
  assert.match(explainLifi("No available quotes", sui, "mainnet"), /pay with USDC/i);
});

test("Sui reads: balances (coins and address balance), coin objects with paging, transaction status", async () => {
  const { suiBalance, suiCoins, suiTxStatus } = Kit.utils;
  const stub = async (url, init) => {
    const q = JSON.parse(init.body).query;
    if (q.includes("balance(coinType")) return json({ data: { address: { balance: { totalBalance: "7000000", coinBalance: "5000000", addressBalance: "2000000" } } } });
    if (q.includes("objects(")) {
      const second = q.includes('after: "cur1"');
      return json({ data: { address: { objects: { pageInfo: { hasNextPage: !second, endCursor: second ? "cur2" : "cur1" },
        nodes: second ? [{ address: "0xb", contents: { json: { balance: "30" } } }] : [{ address: "0xa", contents: { json: { balance: "20" } } }, { address: "0xbad", contents: { json: null } }] } } } });
    }
    if (q.includes("transaction(digest")) return json({ data: { transaction: q.includes("GoodDigest") ? { effects: { status: "SUCCESS" } } : q.includes("BadDigest") ? { effects: { status: "FAILURE" } } : null } });
    return json({ data: null }, false);
  };
  await withFetch(stub, async () => {
    assert.deepEqual(await suiBalance(sui.rpcs, SUI_USDC, OWNER), { total: 7_000_000n, coin: 5_000_000n, address: 2_000_000n });
    assert.equal(await suiBalance(sui.rpcs, SUI_USDC, "0x123"), null, "a bad owner never reaches the network");
    assert.equal(await suiBalance(sui.rpcs, "not a coin type", OWNER), null);
    assert.equal(await suiBalance(sui.rpcs, "0x1::a::B\" } evil", OWNER), null, "nothing but a coin type is ever put in a query");
    assert.deepEqual(await suiCoins(sui.rpcs, SUI_USDC, OWNER), [{ id: "0xa", balance: 20n }, { id: "0xb", balance: 30n }], "two pages, the broken node skipped");
    assert.equal(await suiTxStatus(sui.rpcs, "1111111111111111111111111111GoodDigest"), "ok");
    assert.equal(await suiTxStatus(sui.rpcs, "1111111111111111111111111111BadDigest1"), "failed");
    assert.equal(await suiTxStatus(sui.rpcs, "1111111111111111111111111111NotYetIdxd"), "pending");
    assert.equal(await suiTxStatus(sui.rpcs, "not a digest"), "pending");
  });
  await withFetch(async () => { throw new Error("offline"); }, async () => { assert.equal(await suiBalance(sui.rpcs, SUI_USDC, OWNER), null, "an unreachable endpoint is null, not a throw"); });
});

test("suiGql: the first endpoint that answers with data wins; errors and failures fall through", async () => {
  const { suiGql } = Kit.utils;
  const seen = [];
  await withFetch(async (url) => { seen.push(String(url)); return String(url).includes("one") ? json({ errors: [{ message: "boom" }] }) : json({ data: { ok: true } }); }, async () => {
    assert.deepEqual(await suiGql(["https://one.example/graphql", "https://two.example/graphql"], "{ ok }"), { ok: true });
    assert.equal(seen.length, 2);
    assert.equal(await suiGql([], "{ ok }"), null);
  });
});

test("Sui balances through the engine: USDC, SUI, any coin; the fee asset is the native one", async () => {
  const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", storage: { get: () => null, set() {} } });
  const src = b.source("sui");
  const asked = [];
  await withFetch(async (url, init) => {
    const q = JSON.parse(init.body).query; asked.push(q);
    const total = q.includes("0x2::sui::SUI") || q.includes("0000000000000000000000000000000000000000000000000000000000000002::sui::SUI") ? "9000000000" : "1250000";
    return json({ data: { address: { balance: { totalBalance: total, coinBalance: total, addressBalance: "0" } } } });
  }, async () => {
    assert.equal(await b.usdcBalance(src, OWNER), 1_250_000n);
    assert.equal(await b.tokenBalance(src, SUI_USDC, OWNER), 1_250_000n);
    assert.equal(await b.nativeBalance(src, OWNER), 9_000_000_000n);
    assert.equal(await b.tokenBalance(src, Kit.SUI_NATIVE, OWNER), 9_000_000_000n);
    assert.equal(await b.usdcBalance(src, "0xD4F1254C803662c46D9c21f80F4F3c15FF57e2c9"), null, "an EVM address is not a Sui owner");
  });
});

// ---- planning and the whole flow, offline

const IRIS_FEES = [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 15513, med: 15801, high: 17800 } }, { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 15513, med: 15801, high: 17800 } }];
const mkBridge = (extra = {}) => {
  const mem = new Map();
  return new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", router: "cctp", storage: { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) }, ...extra });
};

test("plan() on Sui: USDC is one CCTP burn at standard finality, no LI.FI call, no Arc route probe", async () => {
  const b = mkBridge({ router: "auto" });   // even "auto" never probes LI.FI for a route into Arc from Sui: there is none
  const seen = [];
  await withFetch(async (url) => { seen.push(String(url)); return json(IRIS_FEES); }, async () => {
    const p = await b.plan({ source: b.source("sui"), payToken: SUI_USDC, fromAmount: 10_000_000n, fromAddress: OWNER, recipient: RECIPIENT });
    assert.equal(p.available, true);
    assert.equal(p.router, "cctp");
    assert.equal(p.swap, null);
    assert.equal(p.bridge.minFinalityThreshold, 2000, "standard: Sui has no Fast Transfer");
    assert.equal(p.protocolFee, 0n);
    assert.equal(p.forwardFee, 17800n, "the forwarding fee at its high level");
    assert.equal(p.bridge.maxFee, 35600n, "the cap is twice the quoted fee");
    assert.equal(p.expectedReceive, 10_000_000n - 17800n);
    assert.equal(p.estSeconds, 15, "Sui finalizes in about half a second and real forwarded transfers took 4-10 s to mint");
    assert.equal(seen.length, 1);
    assert.match(seen[0], /iris-api[.]circle[.]com[/]v2[/]burn[/]USDC[/]fees[/]8[/]26[?]forward=true$/);
  });
});

test("plan() on Sui: SUI is a LI.FI swap into USDC on Sui, then the burn; the swap is quoted for the connected account", async () => {
  const b = mkBridge();
  const seen = [];
  await withFetch(async (url) => {
    seen.push(String(url));
    if (String(url).includes("li.quest")) return json({ tool: "cetus", type: "swap", estimate: { toAmount: "5332624", toAmountMin: "5305961", executionDuration: 15, gasCosts: [], feeCosts: [] }, transactionRequest: { data: "AQID" } });
    return json(IRIS_FEES);
  }, async () => {
    const p = await b.plan({ source: b.source("sui"), payToken: Kit.SUI_NATIVE, fromAmount: 5_000_000_000n, fromAddress: OWNER, recipient: RECIPIENT });
    assert.equal(p.available, true);
    assert.equal(p.router, "cctp");
    assert.equal(p.swap.tool, "cetus");
    assert.deepEqual(p.swap.tx, { data: "AQID" }, "LI.FI hands back the whole transaction as base64 bytes");
    assert.equal(p.usdcIn, 5_305_961n, "the burn is planned on the guaranteed minimum of the swap");
    assert.equal(p.estSeconds, 30, "the swap adds 15 s");
    const li = new URL(seen.find((u) => u.includes("li.quest")));
    assert.equal(li.searchParams.get("fromChain"), String(Kit.SUI_LIFI_CHAIN_ID));
    assert.equal(li.searchParams.get("toChain"), String(Kit.SUI_LIFI_CHAIN_ID), "a same-chain swap, never a route into Arc");
    assert.equal(li.searchParams.get("fromToken"), Kit.SUI_NATIVE);
    assert.equal(li.searchParams.get("toToken"), SUI_USDC);
    assert.equal(li.searchParams.get("fromAddress"), OWNER);
    assert.equal(seen.filter((u) => u.includes("li.quest")).length, 1);
    // before a wallet is connected a placeholder address is quoted for, and it is a valid Sui address
    seen.length = 0; b._quoteCache.clear();
    await b.plan({ source: b.source("sui"), payToken: Kit.SUI_NATIVE, fromAmount: 5_000_000_000n, recipient: RECIPIENT });
    assert.equal(isSuiAddress(new URL(seen.find((u) => u.includes("li.quest"))).searchParams.get("fromAddress")), true);
  });
  // LI.FI refusing the swap says so in terms a Sui user can act on
  const b2 = mkBridge();
  await withFetch(async (url) => (String(url).includes("li.quest") ? json({ message: "No available quotes for the requested transfer", code: 1002 }, false) : json(IRIS_FEES)), async () => {
    const p = await b2.plan({ source: b2.source("sui"), payToken: Kit.SUI_NATIVE, fromAmount: 5_000_000_000n, fromAddress: OWNER, recipient: RECIPIENT });
    assert.equal(p.available, false);
    assert.match(p.reason, /pay with USDC/i);
  });
});

// a fake Wallet Standard wallet for Sui: records what it is handed, answers like a wallet that signed and executed
const DIGEST = "5Nw7bC8x2v3Zk9yHq4RtU1mAeLd6GfPsJ8oXn2VcKiWz";
const C1 = "0x" + "a1".repeat(32), C2 = "0x" + "b2".repeat(32);
function fakeWallet({ reject, signOnly } = {}) {
  const account = { address: OWNER, chains: ["sui:mainnet"], features: [] };
  const w = { name: "FakeSui", chains: ["sui:mainnet"], accounts: [account], calls: [], disconnected: false, features: {
    "standard:connect": { connect: async (o) => ({ accounts: o && o.silent && w.silentEmpty ? [] : [account] }) },
    "standard:disconnect": { disconnect: async () => { w.disconnected = true; } },
  } };
  const take = async (input, kind) => {
    const payload = await input.transaction.toJSON();
    w.calls.push({ kind, payload, chain: input.chain, account: input.account.address });
    if (reject && w.calls.length >= (reject === true ? 1 : reject)) throw new Error("User rejected the request.");
    return payload;
  };
  if (signOnly) w.features["sui:signTransaction"] = { version: "2.0.0", signTransaction: async (i) => { await take(i, "sign"); return { bytes: "AAAA", signature: "BBBB" }; } };
  else w.features["sui:signAndExecuteTransaction"] = { version: "2.0.0", signAndExecuteTransaction: async (i) => { await take(i, "signAndExecute"); return { digest: DIGEST, bytes: "", signature: "", effects: "" }; } };
  return w;
}
// every endpoint the flow touches: Circle's fee and message APIs, Sui's GraphQL, LI.FI
function stubAll({ usdcCoins = [{ address: C1, balance: 5_000_000n }, { address: C2, balance: 3_000_000n }], addressBalance = 0n, sui = 2_000_000_000n, status = "SUCCESS", swapBytes = "AQID" } = {}) {
  const coinTotal = usdcCoins.reduce((x, c) => x + c.balance, 0n);
  return async (url, init) => {
    const u = String(url);
    if (u.includes("li.quest")) return json({ tool: "cetus", type: "swap", estimate: { toAmount: "5332624", toAmountMin: "5305961", executionDuration: 15, gasCosts: [], feeCosts: [] }, transactionRequest: { data: swapBytes } });
    if (u.includes("/v2/burn/USDC/fees/")) return json(IRIS_FEES);
    if (u.includes("/v2/messages/")) return json(null, false);
    const q = JSON.parse(init.body).query;
    if (q.includes("executeTransaction")) return json({ data: { executeTransaction: { effects: { digest: DIGEST, status: "SUCCESS" } } } });
    if (q.includes("balance(coinType")) return q.includes("::sui::SUI") ? json({ data: { address: { balance: { totalBalance: String(sui), coinBalance: String(sui), addressBalance: "0" } } } })
      : json({ data: { address: { balance: { totalBalance: String(coinTotal + addressBalance), coinBalance: String(coinTotal), addressBalance: String(addressBalance) } } } });
    if (q.includes("objects(")) return json({ data: { address: { objects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: usdcCoins.map((c) => ({ address: c.address, contents: { json: { balance: String(c.balance) } } })) } } } });
    if (q.includes("transaction(digest")) return json({ data: { transaction: { effects: { status } } } });
    return json({ data: null }, false);
  };
}
const burnFor = (amount, coins, addressBalance = 0n) => buildSuiBurnTx({ cctp: cc, usdcType: SUI_USDC, sender: OWNER, amount, coins: coins.map((c) => ({ id: c.address, balance: c.balance })), addressBalance,
  destinationDomain: 26, mintRecipient: Kit.utils.toBytes32Address(RECIPIENT), maxFee: 35600n, minFinalityThreshold: 2000, hookData: Kit.FORWARD_HOOK });

test("bridge() on Sui, paying USDC: one signature, with exactly the transaction these balances call for", async () => {
  const w = fakeWallet(), b = mkBridge({ suiWallet: w, suiPollMs: 1 }), steps = [];
  await withFetch(stubAll(), async () => {
    assert.equal(await b.connectSui(), OWNER);
    const tr = await b.bridge({ source: b.source("sui"), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT, onStep: (s) => steps.push(s.step) });
    assert.deepEqual(steps, ["planning", "burning", "burn_sent", "burned"]);
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].kind, "signAndExecute");
    assert.equal(w.calls[0].chain, "sui:mainnet");
    assert.equal(w.calls[0].account, OWNER);
    assert.deepEqual(JSON.parse(w.calls[0].payload), JSON.parse(burnFor(3_000_000n, [{ address: C1, balance: 5_000_000n }, { address: C2, balance: 3_000_000n }])));
    assert.equal(tr.router, "cctp");
    assert.equal(tr.sourceDomain, 8);
    assert.equal(tr.burnTx, DIGEST);
    assert.equal(tr.status, "burned");
    assert.equal(tr.speed, "standard");
    assert.equal(tr.amount, "3000000");
    assert.equal(tr.expectedFee, "17800");
    assert.equal(tr.maxFee, "35600");
    assert.equal(tr.sender, OWNER);
    assert.equal(b.pending().length, 1, "listed as in flight until it lands");
    assert.equal(b.explorerTx(b.source("sui"), DIGEST), "https://suiscan.xyz/mainnet/tx/" + DIGEST);
  });
});

test("bridge() on Sui, paying SUI: LI.FI's bytes go to the wallet untouched, then the burn for what the swap guarantees", async () => {
  const w = fakeWallet(), b = mkBridge({ suiWallet: w, suiPollMs: 1 }), steps = [];
  await withFetch(stubAll({ swapBytes: "QUJDRA==", sui: 9_000_000_000n }), async () => {
    await b.connectSui();
    const tr = await b.bridge({ source: b.source("sui"), amount: 5_000_000_000n, payToken: Kit.SUI_NATIVE, recipient: RECIPIENT, onStep: (s) => steps.push(s.step) });
    assert.deepEqual(steps, ["planning", "swapping", "swap_sent", "swapped", "burning", "burn_sent", "burned"]);
    assert.equal(w.calls.length, 2);
    assert.equal(w.calls[0].payload, "QUJDRA==", "the swap is signed exactly as LI.FI returned it");
    // the balance did not move (a stub), so the guaranteed minimum of the swap is what gets burned; two coins are needed for it
    assert.equal(tr.amount, "5305961");
    assert.deepEqual(JSON.parse(w.calls[1].payload), JSON.parse(burnFor(5_305_961n, [{ address: C1, balance: 5_000_000n }, { address: C2, balance: 3_000_000n }])));
    assert.equal(tr.swapTx, DIGEST);
    assert.equal(tr.burnTx, DIGEST);
  });
});

test("Sui failures: a rejection, a failed burn, too little SUI, too little USDC, no wallet", async () => {
  const src = (b) => b.source("sui");
  // the user says no in the wallet: the error says so, nothing is recorded as sent
  {
    const w = fakeWallet({ reject: true }), b = mkBridge({ suiWallet: w, suiPollMs: 1 });
    await withFetch(stubAll(), async () => {
      await b.connectSui();
      await assert.rejects(() => b.bridge({ source: src(b), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT }), /rejected/i);
      assert.equal(b.transfers()[0].status, "planned");
      assert.equal(b.pending().length, 1);
      assert.equal(b.transfers()[0].burnTx, undefined);
    });
  }
  // the wallet executed it and Sui says the transaction failed: marked failed, and the message says nothing was burned
  {
    const w = fakeWallet(), b = mkBridge({ suiWallet: w, suiPollMs: 1 });
    await withFetch(stubAll({ status: "FAILURE" }), async () => {
      await b.connectSui();
      await assert.rejects(() => b.bridge({ source: src(b), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT }), /burn failed on Sui/);
      assert.equal(b.transfers()[0].status, "failed");
      assert.equal(b.transfers()[0].error, "burn failed");
      assert.equal(b.pending().length, 0, "a failed transfer is not listed as in flight");
    });
  }
  // no SUI for the network fee: refused before the wallet is asked
  {
    const w = fakeWallet(), b = mkBridge({ suiWallet: w, suiPollMs: 1 });
    await withFetch(stubAll({ sui: 1_000_000n }), async () => {
      await b.connectSui();
      await assert.rejects(() => b.bridge({ source: src(b), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT }), /needs about 0[.]01 SUI/);
      assert.equal(w.calls.length, 0);
    });
  }
  // not enough USDC: refused before the wallet is asked
  {
    const w = fakeWallet(), b = mkBridge({ suiWallet: w, suiPollMs: 1 });
    await withFetch(stubAll(), async () => {
      await b.connectSui();
      await assert.rejects(() => b.bridge({ source: src(b), amount: 9_000_000n, payToken: SUI_USDC, recipient: RECIPIENT }), /too low/);
      assert.equal(w.calls.length, 0);
    });
  }
  // no wallet connected at all
  {
    const b = mkBridge({ suiWallet: fakeWallet() });
    await assert.rejects(() => b.bridge({ source: src(b), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT }), /Connect a Sui wallet/);
    assert.equal(b.suiAccount(), null);
  }
});

test("a swap that landed but was not burned can be continued, from the Sui wallet", async () => {
  const w = fakeWallet({ reject: 2 }), b = mkBridge({ suiWallet: w, suiPollMs: 1 });   // the second signature (the burn) is refused
  await withFetch(stubAll({ sui: 9_000_000_000n }), async () => {
    await b.connectSui();
    await assert.rejects(() => b.bridge({ source: b.source("sui"), amount: 5_000_000_000n, payToken: Kit.SUI_NATIVE, recipient: RECIPIENT }), /rejected/i);
    const tr = b.transfers()[0];
    assert.equal(tr.status, "swapped");
    assert.equal(tr.amount, "5305961");
    assert.equal(b.pending().length, 1);
    w.calls.length = 0;
    const w2 = fakeWallet(); b.suiWalletOpt = w2; await b.connectSui();
    const out = await b.continueBridge(tr);
    assert.equal(out.status, "burned");
    assert.equal(w2.calls.length, 1);
    assert.equal(out.burnTx, DIGEST);
  });
  const b2 = mkBridge({ suiWallet: fakeWallet() });
  await assert.rejects(() => b2.continueBridge({ status: "swapped", sourceKey: "sui", amount: "1000000", recipient: RECIPIENT }), /Connect a Sui wallet/);
});

test("a Sui wallet that signs but does not submit: the signed transaction goes to the GraphQL endpoint", async () => {
  const w = fakeWallet({ signOnly: true }), b = mkBridge({ suiWallet: w, suiPollMs: 1 });
  const posted = [];
  const stub = stubAll();
  await withFetch(async (url, init) => { if (init && init.body && JSON.parse(init.body).query.includes("executeTransaction")) posted.push(JSON.parse(init.body).query); return stub(url, init); }, async () => {
    await b.connectSui();
    const tr = await b.bridge({ source: b.source("sui"), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT });
    assert.equal(w.calls[0].kind, "sign");
    assert.equal(posted.length, 1);
    assert.match(posted[0], /transactionDataBcs: "AAAA", signatures: \["BBBB"\]/);
    assert.equal(tr.burnTx, DIGEST);
  });
  const none = fakeWallet(); delete none.features["sui:signAndExecuteTransaction"];
  const b2 = mkBridge({ suiWallet: none });
  await assert.rejects(async () => { await b2.connectSui(); await b2._suiSignAndExecute("{}", b2.source("sui")); }, /offers no Wallet Standard signing for Sui/);
});

test("Sui wallet discovery: Wallet Standard wallets that name a Sui chain and can sign, nothing else", async () => {
  const real = globalThis.window;
  const win = new EventTarget();
  globalThis.window = win;
  try {
    const mk = (name, chains, feats) => ({ name, chains, accounts: [], features: { "standard:connect": { connect: async () => ({ accounts: [] }) }, ...Object.fromEntries(feats.map((f) => [f, {}])) } });
    // wallets announce themselves when the app says it is ready, and again to apps that arrive later
    win.addEventListener("wallet-standard:app-ready", (e) => {
      e.detail.register(mk("Slush", ["sui:mainnet", "sui:testnet"], ["sui:signAndExecuteTransaction"]));
      e.detail.register(mk("Phantom", ["solana:mainnet", "sui:mainnet", "eip155:1"], ["sui:signTransaction", "solana:signAndSendTransaction"]));
      e.detail.register(mk("Backpack-solana-only", ["solana:mainnet"], ["solana:signAndSendTransaction"]));
      e.detail.register(mk("Sui-no-signing", ["sui:mainnet"], []));
      e.detail.register({ name: "no-connect", chains: ["sui:mainnet"], features: { "sui:signTransaction": {} } });
    });
    const b = mkBridge();
    const found = await b.suiWallets();
    assert.deepEqual(found.map((x) => x.name).sort(), ["Phantom", "Slush"]);
    assert.equal((await b.suiWallets()), found, "discovered once per session");
    // the Solana side of the same registry is untouched by this
    const sol = await mkBridge().solanaWallets();
    assert.deepEqual(sol.map((x) => x.name).sort(), ["Backpack-solana-only", "Phantom"]);
  } finally { if (real === undefined) delete globalThis.window; else globalThis.window = real; }
});

test("connectSui: picks the account on the right chain, silent connect without one is null, disconnect forgets", async () => {
  const w = fakeWallet();
  const b = mkBridge({ suiWallet: w });
  w.silentEmpty = true;
  assert.equal(await b.connectSui(w, { silent: true }), null, "a wallet that does not trust this site yet gives no account on a silent connect");
  assert.equal(b.suiAccount(), null);
  w.silentEmpty = false;
  assert.equal(await b.connectSui(w), OWNER);
  assert.equal(b.suiWalletName(), "FakeSui");
  b.disconnectSui();
  assert.equal(b.suiAccount(), null);
  assert.equal(w.disconnected, true);
  const none = mkBridge({ suiWallet: () => null });
  await assert.rejects(() => none.connectSui(), /No Sui wallet in this browser/);
  // a wallet whose only accounts are on another chain family connects nothing
  const odd = fakeWallet(); odd.accounts = [{ address: OWNER, chains: ["solana:mainnet"] }]; odd.features["standard:connect"].connect = async () => ({ accounts: odd.accounts });
  await assert.rejects(() => mkBridge({ suiWallet: odd }).connectSui(), /without a Sui account/);
  // the testnet kit asks for sui:testnet accounts
  const t = fakeWallet(); t.accounts = [{ address: "0x" + "7".repeat(64), chains: ["sui:mainnet"] }, { address: OWNER, chains: ["sui:testnet"] }];
  t.features["standard:connect"].connect = async () => ({ accounts: t.accounts });
  const tb = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "testnet", sources: [Kit.SUI_TESTNET_SOURCE], suiWallet: t, storage: { get: () => null, set() {} } });
  assert.equal(await tb.connectSui(), OWNER);
  assert.equal(tb.source("sui-testnet").domain, 8);
});

test("the testnet kit burns with the testnet packages and USDC", async () => {
  const w = fakeWallet(); w.accounts[0].chains = ["sui:testnet"];
  const b = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "testnet", router: "cctp", sources: [Kit.SUI_TESTNET_SOURCE], suiWallet: w, suiPollMs: 1, storage: { get: () => null, set() {} } });
  const src = b.source("sui-testnet");
  await withFetch(stubAll(), async () => {
    await b.connectSui();
    await b.bridge({ source: src, amount: 3_000_000n, payToken: src.usdc, recipient: RECIPIENT });
    const tx = JSON.parse(w.calls[0].payload);
    assert.equal(w.calls[0].chain, "sui:testnet");
    const call = tx.commands.find((c) => c.MoveCall && c.MoveCall.function === "deposit_for_burn").MoveCall;
    assert.equal(call.package, Kit.SUI_CCTP.testnet.tokenMessengerPkg);
    assert.deepEqual(call.typeArguments, [src.usdc]);
    assert.ok(tx.inputs.some((i) => i.UnresolvedObject && i.UnresolvedObject.objectId === Kit.SUI_CCTP.testnet.tokenMessenger));
  });
});

test("a paused token messenger on Sui stops a burn before the wallet is asked", async () => {
  const w = fakeWallet(), b = mkBridge({ suiWallet: w, suiPollMs: 1 });
  const stub = stubAll();
  const withState = (paused) => async (url, init) => {
    const q = init && init.body ? JSON.parse(init.body).query : "";
    if (q.includes("object(address")) return json({ data: { object: { asMoveObject: { contents: { json: { paused } } } } } });
    return stub(url, init);
  };
  await withFetch(withState(true), async () => {
    await b.connectSui();
    await assert.rejects(() => b.bridge({ source: b.source("sui"), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT }), /paused CCTP on Sui/);
    assert.equal(w.calls.length, 0);
  });
  // open: it goes through; unreadable state never blocks a user
  await withFetch(withState(false), async () => { await b.bridge({ source: b.source("sui"), amount: 3_000_000n, payToken: SUI_USDC, recipient: RECIPIENT }); assert.equal(w.calls.length, 1); });
  await withFetch(stubAll(), async () => { assert.equal(await Kit.utils.suiCctpOpen(sui.rpcs, cc), null); });
  await withFetch(async () => json({ data: { object: { asMoveObject: { contents: { json: { paused: false } } } } } }), async () => { assert.equal(await Kit.utils.suiCctpOpen(sui.rpcs, cc), true); });
});

test("a refused LI.FI fee on Sui (no fee wallet there yet) does not switch the fee off on other chains", async () => {
  const seen = [];
  const b = mkBridge({ lifiIntegrator: "a-new-one", lifiFee: 0.0025 });
  await withFetch(async (url) => {
    const u = new URL(String(url)); seen.push(u);
    if (!String(url).includes("li.quest")) return json(IRIS_FEES);
    if (u.searchParams.has("fee") && u.searchParams.get("fromChain") === String(Kit.SUI_LIFI_CHAIN_ID)) return json({ message: 'Integrator "a-new-one" is not configured for collecting fees on chain "9270000000000000". Please sign up on https://portal.li.fi/ and configure your fee wallet.', code: 1011 }, false);
    return json({ tool: "x", type: "swap", estimate: { toAmount: "100", toAmountMin: "99", executionDuration: 1, gasCosts: [], feeCosts: [] }, transactionRequest: { data: "AQID", to: "0x" + "1".repeat(40), value: "0" } });
  }, async () => {
    const swapOnSui = () => b.lifiQuote({ fromChain: Kit.SUI_LIFI_CHAIN_ID, toChain: Kit.SUI_LIFI_CHAIN_ID, fromToken: Kit.SUI_NATIVE, toToken: SUI_USDC, fromAmount: 10n ** 9n, fromAddress: OWNER });
    const swapOnBase = (n) => b.lifiQuote({ fromChain: 8453, toChain: 8453, fromToken: Kit.NATIVE, toToken: Kit.SOURCES.mainnet[0].usdc, fromAmount: BigInt(n) * 10n ** 15n });
    assert.equal(b.lifiFeeActiveFor(Kit.SUI_LIFI_CHAIN_ID), true);
    assert.equal((await swapOnSui()).available, true, "the Sui swap survives the refused fee");
    assert.equal(b.lifiFeeActiveFor(Kit.SUI_LIFI_CHAIN_ID), false, "no fee on Sui from now on");
    assert.equal(b.lifiFeeActiveFor(8453), true, "Base still carries it");
    await swapOnBase(1);
    const base = seen.filter((u) => u.searchParams.get("fromChain") === "8453");
    assert.equal(base.length, 1);
    assert.equal(base[0].searchParams.get("fee"), "0.0025", "an EVM swap after the Sui refusal still pays the integrator fee");
    // and the Sui quote does not ask again with the fee
    const suiCalls = seen.filter((u) => u.searchParams.get("fromChain") === String(Kit.SUI_LIFI_CHAIN_ID)).length;
    b._quoteCache.clear(); await swapOnSui();
    assert.equal(seen.filter((u) => u.searchParams.get("fromChain") === String(Kit.SUI_LIFI_CHAIN_ID)).length, suiCalls + 1, "one call, straight out without the fee");
  });
});

test("a Sui wallet that cannot read LI.FI's swap bytes: a message that says what to do; a refusal stays a refusal", async () => {
  const unreadable = fakeWallet();
  unreadable.features["sui:signAndExecuteTransaction"].signAndExecuteTransaction = async () => { throw new SyntaxError("Unexpected token Q in JSON at position 0"); };
  const b = mkBridge({ suiWallet: unreadable, suiPollMs: 1 });
  await withFetch(stubAll({ sui: 9_000_000_000n }), async () => {
    await b.connectSui();
    await assert.rejects(() => b.bridge({ source: b.source("sui"), amount: 5_000_000_000n, payToken: Kit.SUI_NATIVE, recipient: RECIPIENT }), /could not take the swap.*Pay in USDC instead/);
    // paying USDC never touches the swap path: the same wallet's burn still goes through its own JSON route
    assert.equal(b.transfers()[0].status, "planned", "nothing was sent");
  });
  const refuses = fakeWallet({ reject: true }), b2 = mkBridge({ suiWallet: refuses, suiPollMs: 1 });
  await withFetch(stubAll({ sui: 9_000_000_000n }), async () => {
    await b2.connectSui();
    await assert.rejects(() => b2.bridge({ source: b2.source("sui"), amount: 5_000_000_000n, payToken: Kit.SUI_NATIVE, recipient: RECIPIENT }), (e) => /rejected/i.test(e.message) && !/could not take/.test(e.message));
  });
});
