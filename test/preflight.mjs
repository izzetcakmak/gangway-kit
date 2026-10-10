#!/usr/bin/env node
// Read-only live check: every source chain's RPC answers with the right chainId, its USDC
// contract reports 6 decimals, CCTP TokenMessengerV2 knows Arc (domain 26), Circle's Iris
// quotes a forwarded route to Arc, and (informational) whether LI.FI swaps the native coin
// into USDC there and whether LI.FI already routes straight into Arc. Sui is checked through its GraphQL
// endpoint (Circle's Move packages and shared objects, the pause flag, Arc's registration). Never sends a transaction.
//
//   node test/preflight.mjs                 # testnet (default)
//   node test/preflight.mjs mainnet
//   node test/preflight.mjs mainnet --lifi  # also ask LI.FI per chain (costs ~2 keyless requests each)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Kit = require("../gangway-kit.js");
const { jsonRpc, fetchJson, computeFees } = Kit.utils;

const network = process.argv[2] === "mainnet" ? "mainnet" : "testnet";
// LI.FI's keyless budget is ~200 requests / 2 h per IP; the two LI.FI lines per chain are opt-in.
const LIFI_CHECK = process.argv.includes("--lifi");
const cctp = Kit.CCTP[network];
const core = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network, storage: { get: () => null, set() {} } });
const pad = (n) => BigInt(n).toString(16).padStart(64, "0");
let failures = 0;
const ok = (cond, label) => { console.log((cond ? "  ok   " : "  FAIL ") + label); if (!cond) failures++; };

console.log(`== gangway-kit preflight (${network}) ==`);

// Arc itself
const arc = Kit.ARC[network];
console.log(`\n${arc.name} (chainId ${arc.chainId})`);
if (arc.rpcs.length) {
  let id = null, dec = null, dom = null;
  for (const u of arc.rpcs) {
    id ??= await jsonRpc(u, "eth_chainId");
    dec ??= await jsonRpc(u, "eth_call", [{ to: arc.usdc, data: "0x313ce567" }, "latest"]);
    dom ??= await jsonRpc(u, "eth_call", [{ to: cctp.messageTransmitter, data: "0x8d3638f4" }, "latest"]);
  }
  ok(id && Number(BigInt(id)) === arc.chainId, `rpc chainId = ${id && Number(BigInt(id))}`);
  ok(dec && Number(BigInt(dec)) === 6, `USDC ${arc.usdc} decimals = ${dec && Number(BigInt(dec))}`);
  ok(dom && Number(BigInt(dom)) === 26, `MessageTransmitterV2.localDomain = ${dom && Number(BigInt(dom))}`);
} else {
  console.log("  skip  no public RPC configured yet (fill ARC.mainnet.rpcs when Circle publishes it)");
}

for (const c of Kit.SOURCES[network]) {
  console.log(`\n${c.name} (chainId ${c.chainId}, domain ${c.domain})`);
  if (c.vm === "svm") {
    // Solana: its RPC answers, the USDC mint exists, and LI.FI routes SOL into Arc (the one
    // path this source has; there is no CCTP leg for it in the kit)
    let ver = null, mint = null, live = null;
    for (const u of c.rpcs) {
      ver ??= await jsonRpc(u, "getVersion");
      if (ver && !live) live = u;
      mint ??= await jsonRpc(u, "getAccountInfo", [c.usdc, { encoding: "jsonParsed" }]);
    }
    ok(ver && ver["solana-core"], `rpc answers: solana-core ${ver ? ver["solana-core"] : "no answer"}${live ? " via " + live : ""}`);
    const info = mint && mint.value && mint.value.data && mint.value.data.parsed && mint.value.data.parsed.info;
    ok(info && Number(info.decimals) === 6, `USDC mint ${c.usdc} decimals = ${info ? info.decimals : "n/a"}`);
    const route = await core.plan({ source: c, payToken: Kit.SOL_NATIVE, fromAmount: 10n ** 8n });
    ok(route.available, route.available ? `LI.FI routes 0.1 SOL into Arc via ${route.lifi.tool}: ≈ ${route.expectedReceive} minor USDC in ~${route.estSeconds} s` : "LI.FI has no route from Solana into Arc: " + route.reason);
    continue;
  }
  if (c.vm === "move") {
    // Sui: GraphQL answers, Circle's CCTP objects exist and are not paused, Arc (26) is registered with the
    // TokenMessenger the EVM side uses, USDC reports 6 decimals, and Circle quotes a forwarded route to Arc
    const cc = Kit.SUI_CCTP[network];
    const d = await Kit.utils.suiGql(c.rpcs, '{ chainIdentifier tmm: object(address: "' + cc.tokenMessenger + '") { asMoveObject { contents { json } } } ' +
      'mt: object(address: "' + cc.messageTransmitter + '") { version } hd: object(address: "' + cc.handler + '") { version } tr: object(address: "' + cc.treasury + '") { version } ' +
      'pk: package(address: "' + cc.tokenMessengerPkg + '") { version } hp: package(address: "' + cc.handlerPkg + '") { version } ' +
      'coin: coinMetadata(coinType: "' + c.usdc + '") { symbol decimals } }');
    ok(d && d.chainIdentifier, "GraphQL answers: chain " + (d ? d.chainIdentifier : "no answer") + " via " + c.rpcs[0]);
    ok(d && d.mt && d.hd && d.tr && d.pk && d.hp, "Circle's packages and shared objects exist (token messenger package v" + (d && d.pk ? d.pk.version : "?") + ")");
    const st = d && d.tmm && d.tmm.asMoveObject && d.tmm.asMoveObject.contents && d.tmm.asMoveObject.contents.json;
    ok(st && st.paused === false, "token messenger is open (paused = " + (st ? st.paused : "n/a") + ")");
    const table = st && st.remote_token_messengers && st.remote_token_messengers.id;
    const reg = table && await Kit.utils.suiGql(c.rpcs, '{ address(address: "' + table + '") { dynamicField(name: { type: "u32", bcs: "' + Kit.utils.bytesToB64(Kit.utils.leBytes(26, 4)) + '" }) { value { ... on MoveValue { json } } } } }');
    const remoteTm = reg && reg.address && reg.address.dynamicField && reg.address.dynamicField.value && reg.address.dynamicField.value.json;
    ok(remoteTm && String(remoteTm).slice(-40).toLowerCase() === cctp.tokenMessenger.slice(2).toLowerCase(), "Arc (26) is registered with " + (remoteTm ? "0x" + String(remoteTm).slice(-40) : "NOTHING"));
    ok(d && d.coin && d.coin.symbol === "USDC" && Number(d.coin.decimals) === 6, "USDC " + c.usdc.slice(0, 12) + "... is " + (d && d.coin ? d.coin.symbol + " with " + d.coin.decimals + " decimals" : "unknown"));
    const fees = await fetchJson(cctp.iris + "/v2/burn/USDC/fees/" + c.domain + "/26?forward=true");
    const q = computeFees(fees, 10_000_000n, "standard");
    ok(!!q, q ? "Iris forwarded quote for 10 USDC: protocol " + q.protocolFee + " + forward " + q.forwardFee + " minor units (" + q.speed + ")" : "Iris has no forwarded quote");
    if (LIFI_CHECK && network === "mainnet") {
      const list = await core.lifiTokens(c.chainId);
      const missing = Kit.MOVE_KNOWN.filter((k) => !list.some((t) => Kit.utils.normMoveType(t.address) === Kit.utils.normMoveType(k.address)));
      console.log("  info  LI.FI lists " + (Kit.MOVE_KNOWN.length - missing.length) + " of " + Kit.MOVE_KNOWN.length + " pinned pay-with coins" + (missing.length ? " (not listed: " + missing.map((k) => k.symbol).join(", ") + ")" : ""));
      const swap = await core.quoteSwap(c, Kit.SUI_NATIVE, 10n ** 9n, null);
      console.log("  info  LI.FI swap 1 SUI -> USDC: " + (swap.available ? "yes via " + swap.tool + " (about " + swap.toAmount + " minor)" : "no (" + swap.reason + ")"));
    }
    continue;
  }
  let id = null, dec = null, remote = null, live = null;
  for (const u of c.rpcs) {
    id ??= await jsonRpc(u, "eth_chainId");
    if (id && !live) live = u;
    dec ??= await jsonRpc(u, "eth_call", [{ to: c.usdc, data: "0x313ce567" }, "latest"]);
    // remoteTokenMessengers(uint32) selector 0x82a5e665
    remote ??= await jsonRpc(u, "eth_call", [{ to: cctp.tokenMessenger, data: "0x82a5e665" + pad(26) }, "latest"]);
  }
  ok(id && Number(BigInt(id)) === c.chainId, `rpc chainId = ${id ? Number(BigInt(id)) : "no answer"}${live ? " via " + live : ""}`);
  ok(dec && Number(BigInt(dec)) === 6, `USDC decimals = ${dec ? Number(BigInt(dec)) : "n/a"}`);
  const registered = remote && remote !== "0x" + "0".repeat(64);
  ok(registered, `TokenMessengerV2 has Arc (26) registered: ${registered ? "0x" + remote.slice(-40) : "NO"}`);
  const fees = await fetchJson(`${cctp.iris}/v2/burn/USDC/fees/${c.domain}/26?forward=true`);
  const q = computeFees(fees, 10_000_000n, c.fast ? "fast" : "standard");
  ok(!!q, q ? `Iris forwarded quote for 10 USDC: protocol ${q.protocolFee} + forward ${q.forwardFee} minor units (${q.speed})` : "Iris has no forwarded quote");
  if (!LIFI_CHECK) continue;
  // LI.FI legs are informational: a chain without a LI.FI swap still bridges USDC over CCTP.
  const swap = await core.quoteSwap(c, Kit.NATIVE, 10n ** 15n, null);
  console.log(`  info  LI.FI swap 0.001 ${c.native.symbol} -> USDC: ${swap.available ? "yes via " + swap.tool + " (≈ " + swap.toAmount + " minor)" : "no (" + swap.reason + ")"}`);
  const direct = await core.arcRouteAvailable(c, null);
  console.log(`  info  LI.FI direct route into Arc: ${direct ? "YES — router auto will use it" : "not yet (CCTP path in use)"}`);
}

console.log(`\n${failures === 0 ? "ALL GOOD" : failures + " check(s) failed"}`);
process.exit(failures ? 1 : 0);
