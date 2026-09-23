# GangWay Kit

`gangway-kit` on npm-style installs; the browser global is `GangWayKit` (and `ArcBridgeKit`, its first name, still works). Formerly published as arc-bridge-kit.

Drop-in **"pay with anything, land USDC on Arc, then buy"** widget and headless engine.
Swaps by **LI.FI**, bridging by **Circle CCTP V2 + Forwarding Service**, an optional last leg on Arc.

- **Pay with any token** the user holds (ETH, cbBTC, USDT, ...): LI.FI swaps it into USDC on the
  source chain first. Pay with USDC and the swap leg simply disappears.
- **One bridge signature** on the source chain. Circle's Forwarding Service submits the mint on
  Arc itself, so the user needs **no gas on Arc**.
- **LI.FI-ready for Arc**: `router: "auto"` probes LI.FI for a direct route into Arc on every
  quote; the day LI.FI opens Arc, any-token → USDC-on-Arc becomes one LI.FI transaction and CCTP
  stays as the fallback. Nothing to redeploy.
- **Fast Transfer** (~20 s) or **Standard** (no protocol fee, source-chain finality).
- **15 mainnet / 13 testnet source chains**: Base, Ethereum, Arbitrum, OP, Polygon, Avalanche,
  Unichain, Linea, World Chain, Sonic, Monad, Sei, HyperEVM, Ink (+ their testnets), and **Solana**.
- **Solana, no Solana library**: SOL or any Solana token becomes USDC on Arc in one LI.FI route
  (Relay underneath; ~1 s). The user's Wallet Standard wallet (Phantom, Solflare, Backpack…) signs
  the bytes LI.FI returns, so nothing from `@solana/*` is bundled. See "Solana" below.
- **Resumable**: in-flight transfers survive a page refresh; if the forwarder is late the
  attested message can be minted manually from the user's wallet.
- **Zero dependencies** besides ethers v6, which you already load. One file, ~30 KB, classic
  `<script>` or CommonJS. Themes itself from the host's CSS variables.

Every contract address, domain ID and RPC in the kit is verified live by `npm run preflight`
(see below). Verified 13 Sep 2026 against Circle docs + on-chain reads.

## Quick start

```html
<script src="vendor/ethers.umd.min.js"></script>
<script src="gangway-kit.js"></script>
<div id="bridge"></div>
<script>
  const kit = ArcBridgeKit.mount(document.getElementById("bridge"), {
    ethers: window.ethers,
    network: "testnet",                  // "mainnet" once Arc mainnet RPCs are public
    getProvider: () => window.ethereum,  // any EIP-1193 provider (MetaMask, Web3Auth, ...)
    onMinted: (t) => console.log("arrived on Arc:", t.received, "minor units"),
  });
</script>
```

Open `demo/index.html` through any static server (`python -m http.server 4173`) to try it.

## How a transfer flows

```
source chain                                  Circle                       Arc
────────────                                  ──────                       ───
[LI.FI swap: any token → USDC]   (only when paying with something else)
approve USDC → TokenMessengerV2
depositForBurnWithHook(
   amount, 26, recipient,
   USDC, 0x0, maxFee,
   1000 | 2000,
   "cctp-forward")   ───►   attestation (Iris)  ───►  Forwarding Service calls
                             forwardState              receiveMessage → native USDC
                                                        lands at recipient
```

The widget polls Iris for the attestation, then asks Arc itself whether the message nonce has
been consumed (`MessageTransmitterV2.usedNonces`), which is the ground truth regardless of what
the forwarder reports; Iris's `forwardState`/`destinationMintTxHash` and the recipient's balance are
secondary signals. An RPC that does not answer counts as "unknown" and keeps the poll going:
"late" is only declared once Arc has confirmed the nonce is still unused. The manual mint checks
the same nonce first, so it never sends a `receiveMessage` that would only revert. With `router: "lifi"` (or
`"auto"` when it wins the comparison) the middle column is LI.FI's route: `/v1/status` is polled
and, because these routes are CCTP underneath, Circle's attestation and Arc's nonce are checked
too, so a late third-party executor can be replaced by the user's own mint (Mint on Arc).

A swap that went through while the page was closed is not lost: the transfer shows up as
`swapped` in the in-flight list with a **Bridge now** button (`core.continueBridge`).

## Options (`ArcBridgeKit.mount(el, opts)`)

| option | type | notes |
|---|---|---|
| `ethers` | ethers v6 namespace | required |
| `network` | `"testnet"` \| `"mainnet"` | default testnet |
| `getProvider` / `provider` | EIP-1193 | MetaMask, Web3Auth's `provider`, WalletConnect... |
| `onConnect` | `async () => address` | plug the host's own connect flow instead of `eth_requestAccounts` |
| `switchChain` | `async (chainCfg) => void` | custom chain switching (Web3Auth `addChain`/`switchChain`) |
| `recipient` | `string \| () => string` | default mint recipient (defaults to connected account) |
| `arcRpcs` / `arcExplorer` | `string[]` / `string` | override Arc read RPCs (e.g. from your config.js) |
| `sources` | `string[]` | restrict the chain list, e.g. `["base","arbitrum","ethereum"]` |
| `defaultSource`, `defaultAmount` | | pre-fill |
| `minAmount` | BigInt minor units | default 1 USDC |
| `payWith` | `"any"` \| `"usdc"` | `"any"` shows the LI.FI shortlist (native, USDC, WETH, USDT, DAI, cbBTC, ...); `"usdc"` hides the swap leg |
| `router` | `"auto"` \| `"cctp"` \| `"lifi"` | `"auto"` prices both and takes LI.FI's route into Arc only when it lands at least as much USDC (within 0.1%) and is no slower than 1.5× CCTP; otherwise swap+CCTP. `"cctp"` pins the house path |
| `slippage` | number | swap slippage fraction, default `0.005` |
| `lifiApiKey` | string | optional LI.FI partner key (higher rate limits) |
| `lifiIntegrator` | string | integrator string registered at portal.li.fi (default `"arc-bridge-kit"`, the kit's first name) |
| `lifiFee` | number | integrator fee on LI.FI swaps as a fraction, e.g. `0.0025` = 0.25%; paid to the integrator's fee wallet at execution, shown in the quote |
| `feeLabel` | string | how the fee row names the recipient (default "this site") |
| `feeHeadroom` | BigInt | `maxFee = quoted fee × headroom`, default `2n` (cap only, not charged) |
| `onEvent` | `(evt) => void` | every step: `switching, planning, approving, approve_sent, approved, burning, burn_sent, burned, attesting, attested, forwarding, minted, stalled, error` |
| `onMinted` | `(transfer) => void` | fired when USDC lands on Arc |
| `solanaWallet` | Wallet Standard wallet \| `() => wallet` | which wallet signs on Solana; by default the wallets installed in the browser are discovered |
| `title` | string | header text |

Returned handle: `{ core, account, solanaAccount, setAccount(a), setSource(key), setAmount(v), refresh(), destroy() }`.

## Solana

Solana is a source like any other in the list, with three differences:

- **One route, always LI.FI.** There is no CCTP leg on Solana in this kit (Circle's program there
  is not the EVM contracts the kit talks to). Whatever `router` says, a payment from Solana is a
  single LI.FI route into Arc; verified live on 23 Sep 2026, LI.FI routes it over Relay in about
  a second: 0.1 SOL → ~11.3 USDC, 1M BONK → ~3.4 USDC, USDC → USDC at ~0.5%.
- **The Solana wallet signs.** The widget discovers Wallet Standard wallets (`wallet-standard:*`
  events), reconnects silently one that already trusts the site, and signs the serialized
  transaction LI.FI returns with `solana:signAndSendTransaction` (falling back to
  `solana:signTransaction` + `sendTransaction` over RPC). No Solana dependency ships.
- **The USDC lands at an EVM address.** The recipient is the connected EVM account, or the
  address typed into "send to another address". Phantom carries both an EVM and a Solana account,
  so a Phantom user needs nothing else; a Solana-only wallet needs an Arc address typed in.

Headless: `await core.connectSolana()` (or `connectSolana(wallet, { silent: true })`), then
`core.bridge({ source: "solana", payToken: Kit.SOL_NATIVE, amount, recipient })` and `track()` as
usual. Balances: `core.tokenBalance("solana", mintOrSOL_NATIVE, base58Owner)`.

## Bridge → swap on Arc (`destination`)

Give the widget a `destination` and it runs a second leg on Arc as soon as the USDC lands:
switch the wallet to Arc, build a transaction from the received amount, send it, track it.
That is how a launchpad turns "bridge" into "bridge and buy" with no extra contracts. USDC is
Arc's native token, so the freshly minted balance already covers gas and the buy.

```js
ArcBridgeKit.mount(el, {
  ethers, network: "testnet", getProvider: () => window.ethereum,
  destination: {
    label: "Buy $NOAH on anewone",         // step 5 in the stepper
    buttonLabel: "Buy $NOAH",              // retry button in the in-flight list
    doneLabel: "$NOAH was bought",         // success line
    auto: true,                            // prompt the wallet as soon as USDC lands
    build: async ({ received, signer, ethers }) => {
      const platform = new ethers.Contract(PLATFORM, ["function quoteBuy(address,uint256) view returns (uint256)", "function buy(address,uint256) payable"], signer);
      const value = received * 10n ** 12n - 10n ** 16n;      // 6-dec USDC -> 18-dec native, keep 0.01 for gas
      const minOut = (await platform.quoteBuy(TOKEN, value)) * 97n / 100n;
      return { to: PLATFORM, value, data: platform.interface.encodeFunctionData("buy", [TOKEN, minOut]) };
    },
  },
  onDestination: (t) => console.log("bought, tx", t.dest.tx),
});
```

The demo wires this to anewone's Arc Testnet launchpad: pick a token under "Then on Arc".
A transfer whose destination leg has not gone through stays in the in-flight list with a
retry button, also after a refresh. Headless: `core.runDestination(transfer, destination)`.

## Headless use

```js
const core = new ArcBridgeKit.ArcBridge({ ethers, network: "mainnet", provider: window.ethereum });
const plan = await core.plan({ source: "base", payToken: ArcBridgeKit.NATIVE, fromAmount: 10n ** 16n, fromAddress: me }); // 0.01 ETH
const tr = await core.bridge({ source: "base", payToken: ArcBridgeKit.NATIVE, amount: 10n ** 16n, recipient: me, onStep: console.log });
await core.track(tr, console.log);          // resolves when USDC is on Arc
// if track() returns status "stalled":  await core.manualMint(tr);
```

Works in Node too: pass an ethers `signer` already connected to the source chain instead of
`provider`, and a `storage` `{get,set}` if you don't want the in-memory default.

## Theming

The widget reads the host's tokens with fallbacks: `--accent`, `--surface`, `--surface-2`,
`--text`, `--dim`, `--faint`, `--border`, `--border-2`, `--red`, `--gold`, `--r-md`, `--r-sm`,
`--mono`. Override any `--abk-*` variable on the container for fine control.

## Scripts

```
npm test                 # unit tests (fee maths, encoding, chain tables, LI.FI helpers)
npm run preflight        # live read-only check of every testnet chain + Iris quotes (add --lifi for LI.FI lines)
npm run preflight:mainnet
```

## LI.FI rate limits (read this before shipping)

Without a key LI.FI allows about **200 requests per 2 hours per IP**; with a free partner key
from [portal.li.fi](https://portal.li.fi) it is 100–200 per minute. The engine is thrifty
(quotes cached 45 s, the Arc-route probe 30 min, a 429 pauses LI.FI calls for 10 min, the widget
only re-quotes when an input actually changed), but a busy page will still hit the keyless cap.

Two ways to use a key:

- `lifiApiKey: "…"` — sent as `x-lifi-api-key` from the browser. Fine for internal tools.
- `lifiApi: "https://your.site/api/lifi"` — point the kit at your own proxy that adds the key
  server-side. This repo ships one for Vercel (`api/lifi/[...path].js`, reads `LIFI_API_KEY`);
  the demo uses it automatically when the env var is set.

Paying with USDC never touches LI.FI, so the bridge keeps working even while rate-limited.

## Earning on the swap leg

LI.FI lets an integrator take a cut of every swap it routes: pass `lifiIntegrator` (the string
you registered at [portal.li.fi](https://portal.li.fi), with a fee wallet per chain) and
`lifiFee` (a fraction, `0.0025` = 0.25%). LI.FI deducts it from the user's input and forwards
it to your wallet when the swap executes; the widget shows it as its own row in the quote.
CCTP has no revenue share, so the bridge leg stays fee-free.

## Mainnet note

Arc mainnet (chain 5042, USDC `0x3600…0000`) went live on 16 Sep 2026 and is registered as
CCTP domain 26 on every EVM source chain; Circle quotes forwarded routes to it. The kit's
default Arc read RPC is `arc.drpc.org`; pass your own pool via `arcRpcs` / `arcExplorer`.

## Safety properties

- `mintRecipient` is validated as a 20-byte hex address before anything is signed. A typo
  here would not fail; it would mint USDC to an address nobody controls.
- The burn is refused when `maxFee >= amount` or the route has no forwarding quote.
- The approval is for the exact amount, never unlimited.
- Fees come from Circle's live API per transfer; nothing is hard-coded.
- The bridged amount after a swap is the **measured** USDC delta in the wallet, not the quote.
- LI.FI transactions are sent exactly as quoted (`to`, `data`, `value`, `gasLimit`); the kit never
  builds swap calldata itself.

MIT © izzetcakmak
