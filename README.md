# arc-bridge-kit

Drop-in **"Bridge USDC to Arc"** widget and headless engine, built on **Circle CCTP V2 + Forwarding Service**.

- **One signature** on the source chain (plus a one-time USDC approval). Circle's Forwarding
  Service submits the mint on Arc itself, so the user needs **no gas on Arc**.
- **Fast Transfer** (~20 s) or **Standard** (no protocol fee, source-chain finality).
- **14 mainnet / 13 testnet source chains**: Base, Ethereum, Arbitrum, OP, Polygon, Avalanche,
  Unichain, Linea, World Chain, Sonic, Monad, Sei, HyperEVM, Ink (+ their testnets).
- **Resumable**: in-flight transfers survive a page refresh; if the forwarder is late the
  attested message can be minted manually from the user's wallet.
- **Zero dependencies** besides ethers v6, which you already load. One file, ~30 KB, classic
  `<script>` or CommonJS. Themes itself from the host's CSS variables.

Every contract address, domain ID and RPC in the kit is verified live by `npm run preflight`
(see below). Verified 13 Sep 2026 against Circle docs + on-chain reads.

## Quick start

```html
<script src="vendor/ethers.umd.min.js"></script>
<script src="arc-bridge-kit.js"></script>
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
source chain                 Circle                          Arc
────────────                 ──────                          ───
approve USDC → TokenMessengerV2
depositForBurnWithHook(
   amount, 26, recipient,
   USDC, 0x0, maxFee,
   1000 | 2000,
   "cctp-forward")   ───►   attestation (Iris)  ───►  Forwarding Service calls
                             forwardState              receiveMessage → native USDC
                                                        lands at recipient
```

The widget polls Iris for the attestation and then the recipient's USDC balance on Arc,
which is the ground truth regardless of what the forwarder reports.

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
| `feeHeadroom` | BigInt | `maxFee = quoted fee × headroom`, default `2n` (cap only, not charged) |
| `onEvent` | `(evt) => void` | every step: `switching, quoting, approving, approve_sent, approved, burning, burn_sent, burned, attesting, attested, forwarding, minted, stalled, error` |
| `onMinted` | `(transfer) => void` | fired when USDC lands on Arc |
| `title` | string | header text |

Returned handle: `{ core, account, setAccount(a), setSource(key), setAmount(v), refresh(), destroy() }`.

## Headless use

```js
const core = new ArcBridgeKit.ArcBridge({ ethers, network: "mainnet", provider: window.ethereum });
const quote = await core.quote("base", ArcBridgeKit.utils.parseUsdc("25"), "fast");
const tr = await core.bridge({ source: "base", amount: quote.amount, recipient: "0x…", onStep: console.log });
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
npm test                 # unit tests (fee maths, encoding, chain tables)
npm run preflight        # live read-only check of every testnet chain + Iris quotes
npm run preflight:mainnet
```

## Mainnet note

Arc mainnet (chain 5042, USDC `0x3600…0000`) is already registered as CCTP domain 26 on
every source chain and Circle quotes forwarded routes to it today. The kit ships without
Arc mainnet RPC/explorer URLs because none were public at the time of writing; pass them via
`arcRpcs` / `arcExplorer` (or edit `ARC.mainnet`) when they are.

## Safety properties

- `mintRecipient` is validated as a 20-byte hex address before anything is signed. A typo
  here would not fail; it would mint USDC to an address nobody controls.
- The burn is refused when `maxFee >= amount` or the route has no forwarding quote.
- The approval is for the exact amount, never unlimited.
- Fees come from Circle's live API per transfer; nothing is hard-coded.

MIT © izzetcakmak
