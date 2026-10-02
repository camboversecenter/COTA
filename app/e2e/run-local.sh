#!/usr/bin/env bash
# Local end-to-end run: starts anvil, deploys the contracts, resets the local
# D1 database, starts the app, creates staff keys and walks the journey.
# Requires Foundry (anvil, forge) and `npm install` in app/ and contracts/.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
LOGS=$ROOT/app/e2e/logs
mkdir -p "$LOGS"

cleanup() { kill ${ANVIL_PID:-} ${VITE_PID:-} 2>/dev/null || true; }
trap cleanup EXIT

anvil --port 8545 > "$LOGS/anvil.log" 2>&1 &
ANVIL_PID=$!
sleep 2

cd "$ROOT/contracts"
# anvil's public test accounts #0 (deployer) and #1 (operator). Never use these keys anywhere else.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
OPERATOR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
DISPUTE_WINDOW=300 \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast > "$LOGS/deploy.log" 2>&1

cd "$ROOT/app"
cp .dev.vars.example .dev.vars
CONTRACTS=$(node -e 'const d=require("../contracts/deployments/31337.json");delete d.chainId;process.stdout.write(JSON.stringify(d))')
echo "CONTRACTS='$CONTRACTS'" >> .dev.vars
rm -rf .wrangler/state
npx wrangler d1 migrations apply DB --local > "$LOGS/migrate.log" 2>&1

npx vite dev --port 5173 --host 127.0.0.1 > "$LOGS/vite.log" 2>&1 &
VITE_PID=$!
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:5173/api/config > /dev/null && break; sleep 1; done

key() {
  curl -s -X POST http://127.0.0.1:5173/api/admin/keys \
    -H 'x-bootstrap: change-me-local-bootstrap' -H 'content-type: application/json' \
    -d "{\"role\":\"$1\",\"label\":\"Local $1\"}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))'
}
node e2e/journey.mjs "$(key issuer)" "$(key gate)" "$(key operator)"
