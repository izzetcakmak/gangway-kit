# Integrating arc-bridge-kit into anewone.xyz

anewone's frontend is a static `docs/index.html` with `vendor/ethers.umd.min.js`, `config.js`
(`window.ANEWONE_CONFIG`) and a Web3Auth "Continue with Google" wallet. The kit was built to
slot into exactly that.

## 1. Files

```
cp arc-bridge-kit.js  <anewone>/docs/vendor/arc-bridge-kit.js
```

Add to `PROVENANCE.md` in vendor: `arc-bridge-kit.js — github.com/izzetcakmak/arc-bridge-kit vX.Y.Z`.

## 2. Load it (after ethers and config.js)

```html
<script src="vendor/ethers.umd.min.js"></script>
<script src="config.js"></script>
<script src="vendor/arc-bridge-kit.js"></script>
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

## 6. Optional: "bridge-and-buy" later (Senaryo 2)

The engine exposes `hookData`-ready pieces (`ABI`, `CCTP`, `FORWARD_HOOK`). A follow-up can
replace the `cctp-forward` hook with a custom receiver contract on Arc that swaps the minted
USDC into a launchpad token in the same transaction. That is a separate contract + relayer
piece; the widget's UI and tracking stay the same.
