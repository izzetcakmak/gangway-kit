# Integrating gangway-kit into anewone.xyz

anewone's frontend is a static `docs/index.html` with `vendor/ethers.umd.min.js`, `config.js`
(`window.ANEWONE_CONFIG`) and a Web3Auth "Continue with Google" wallet. The kit was built to
slot into exactly that.

## 1. Files

```
cp gangway-kit.js  <anewone>/docs/vendor/gangway-kit.js
```

Add to `PROVENANCE.md` in vendor: `gangway-kit.js — github.com/izzetcakmak/gangway-kit vX.Y.Z`.

## 2. Load it (after ethers and config.js)

```html
<script src="vendor/ethers.umd.min.js"></script>
<script src="config.js"></script>
<script src="vendor/gangway-kit.js"></script>
```

## 3. Mount

A natural place is the trade panel / wallet drawer: "Need USDC on Arc? Bridge from Base…".

```js
const cfg = window.ANEWONE_CONFIG;
const net = cfg.mainnet.live ? "mainnet" : "testnet";
const arcCfg = cfg[net];

const bridgeKit = ArcBridgeKit.mount(document.getElementById("bridge-panel"), {
  ethers: window.ethers,
  network: net,
  // whatever anewone already uses as its EIP-1193 provider:
  //   MetaMask / injected: window.ethereum
  //   Web3Auth:            web3auth.provider
  getProvider: () => currentProvider(),
  onConnect: async () => { await connectWallet(); return currentAccount(); },   // reuse anewone's flow
  recipient: () => currentAccount(),
  arcRpcs: (arcCfg.rpcs || [arcCfg.rpc]).map((r) => (typeof r === "string" ? r : r.url)),
  arcExplorer: arcCfg.explorer,
  sources: net === "mainnet"
    ? ["base", "ethereum", "arbitrum", "optimism", "polygon", "avalanche", "unichain", "linea", "worldchain", "sonic", "monad", "sei", "hyperevm", "ink"]
    : ["base-sepolia", "sepolia", "arbitrum-sepolia", "optimism-sepolia", "avalanche-fuji", "polygon-amoy"],
  defaultSource: net === "mainnet" ? "base" : "base-sepolia",
  onMinted: (t) => {
    refreshArcBalance();               // anewone's own balance refresh
    toast(`${ArcBridgeKit.utils.formatUsdc(t.received || t.amount)} USDC arrived on Arc`);
  },
  onEvent: (e) => track("bridge_" + e.type),   // analytics hook, optional
});
```

Keep the widget mounted; it resumes in-flight transfers from `localStorage` after a refresh.
When the wallet changes, call `bridgeKit.setAccount(addr)`.

## 4. Web3Auth chain switching

Web3Auth's embedded wallet does not honour `wallet_switchEthereumChain` from arbitrary chains
unless the chain was added. Pass a `switchChain` that uses the Web3Auth instance:

```js
switchChain: async (chain) => {
  const hex = "0x" + chain.chainId.toString(16);
  try { await web3auth.switchChain({ chainId: hex }); }
  catch {
    await web3auth.addChain({
      chainNamespace: "eip155", chainId: hex, rpcTarget: chain.rpcs[0],
      displayName: chain.name, blockExplorerUrl: chain.explorer,
      ticker: chain.native.symbol, tickerName: chain.native.name,
    });
    await web3auth.switchChain({ chainId: hex });
  }
},
```

For injected wallets (MetaMask) leave `switchChain` undefined; the kit adds/switches itself.

## 5. Mainnet flip

`monitor/scan.mjs` already rewrites `cfg.mainnet` when Arc mainnet is detected. Nothing else
is needed: `net` becomes `"mainnet"`, the kit reads the mainnet CCTP set, and the Arc read
RPCs come from `cfg.mainnet.rpcs`. Circle already quotes forwarded routes into domain 26 on
mainnet (verified 13 Sep 2026 with `npm run preflight:mainnet`).

## 6. Bridge-and-buy: pass a `destination`

On a token page, mount the widget with a `destination` that buys the current token with the
bridged USDC. The kit switches the wallet to Arc, prompts one more signature and tracks it.

```js
destination: {
  label: `Buy $${currentSymbol} on anewone`,
  buttonLabel: `Buy $${currentSymbol}`,
  doneLabel: `$${currentSymbol} was bought`,
  build: async ({ received, signer, ethers }) => {
    const c = platform.connect(signer);                       // anewone's ethers.Contract
    const fee = await signer.provider.getFeeData();
    const gasPrice = fee.maxFeePerGas || fee.gasPrice || 0n;
    const reserve = gasPrice > 0n ? gasPrice * 400000n * 2n : 10n ** 16n;
    const value = received * 10n ** 12n - reserve;            // 6-dec -> native 18-dec, keep gas
    const q = await c.quoteBuy(currentToken, value);
    return { to: platform.target, value, data: c.interface.encodeFunctionData("buy", [currentToken, applySlip(q)]) };
  },
},
onDestination: () => refreshTokenPanel(),
```

The anti-snipe cap (`ANTI_SNIPE_MAX` for the first blocks after creation) and a graduated
curve both revert `buy`; `quoteBuy` already reverts on graduated curves, so the error shows
before the wallet is opened. Keep `recipient` as the connected wallet for this flow — the
buyer must hold the minted USDC.

## 7. Paying with something other than USDC (LI.FI)

Nothing to configure: with the default `payWith: "any"` the amount field gets a token menu
(native coin, USDC, then WETH/USDT/DAI/cbBTC/... as LI.FI lists them on that chain). A non-USDC
choice adds a "Swap to USDC" step in front of the bridge. Works on Base Sepolia today (LI.FI
quotes ETH → USDC there), so the whole ETH → USDC → Arc → $NOAH chain can be rehearsed on testnet.
When LI.FI opens routes into Arc, `router: "auto"` (default) turns the swap+bridge into one LI.FI
transaction by itself.

**Revenue on swaps.** The portal.li.fi integration is "A New One", string `a-new-one`, 25 bps,
fee wallet = the main wallet. Mount with `lifiIntegrator: "a-new-one", lifiFee: net === "mainnet" ? 0.0025 : 0`.
The string must match the portal exactly; with a wrong one LI.FI refuses fee quotes and the kit
silently falls back to fee-less swaps.
0.25% of every non-USDC payment lands in that wallet on the source chain, per chain and token.

**Rate limits are the one thing to set up.** Keyless LI.FI is ~200 requests / 2 h per visitor IP,
which a launchpad page burns through fast. anewone is on Vercel, so copy `api/lifi/[...path].js`
from the kit repo into anewone's `api/` folder, set `LIFI_API_KEY` in the Vercel project (key from
portal.li.fi, free), and mount with `lifiApi: location.origin + "/api/lifi"`. The key stays on the
server; the browser only ever sees anewone.xyz.

## 8. Later: atomic mint+buy (custom hook)

The engine exposes `hookData`-ready pieces (`ABI`, `CCTP`, `FORWARD_HOOK`). A follow-up can
replace the `cctp-forward` hook with a custom receiver contract on Arc that swaps the minted
USDC into a launchpad token in the same transaction. That is a separate contract + relayer
piece; the widget's UI and tracking stay the same.
