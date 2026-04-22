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

Vite reads `BASE_PATH` from the environment. Defaults to `/` locally. The deploy workflow hardcodes `/tao-tools/` for the GitHub Pages project site.

## CI / deploy

Two workflows in `.github/workflows/`:

- **`check-build.yml`** — runs on every push and PR: prettier check → vitest → vite build (which also runs `tsc -b`).
- **`deploy.yml`** — runs on push to `main` (and manual `workflow_dispatch`): builds with `BASE_PATH=/tao-tools/` and publishes `dist/` via GitHub Pages.

Node.js version is pinned by `.nvmrc` (currently 22).

### One-time setup after first push

1. Go to repo **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main` (or trigger the deploy workflow manually) — the app will be live at `https://evgeny-s.github.io/tao-tools/`.
