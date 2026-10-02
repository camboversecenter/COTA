# COTA: Nokor Pass reference implementation

COTA is the open-source reference implementation of **Nokor Pass** and **Nokor Point**, maintained by the CamboVerse Center at the National University of Management.

Nokor Pass is one pass for everyone in Cambodia. A visitor receives it at immigration. It is used to pay in riel or dollars, to enter heritage sites, and to convert any remaining balance back to cash on departure. Nokor Point is a giftable reward with no guaranteed value. Its job is to measure what promotion budgets cannot: who comes back, and who came because a friend sent them.

The full design is in [`docs/SPEC.md`](docs/SPEC.md).

> **Prototype.** This repository runs on a local chain or Base Sepolia. Balances have no value. Several institutional roles are held by one operator key for convenience (see [Roles](#roles)). It is not ready for production.

## What is in the repository

```
contracts/   Solidity 0.8.28, OpenZeppelin 5, Foundry
  NokorPass.sol      soulbound ERC-721 pass; links each new pass to the holder's previous one
  NokorRegistry.sol  registered merchants, with category, province and risk class
  NokorMoney.sol     kUSD and kRIEL: a closed-loop ERC-20 with escrow, disputes, holds, cash-out caps
  NokorAccess.sol    site access products, entitlements bought with an on-chain payment, gate entries
  NokorPoint.sol     ERC-1155 points (token id = the pass they were earned on), gift links, redemption
app/         Cloudflare Workers + D1 + Durable Objects + static assets (one deploy)
  src/worker/        Hono API, the relayer Durable Object, cron release of held payments
  src/client/        React PWA: visitor and merchant wallet, immigration, gate, operator, indicators
  src/wallet/        zk-vault signer, vendored from sengtha/zk-vault-react (MIT)
  migrations/        D1 schema
  e2e/               full-journey browser test against a local chain
docs/SPEC.md
```

## How it works

**Cloudflare only.** The Worker serves the PWA and the `/api` routes. D1 holds sessions, the encrypted wallet vaults, request state and an index of on-chain events for the indicators. A single `Relayer` Durable Object sends every operator transaction in order, so nonces never collide. A cron trigger runs every minute and releases payments whose hold has passed. There is no other backend and no Supabase.

**Wallet.** Every holder, merchant and visitor uses the zk-vault signer from [`zk-vault-react`](https://github.com/sengtha/zk-vault-react). The private key is created and used inside a Web Worker. It is stored encrypted under an Argon2id PIN and, optionally, a WebAuthn PRF passkey. D1 only ever stores the ciphertext. The page builds EIP-712 digests and the worker signs them, so the key never reaches page code.

**Gasless.** Holders sign typed intents (`Pay`, `Enter`, `Dispute`, `Redeem`, `CashOut`, `Gift`, `RedeemPoints`). The Worker relays them, and the contracts check the holder's signature and nonce, so visitors never need ETH.

**Nothing is scanned.** The holder shows a six-character code that is valid for two minutes. The driver, shop, gate or immigration officer types it in. The request then appears on the holder's phone, showing the registered payee, the amount, the ISO currency code and the reference fare. The holder approves it there. This closes the substituted-QR and wrong-currency attacks described in QRSeal.

**Money stays honest.** kUSD and kRIEL can only be minted to a valid pass holder. Merchants cannot transfer them onward; they can only cash out to a bank, within a daily cap. Every payment sits in escrow for a dispute window plus a hold that depends on the merchant's risk class. A refunded site-access purchase also cancels the access it bought.

## Local development

You need Node 20 or later and [Foundry](https://book.getfoundry.sh/) (`anvil`, `forge`).

```bash
# contracts
cd contracts
npm install                 # OpenZeppelin
forge test                  # 49 tests

# chain + deployment (anvil's public test keys; never use them elsewhere)
anvil &
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
OPERATOR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
DISPUTE_WINDOW=300 \
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
# addresses are written to contracts/deployments/31337.json

# app
cd ../app
npm install
cp .dev.vars.example .dev.vars
# add one line to .dev.vars with the addresses (drop "chainId"):
# CONTRACTS='{"NokorPass":"0x…","NokorRegistry":"0x…","kUSD":"0x…","kRIEL":"0x…","NokorAccess":"0x…","NokorPoint":"0x…"}'
npm run db:migrate:local
npm run dev                 # http://localhost:5173
```

Create staff keys with the bootstrap secret from `.dev.vars`:

```bash
curl -X POST localhost:5173/api/admin/keys -H 'x-bootstrap: change-me-local-bootstrap' \
  -H 'content-type: application/json' -d '{"role":"issuer","label":"Arrivals desk 1"}'
# roles: issuer, gate (optionally "siteIds": ["angkor-wat", …]), operator
```

Then open:

| Page | URL |
| --- | --- |
| Wallet (visitors, residents, merchants) | `#/wallet` |
| Immigration | `#/immigration` |
| Site gate | `#/gate` |
| Operator | `#/operator` |
| Public indicators | `#/dashboard` |

A merchant is an ordinary wallet that the operator has registered. After registration, the same app shows that wallet the Charge and Earnings tabs.

### Tests

```bash
cd app
npm run typecheck
npm test          # checks every EIP-712 type against the contracts' typehashes
npm run e2e       # starts anvil, deploys, resets local D1 and walks the whole journey in Chromium
```

The end-to-end run covers the whole journey in this order:

1. Issue a pass at arrival and top up the wallet.
2. Register merchants, a site authority, products and a reference fare.
3. Pay a tuk-tuk fare that is above the reference fare, with a warning shown.
4. Buy Angkor access, enter at Bayon, and get refused at Koh Ker.
5. Dispute a payment and refund it, which also cancels the access it bought.
6. Gift points; a friend arrives and claims them.
7. Convert the balance back and close the pass.
8. Return with the same passport, which links the new pass to the old one, and spend points from the first trip.
9. Check the indicators.

Screenshots are saved to `app/e2e/screenshots/`. Set `CHROMIUM_PATH` if Playwright should use a browser it did not install.

## Deploying to Cloudflare and Base Sepolia

1. Deploy the contracts. Use your own funded keys, not anvil's:
   ```bash
   cd contracts
   DEPLOYER_KEY=… OPERATOR=<relayer address> DISPUTE_WINDOW=86400 \
   forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org --broadcast
   ```
2. Create the database, then put its id in `app/wrangler.jsonc`:
   ```bash
   cd ../app
   npx wrangler d1 create nokor-pass
   npm run db:migrate:remote
   ```
3. In `wrangler.jsonc`, set these `vars`: `RPC_URL`, `CHAIN_ID=84532`, `EXPLORER_URL=https://sepolia.basescan.org`, `CONTRACTS` (from `contracts/deployments/84532.json`) and `DISPUTE_WINDOW_SECONDS`.
4. Set the secrets and deploy:
   ```bash
   npx wrangler secret put OPERATOR_KEY      # the relayer's private key; fund it with Base Sepolia ETH
   npx wrangler secret put ISSUER_SECRET     # HMAC key for document hashes; long and random
   npx wrangler secret put BOOTSTRAP_SECRET  # only for creating the first staff keys
   npm run deploy
   ```

Never commit `.dev.vars`, private keys, `ISSUER_SECRET` or any document numbers. Only an HMAC of the document number is stored, on-chain and in D1. Without the secret, it cannot be reversed or linked across systems.

## Roles

In this prototype, `Deploy.s.sol` gives every operational role to the relayer address so that one Worker can run the whole journey. In a real deployment, each role belongs to the institution that already does that job:

| Role | Contract | Who should hold it |
| --- | --- | --- |
| `ISSUER_ROLE` | NokorPass | General Department of Immigration |
| `MINTER_ROLE`, `OPERATOR_ROLE` | kUSD, kRIEL | Central bank or licensed issuer |
| `MERCHANT_ADMIN_ROLE` | NokorRegistry | Ministry of Tourism / Commerce |
| `SITE_ADMIN_ROLE`, `GATE_ROLE` | NokorAccess | Each site authority (for example APSARA) |
| `MINTER_ROLE`, `REDEEMER_ROLE` | NokorPoint | Ministry of Tourism |

`docs/SPEC.md` §11–12 lists the remaining limits.

## Licence

The COTA source is licensed under the [Apache License 2.0](LICENSE). The vendored zk-vault signer in `app/src/wallet/` remains under its MIT licence (`app/src/wallet/LICENSE-zk-vault-react`). OpenZeppelin Contracts and forge-std keep their own licences.
