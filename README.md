# BSC Mint Radar

Live NFT/contract intelligence API for **BNB Smart Chain (chainId 56)**, monetized with
**x402 USDC micropayments on Base** via the Circle Gateway — ready for listing on the
Circle Agent Marketplace (agents.circle.com).

Paid per request in USDC; the agent pays programmatically, no API keys, no accounts.

## Endpoints

| Route | Price | Description |
|---|---|---|
| `GET /health` | free | Status, version, chain, price |
| `GET /openapi.json` | free | OpenAPI 3.1 spec for the two paid routes (with `x-payment-info`) |
| `GET /v1/inspect?address=0x…` | **$0.001 USDC** (x402) | Full report for one contract |
| `GET /v1/batch?addresses=0x…,0x…` | **$0.001 USDC** (x402) | Same for up to 10 addresses (max 10, concurrency-limited) |

Report fields: `address, name, symbol, chainId(56), totalSupply, maxSupply, freeSlots,
mintPriceWei, mintPriceBNB, priceFunction, isFreeMint, sourcifyMatch (exact/match/partial/none),
safety { hasOwner, ownerCanPause } (or "unknown" when ABI unavailable), fetchedAt`.
Results are cached 10 minutes in memory (`X-Cache: hit|miss` response header on inspect).

## Payment (x402 on Base)

- Official SDK: `@circle-fin/x402-batching` + `@x402/core` + `@x402/evm`.
- Routes are wrapped with `createGatewayMiddleware({ sellerAddress, networks: 'eip155:8453' })`
  and `gateway.require('$0.001')` — settlement via the Circle facilitator / Circle Gateway
  (gasless batched payments, Base USDC).
- Payout address: `0xAe9ad223a1D4e9ADecFd3BD8363f1b8Ea4e0d512` (override with `SELLER_ADDRESS`).
- Unpaid requests get **HTTP 402** with a machine-readable x402 body
  (`{ x402Version: 2, resource, accepts: [...] }`). The SDK places this payload in the
  base64url `PAYMENT-REQUIRED` header; this server mirrors it into the JSON body too
  (see `src/server.mjs`), so both header- and body-parsing clients work.

Buyers pay with any x402/Gateway client, e.g.:

```js
import { GatewayClient } from '@circle-fin/x402-batching/client';
const client = new GatewayClient({ chain: 'base', privateKey: process.env.BUYER_KEY });
await client.deposit('1.00');            // one-time USDC deposit into Gateway
const res = await client.pay('https://YOUR-HOST/v1/inspect?address=0x…');
```

## Run

```bash
npm install
npm start            # listens on :3000 (PORT env to override)
npm test             # node --test, 13 tests, mock RPC via fixtures — no network needed
```

Config lives in `src/config.json`; env overrides: `PORT`, `SELLER_ADDRESS`.
No secrets are read or stored — the seller address is public, and there are no keys server-side.

## Data sources

- BSC JSON-RPC (`eth_call`, failover across both configured URLs):
  - `https://bsc-dataseed.binance.org`, fallback `https://bsc-rpc.publicnode.com`
  - name(), symbol(), totalSupply(); maxSupply() → `maxSupply, MAX_SUPPLY, hardCap, maximum`;
    price → `cost, price, mintPrice, MINT_PRICE, publicPrice, salePrice` (first hit wins; absent → null)
- Sourcify v2 API: `https://sourcify.dev/server/v2/contract/56/{address}?fields=abi`
  (the old `check-all-by-addresses` v1 endpoint was retired — this service uses v2 and
  pulls the ABI from the same call for the safety flags).

## Deploy

### Cloudflare Workers (branch `workers` — primary target)

`src/worker.mjs` is a Hono app with the x402 v2 payment gate (`@x402/hono` +
`@x402/evm` ExactEvmScheme, Circle Facilitator Service). Same routes and price
as the Express version.

```bash
# 1. Auth (one-time; interactive login OR CI token)
npx wrangler login
#    or: CLOUDFLARE_API_TOKEN=<token with Workers Scripts:Edit> in CI

# 2. Secrets (NEVER in the repo / .env.example)
npx wrangler secret put CIRCLE_API_KEY   # Circle Facilitator verify/settle auth

# 3. Deploy (config in wrangler.jsonc: name bsc-mint-radar, main src/worker.mjs)
npx wrangler deploy
```

Differences vs. the Express version (main):

| | Express (`main`) | Workers (`workers`) |
|---|---|---|
| Runtime | Node 20+, Express 5 | V8 isolate, Hono fetch-handler |
| x402 SDK | `@circle-fin/x402-batching` Gateway middleware | `@x402/hono` + `@x402/evm` (x402 v2) |
| Facilitator | Circle Gateway (`gateway-api.circle.com`) | Circle Facilitator Service (`api.circle.com/v1/facilitator/x402`, needs `CIRCLE_API_KEY`) |
| Config | `src/config.json` + env | baked into `src/worker.mjs` + `wrangler.jsonc` vars/secrets |
| Cache | in-process Map, 10 min | module-level Map, 10 min (resets on isolate restart — still a warm cache) |
| Tests | `node --test` (13 tests) | `npm run test:workers` — vitest, 11 tests via `app.request()` |

Note: `.env.example` stays secret-free; all Workers secrets go through
`wrangler secret put` only.

### Fly.io (Express fallback, `main` branch only)
```bash
# minimal fly.toml + Dockerfile:
#   FROM node:22-alpine; WORKDIR /app; COPY . .; RUN npm ci --omit=dev; CMD ["node","src/server.mjs"]
fly launch --no-deploy && fly deploy
fly secrets set SELLER_ADDRESS=0xAe9ad223a1D4e9ADecFd3BD8363f1b8Ea4e0d512
```

## Marketplace listing checklist

1. `GET /openapi.json` must be publicly reachable — agents use it to discover the two paid
   paths (both declare `402` responses and `x-payment-info`).
2. Keep `/health` free — marketplace health checks don't pay.
3. Price is flat `$0.001` per call for both endpoints (`config.json:price`).

## Layout

```
src/server.mjs    Express app, x402 gateway wiring, routes
src/rpc.mjs       JSON-RPC caller (failover), ABI decode helpers (viem)
src/inspect.mjs   Contract inspection, Sourcify v2, TTL cache, bounded-concurrency pool
src/openapi.mjs   OpenAPI 3.1 document
src/config.json   Defaults (price, payTo, RPCs, cache TTL)
test/             13 tests incl. fixtures/rpc-fixtures.json (mock RPC data)
```
