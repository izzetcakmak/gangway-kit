// Does the transaction JSON the kit builds for a Sui wallet still equal what the real SDK prints?
//
//   npm i --no-save @mysten/sui     (the kit itself never depends on it)
//   node test/sui-parity.mjs            compare the kit with test/fixtures/sui-burn.json, and the fixture with the installed SDK
//   node test/sui-parity.mjs --write    rewrite the fixture from the installed SDK (after an SDK upgrade; review the diff)
//
// The unit tests already compare the kit with the fixture offline. This script is the other half: the fixture against the SDK.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Kit = require("../gangway-kit.js");
let Transaction, pkg;
try { ({ Transaction } = await import("@mysten/sui/transactions")); }
catch { console.log("@mysten/sui is not installed: npm i --no-save @mysten/sui"); process.exit(2); }
// the SDK does not export its package.json: walk up from a file it does export
try {
  let dir = require("node:path").dirname(require.resolve("@mysten/sui/transactions"));
  while (!fs.existsSync(dir + "/package.json") || JSON.parse(fs.readFileSync(dir + "/package.json", "utf8")).name !== "@mysten/sui") dir = require("node:path").dirname(dir);
  pkg = JSON.parse(fs.readFileSync(dir + "/package.json", "utf8"));
} catch { pkg = { version: "(unknown)" }; }

const FIXTURE = new URL("./fixtures/sui-burn.json", import.meta.url);
const WRITE = process.argv.includes("--write");
const cc = Kit.SUI_CCTP.mainnet, USDC = Kit.SOURCES.mainnet.find((c) => c.key === "sui").usdc;
const SENDER = "0x" + "5e".repeat(32), MINT = Kit.utils.toBytes32Address("0x9ffb87dc69eeeab8f1cbb8646de6a7f69a284da6"), MAXFEE = 35600n, HOOK = Kit.FORWARD_HOOK;
const C1 = "0x" + "a1".repeat(32), C2 = "0x" + "b2".repeat(32);
const cases = [
  { name: "one coin covers the amount: split it", coins: [{ id: C1, balance: 5_000_000n }, { id: C2, balance: 1_000_000n }], addressBalance: 0n, amount: 3_000_000n },
  { name: "address balance only: redeem exactly the amount", coins: [], addressBalance: 10_000_000n, amount: 2_000_000n },
  { name: "coins plus address balance: merge, redeem the rest, split", coins: [{ id: C1, balance: 1_500_000n }, { id: C2, balance: 700_000n }], addressBalance: 5_000_000n, amount: 4_000_000n },
  { name: "a coin equal to the amount is burned whole", coins: [{ id: C1, balance: 2_000_000n }], addressBalance: 0n, amount: 2_000_000n },
  { name: "several coins, no address balance needed", coins: [{ id: C1, balance: 2_000_000n }, { id: C2, balance: 3_000_000n }], addressBalance: 0n, amount: 4_500_000n },
];

// the same burns written against the SDK, in the order the kit performs them
function viaSdk(c) {
  const tx = new Transaction(); tx.setSender(SENDER);
  const owned = [...c.coins].sort((a, b) => (a.balance === b.balance ? 0 : a.balance < b.balance ? 1 : -1));
  let have = 0n; const picked = []; for (const x of owned) { if (have >= c.amount) break; picked.push(x); have += x.balance; }
  const topUp = c.amount > have ? c.amount - have : 0n; let coin;
  const redeem = (n) => tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: [USDC], arguments: [tx.withdrawal({ amount: n, type: USDC })] })[0];
  if (picked.length) {
    const primary = tx.object(picked[0].id), rest = picked.slice(1).map((x) => tx.object(x.id));
    const sources = topUp > 0n ? [...rest, redeem(topUp)] : rest;
    if (sources.length) tx.mergeCoins(primary, sources);
    coin = have + topUp === c.amount ? primary : tx.splitCoins(primary, [tx.pure.u64(c.amount)])[0];
  } else coin = redeem(c.amount);
  const [receipt, ret] = tx.moveCall({ target: `${cc.tokenMessengerPkg}::deposit_for_burn::deposit_for_burn`, typeArguments: [USDC],
    arguments: [coin, tx.pure.u32(26), tx.pure.address(MINT), tx.pure.address("0x0"), tx.pure.u256(MAXFEE), tx.pure.u32(2000), tx.pure.vector("u8", Array.from(Buffer.from(HOOK.slice(2), "hex"))), tx.object(cc.tokenMessenger)] });
  const [ticket] = tx.moveCall({ target: `${cc.handlerPkg}::handler::burn`, arguments: [tx.object(cc.handler), receipt, ret, tx.object("0x403"), tx.object(cc.treasury)] });
  tx.moveCall({ target: `${cc.tokenMessengerPkg}::deposit_for_burn::complete_burn`, typeArguments: [USDC, `${cc.handlerPkg}::handler::Auth`], arguments: [ticket, tx.object(cc.tokenMessenger), tx.object(cc.messageTransmitter)] });
  return tx;
}
const sdkOut = [];
for (const c of cases) sdkOut.push({ name: c.name, input: { coins: c.coins.map((x) => ({ id: x.id, balance: x.balance.toString() })), addressBalance: c.addressBalance.toString(), amount: c.amount.toString() }, expected: JSON.parse(await viaSdk(c).toJSON()) });
if (WRITE) {
  fs.writeFileSync(FIXTURE, JSON.stringify({ generatedWith: "@mysten/sui " + pkg.version, note: "regenerate with test/sui-parity.mjs --write after upgrading the SDK; the kit must keep matching this output", sender: SENDER, mintRecipient: MINT, maxFee: MAXFEE.toString(), cases: sdkOut }, null, 1) + "\n");
  console.log("wrote " + sdkOut.length + " cases from @mysten/sui " + pkg.version);
}
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
let bad = 0;
for (const [i, c] of cases.entries()) {
  const kit = JSON.parse(Kit.utils.buildSuiBurnTx({ cctp: cc, usdcType: USDC, sender: SENDER, amount: c.amount, coins: c.coins, addressBalance: c.addressBalance, destinationDomain: 26, mintRecipient: MINT, maxFee: MAXFEE, minFinalityThreshold: 2000, hookData: HOOK }));
  const kitVsSdk = JSON.stringify(kit) === JSON.stringify(sdkOut[i].expected), fixVsSdk = JSON.stringify(fixture.cases[i].expected) === JSON.stringify(sdkOut[i].expected);
  if (!kitVsSdk || !fixVsSdk) bad++;
  console.log((kitVsSdk && fixVsSdk ? "ok   " : "FAIL ") + c.name + (kitVsSdk ? "" : "  [kit differs from the SDK]") + (fixVsSdk ? "" : "  [fixture is stale: run with --write]"));
}
console.log(bad ? bad + " case(s) differ (SDK " + pkg.version + ")" : "kit == fixture == @mysten/sui " + pkg.version);
process.exit(bad ? 1 : 0);
