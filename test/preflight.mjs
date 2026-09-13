#!/usr/bin/env node
// Read-only live check: every source chain's RPC answers with the right chainId, its USDC
// contract reports 6 decimals, CCTP TokenMessengerV2 knows Arc (domain 26), Circle's Iris
// quotes a forwarded route to Arc, and (informational) whether LI.FI swaps the native coin
// into USDC there and whether LI.FI already routes straight into Arc. Never sends a transaction.
//
//   node test/preflight.mjs            # testnet (default)
//   node test/preflight.mjs mainnet
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Kit = require("../arc-bridge-kit.js");
const { jsonRpc, fetchJson, computeFees } = Kit.utils;

const network = process.argv[2] === "mainnet" ? "mainnet" : "testnet";
const cctp = Kit.CCTP[network];
const core = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network, storage: { get: () => null, set() {} } });
const pad = (n) => BigInt(n).toString(16).padStart(64, "0");
let failures = 0;
const ok = (cond, label) => { console.log((cond ? "  ok   " : "  FAIL ") + label); if (!cond) failures++; };

console.log(`== arc-bridge-kit preflight (${network}) ==`);

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
  // LI.FI legs are informational: a chain without a LI.FI swap still bridges USDC over CCTP.
  const swap = await core.quoteSwap(c, Kit.NATIVE, 10n ** 15n, null);
  console.log(`  info  LI.FI swap 0.001 ${c.native.symbol} -> USDC: ${swap.available ? "yes via " + swap.tool + " (≈ " + swap.toAmount + " minor)" : "no (" + swap.reason + ")"}`);
  const direct = await core.arcRouteAvailable(c, null);
  console.log(`  info  LI.FI direct route into Arc: ${direct ? "YES — router auto will use it" : "not yet (CCTP path in use)"}`);
}

console.log(`\n${failures === 0 ? "ALL GOOD" : failures + " check(s) failed"}`);
process.exit(failures ? 1 : 0);
