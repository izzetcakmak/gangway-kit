// Dry-run, on Sui mainnet, the exact transaction the kit would hand this account's wallet. Nothing is signed or sent.
//
//   npm i --no-save @mysten/sui
//   node test/sui-simulate.mjs <sui address> <usdc amount>        e.g. node test/sui-simulate.mjs 0x1234... 2.5
//
// The kit builds the JSON (utils.buildSuiBurnTx) from the account's real coin objects and address balance and Circle's live fee quote;
// the SDK then resolves it against Sui the way a wallet does, and Sui's GraphQL endpoint simulates the result. The account needs some SUI
// (the simulation selects gas like a wallet would). Exits 0 when the burn would succeed and emit Circle's DepositForBurn for Arc.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Kit = require("../gangway-kit.js");
let Transaction, SuiGraphQLClient;
try { ({ Transaction } = await import("@mysten/sui/transactions")); ({ SuiGraphQLClient } = await import("@mysten/sui/graphql")); }
catch { console.log("@mysten/sui is not installed: npm i --no-save @mysten/sui"); process.exit(2); }

const [owner, amountArg] = process.argv.slice(2);
if (!Kit.utils.isSuiAddress(owner) || !amountArg) { console.log("usage: node test/sui-simulate.mjs <sui address, 0x + 64 hex> <usdc amount>"); process.exit(2); }
const amount = Kit.utils.parseUsdc(amountArg);
const bridge = new Kit.ArcBridge({ ethers: { getAddress: (a) => a }, network: "mainnet", storage: { get: () => null, set() {} } });
const src = bridge.source("sui");

const [bal, coins, open, q] = await Promise.all([Kit.utils.suiBalance(src.rpcs, src.usdc, owner), Kit.utils.suiCoins(src.rpcs, src.usdc, owner), Kit.utils.suiCctpOpen(src.rpcs, Kit.SUI_CCTP.mainnet), bridge.quote(src, amount, "standard")]);
if (!bal || !coins) { console.log("could not read the account from", src.rpcs[0]); process.exit(1); }
console.log("account", owner);
console.log("USDC: " + Kit.utils.formatUsdc(bal.total) + " (" + coins.length + " coin objects = " + Kit.utils.formatUsdc(bal.coin) + ", address balance " + Kit.utils.formatUsdc(bal.address) + ")");
console.log("Circle token messenger on Sui: " + (open === false ? "PAUSED" : open ? "open" : "state unreadable"));
if (!q.available) { console.log("no forwarded quote:", q.reason); process.exit(1); }
console.log("fee quote: protocol " + Kit.utils.formatUsdc(q.protocolFee, 4) + " + forwarding " + Kit.utils.formatUsdc(q.forwardFee, 4) + " USDC, maxFee " + q.maxFee + ", you receive about " + Kit.utils.formatUsdc(q.expectedReceive, 4) + " on Arc");

const recipient = "0x" + "0".repeat(24) + "9ffb87dc69eeeab8f1cbb8646de6a7f69a284da6";   // an Arc address for the dry run; nothing lands anywhere
let json;
try {
  json = Kit.utils.buildSuiBurnTx({ cctp: Kit.SUI_CCTP.mainnet, usdcType: src.usdc, sender: owner, amount, coins, addressBalance: bal.address,
    destinationDomain: Kit.ARC_DOMAIN, mintRecipient: recipient, maxFee: q.maxFee, minFinalityThreshold: q.minFinalityThreshold, hookData: Kit.FORWARD_HOOK });
} catch (e) { console.log("the kit would refuse this burn: " + e.message); process.exit(1); }
const t = JSON.parse(json);
console.log("transaction: " + t.commands.length + " commands (" + t.commands.map((c) => Object.keys(c)[0] + (c.MoveCall ? ":" + c.MoveCall.function : "")).join(", ") + ")");

const client = new SuiGraphQLClient({ url: src.rpcs[0], network: "mainnet" });
const bytes = Buffer.from(await Transaction.from(json).build({ client })).toString("base64");   // what a wallet does with the JSON
const res = await fetch(src.rpcs[0], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
  query: "query($tx: JSON!){ simulateTransaction(transaction: $tx, checksEnabled: true){ effects { status executionError { message } gasEffects { gasSummary { computationCost storageCost storageRebate } } events { nodes { contents { type { repr } json } } } } } }",
  variables: { tx: { bcs: { value: bytes } } } }) });
const j = await res.json();
const e = j.data && j.data.simulateTransaction && j.data.simulateTransaction.effects;
if (!e) { console.log("simulation did not run:", JSON.stringify(j.errors || j).slice(0, 300)); process.exit(1); }
console.log("simulation: " + e.status + (e.executionError ? " - " + e.executionError.message : ""));
const g = e.gasEffects.gasSummary;
console.log("network fee: computation " + g.computationCost + " + storage " + g.storageCost + " - rebate " + g.storageRebate + " MIST (net " + ((Number(g.computationCost) + Number(g.storageCost) - Number(g.storageRebate)) / 1e9).toFixed(6) + " SUI)");
const ev = e.events.nodes.map((n) => n.contents).find((c) => c.type.repr.endsWith("::deposit_for_burn::DepositForBurn"));
if (ev) console.log("DepositForBurn: " + Kit.utils.formatUsdc(ev.json.amount) + " USDC to domain " + ev.json.destination_domain + ", maxFee " + ev.json.max_fee + ", finality " + ev.json.min_finality_threshold + ", hook " + Buffer.from(ev.json.hook_data, "base64").toString("utf8").replace(/[^ -~]/g, ""));
process.exit(e.status === "SUCCESS" && ev && ev.json.destination_domain === 26 ? 0 : 1);
