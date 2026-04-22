# tao-tools

Quick forensic UI for TAO staking analysis. Fetches on-chain data directly from a Subtensor archive RPC and visualizes balance, pool yield, and stake operations per (hotkey, subnet) position.

## Run

```bash
npm install
npm run dev
# → http://localhost:5173
```

## My stake tab

Form inputs:
- **RPC** — defaults to `wss://subtensor-archive.app.minesight.co.uk`. Override with your own archive node.
- **Coldkey** — SS58 address to audit.
- **From / To** — block number OR date. Date converts to block using current head (12s/block).
- **Samples per day** — balance sample resolution. 10 = every ~2.4h.
- **Concurrency** — parallel RPC calls.

On submit: connects, probes positions, samples balance/PSV at each point, runs binary search for stake-op blocks, resolves events, and renders:
1. **Per-position balance charts** with green/red vertical markers at each user stake-op; clickable block numbers link to polkadot.js explorer.
2. **Combined PSV chart** (indexed to 1.0 at start) showing pure pool yield across validators.

## Build

```bash
npm run build       # dist/ ready for static hosting
npm run preview     # preview production build
```
