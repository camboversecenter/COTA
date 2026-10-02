import { chromium } from "playwright";
// Walks the whole visitor journey through the real UI against a local stack
// (anvil + contracts + vite dev). Run e2e/run-local.sh rather than this file.
import { mkdirSync } from "node:fs";
const SHOTS = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const [ISSUER, GATE, OPERATOR] = process.argv.slice(2);
if (!OPERATOR) throw new Error("usage: node e2e/journey.mjs <issuerKey> <gateKey> <operatorKey>");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const logs = [];
let n = 0;
const shot = async (p, name) => p.screenshot({ path: `${SHOTS}${String(++n).padStart(2, "0")}-${name}.png`, fullPage: true });
const step = (s) => console.log(`\n== ${s}`);

async function actor(name, hash = "#/wallet") {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 860 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => logs.push(`[${name} pageerror] ${e.message}`));
  p.on("console", (m) => m.type() === "error" && !m.text().includes("TUNNEL") && logs.push(`[${name}] ${m.text()}`));
  await p.goto(BASE + "/" + hash);
  return p;
}
async function createWallet(p) {
  await p.waitForSelector("text=Create your Nokor Pass wallet", { timeout: 15000 });
  await p.fill("input >> nth=0", "123456");
  await p.fill("input >> nth=1", "123456");
  await p.uncheck("input[type=checkbox]");
  await p.click("button:has-text('Create wallet')");
  await p.waitForSelector("text=Write down your recovery words", { timeout: 60000 });
  await p.check("input[type=checkbox]");
  await p.click("text=Continue to my wallet");
}
async function code(p) {
  const tab = p.locator("nav.tabs button", { hasText: "Pass" });
  if (await tab.count()) await tab.click();
  if (!(await p.locator(".code").count())) await p.click("button:has-text('Show my code')");
  const c = (await p.locator(".code").textContent()).trim();
  return c;
}
async function unlock(p) {
  await p.reload();
  await p.waitForSelector("text=Unlock your wallet", { timeout: 15000 });
  await p.fill("input", "123456");
  await p.click("button:has-text('Unlock') >> nth=0");
}
async function op(path, body) {
  const r = await fetch(BASE + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${OPERATOR}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}
async function approve(p, name, button = "Approve") {
  await p.waitForSelector(".sheet", { timeout: 20000 });
  await p.waitForTimeout(300);
  await shot(p, name);
  await p.click(`.sheet button:has-text('${button}')`);
  await p.waitForSelector(".sheet", { state: "detached", timeout: 60000 });
  const t = await p.locator(".notice.ok").first().textContent().catch(() => "");
  console.log("  holder sees:", t);
}

try {
  step("Visitor creates a wallet; immigration issues the pass");
  const V = await actor("visitor");
  await createWallet(V);
  await V.waitForSelector("text=No pass yet", { timeout: 20000 });
  await shot(V, "visitor-no-pass");
  const S = await actor("staff", "#/immigration");
  await S.fill("input", ISSUER);
  await S.click("button:has-text('Sign in')");
  await S.waitForSelector("text=Arrival: issue pass");
  let c = await code(V);
  await shot(V, "visitor-code");
  await S.fill("input.mono >> nth=0", c);
  await S.fill("input.mono >> nth=1", "N1234567");
  await S.click("button:text-is('Issue pass')");
  await S.waitForSelector(".notice.ok", { timeout: 30000 });
  console.log("  immigration:", await S.locator(".notice.ok").textContent());
  await shot(S, "immigration-issued");

  step("Operator: top-up, merchants, product, fare");
  c = await code(V);
  await op("/operator/topup", { code: c, currency: "USD", amount: 10000, method: "card" });
  await op("/operator/topup", { code: c, currency: "KHR", amount: 200000, method: "cash" });
  const M = await actor("tuktuk");
  await createWallet(M);
  await M.waitForSelector("text=No pass yet", { timeout: 20000 });
  const mc = await code(M);
  const mreg = await op("/operator/merchants", { code: mc, name: "Sokha Tuk-tuk", category: "tuktuk", province: "Siem Reap", riskClass: 1 });
  const A = await actor("apsara");
  await createWallet(A);
  await A.waitForSelector("text=No pass yet", { timeout: 20000 });
  const ac = await code(A);
  const areg = await op("/operator/merchants", { code: ac, name: "Angkor site authority", category: "site", province: "Siem Reap", riskClass: 0 });
  const prod = await op("/operator/products", {
    name: "Angkor 1-day pass", payee: areg.address, priceUsd: 3700, priceKhr: 148000, validityDays: 1, entries: 0,
    sites: ["angkor-wat", "bayon", "ta-prohm", "banteay-srei"],
  });
  const prod2 = await op("/operator/products", {
    name: "Koh Ker entry", payee: areg.address, priceUsd: 1500, priceKhr: 60000, validityDays: 7, entries: 1, sites: ["koh-ker"],
  });
  await op("/operator/settings", { points_per_usd: 20 });
  await op("/operator/fares", { category: "tuktuk", route: "Siem Reap town to Angkor Wat", currency: "USD", amount: 500 });
  console.log("  merchants", mreg.address, areg.address, "products", prod.productId, prod2.productId);

  step("Tuk-tuk charges above the reference fare; visitor approves");
  await unlock(M);
  await M.waitForSelector("text=Charge a customer", { timeout: 20000 });
  c = await code(V);
  await M.click("nav.tabs button:has-text('Charge')");
  await M.fill("input.mono", c);
  await M.selectOption("select", "Siem Reap town to Angkor Wat");
  await M.fill("input[inputmode=decimal]", "8");
  await M.fill("input >> nth=-1", "Morning ride to Angkor Wat");
  await shot(M, "merchant-charge");
  await M.click("button:has-text('Send to customer')");
  await approve(V, "visitor-approve-tuktuk");
  await M.waitForSelector("h1:has-text('Paid')", { timeout: 20000 });
  await shot(M, "merchant-paid");

  step("Visitor buys Angkor access and enters at the gate");
  await V.click("nav.tabs button:has-text('Sites')");
  await V.waitForSelector("text=Buy access");
  await shot(V, "visitor-sites");
  await V.click("button:has-text('Buy for 37.00 USD')");
  await approve(V, "visitor-approve-purchase");
  const G = await actor("gate", "#/gate");
  await G.fill("input", GATE);
  await G.click("button:has-text('Sign in')");
  await G.waitForSelector("text=Check access");
  await G.selectOption("select", "bayon");
  c = await code(V);
  await G.fill("input.mono", c);
  await G.click("button:has-text('Check access')");
  await approve(V, "visitor-approve-entry", "Let me in");
  await G.waitForSelector("text=Let them in", { timeout: 20000 });
  await shot(G, "gate-admitted");

  step("Koh Ker: no access → gate refuses");
  c = await code(V);
  await G.click("button:has-text('Next visitor')");
  await G.selectOption("select", "koh-ker");
  await G.fill("input.mono", c);
  await G.click("button:has-text('Check access')");
  await G.waitForSelector(".notice.error");
  console.log("  gate:", await G.locator(".notice.error").textContent());

  step("Visitor disputes the site purchase; operator refunds and the access is cancelled");
  await V.click("nav.tabs button:has-text('Activity')");
  await V.waitForSelector("text=Activity");
  await shot(V, "visitor-activity");
  V.once("dialog", (d) => d.accept());
  await V.click("button:has-text('Dispute') >> nth=0");
  await V.waitForTimeout(3000);
  const disputes = await op("/operator/disputes");
  console.log("  open disputes:", disputes.length);
  const O = await actor("operator", "#/operator");
  await O.fill("input", OPERATOR);
  await O.click("button:has-text('Sign in')");
  await O.click("nav.segmented button:has-text('Disputes')");
  await O.waitForSelector("text=Refund payer");
  await shot(O, "operator-disputes");
  await O.click("button:has-text('Refund payer')");
  await O.waitForSelector(".notice.ok", { timeout: 30000 });
  console.log("  operator:", await O.locator(".notice.ok").textContent());
  c = await code(V);
  await G.click("button:has-text('Next visitor')").catch(() => {});
  await G.selectOption("select", "bayon");
  await G.fill("input.mono", c);
  await G.click("button:has-text('Check access')");
  await G.waitForSelector(".notice.error");
  console.log("  gate after refund:", await G.locator(".notice.error").textContent());

  step("Points: visitor gifts a friend; friend arrives and claims");
  await V.reload();
  await V.waitForSelector("text=Unlock your wallet");
  await V.fill("input", "123456");
  await V.click("button:has-text('Unlock') >> nth=0");
  await V.waitForSelector("nav.tabs");
  await V.click("nav.tabs button:has-text('Points')");
  await V.waitForSelector("text=Give points to a friend");
  await V.fill("input[aria-label='Points to give']", "40");
  await V.click("button:has-text('Create gift link')");
  await V.waitForSelector("text=Gift created", { timeout: 30000 });
  await shot(V, "visitor-gift");
  const link = (await V.locator("p.small.break").first().textContent()).trim();
  console.log("  link:", link.replace(/0x[0-9a-f]{64}/, "0x…"));
  const F = await actor("friend", link.replace(/^https?:\/\/[^/]+\//, ""));
  await createWallet(F);
  await F.waitForSelector("text=A friend sent you Nokor Points", { timeout: 20000 });
  await shot(F, "friend-claim-before-pass");
  const fc = await code(F).catch(async () => {
    // claim screen has no tab bar: open wallet in same tab to get a code, then go back
    return null;
  });
  let friendCode = fc;
  if (!friendCode) {
    const F2 = await F.context().newPage();
    await F2.goto(BASE + "/#/wallet");
    await F2.waitForSelector("text=Unlock your wallet");
    await F2.fill("input", "123456");
    await F2.click("button:has-text('Unlock') >> nth=0");
    await F2.waitForSelector("text=Show my code", { timeout: 20000 });
    friendCode = await code(F2);
    await F2.close();
  }
  await S.click("button:has-text('Arrival: issue pass')");
  await S.fill("input.mono >> nth=0", friendCode);
  await S.fill("input.mono >> nth=1", "P9876543");
  await S.click("button:text-is('Issue pass')");
  await S.waitForSelector(".notice.ok", { timeout: 30000 });
  await F.waitForTimeout(16000); // /me poll
  await F.click("button:has-text('Receive the points')");
  await F.waitForSelector(".notice.ok", { timeout: 30000 });
  console.log("  friend:", await F.locator(".notice.ok").first().textContent());
  await F.click("nav.tabs button:has-text('Points')");
  await F.waitForSelector("text=Spend points");
  await shot(F, "friend-points");

  step("Visitor converts the balance back and leaves");
  await V.click("nav.tabs button:has-text('Pass')");
  await V.click("button:has-text('Leaving Cambodia')");
  await shot(V, "visitor-departure");
  await V.click(".panel button:has-text('Convert')");
  await V.waitForSelector(".panel .notice.ok", { timeout: 60000 });
  console.log("  visitor:", await V.locator(".panel .notice.ok").textContent());
  c = await code(V);
  await S.click("button:has-text('Departure: close pass')");
  await S.fill("input.mono", c);
  await S.click("button:text-is('Close pass')");
  await S.waitForSelector(".notice.ok", { timeout: 30000 });
  console.log("  immigration:", await S.locator(".notice.ok").textContent());

  step("Visitor returns: same passport, new pass linked to the old one");
  c = await code(V);
  await S.click("button:has-text('Arrival: issue pass')");
  await S.fill("input.mono >> nth=0", c);
  await S.fill("input.mono >> nth=1", "n1234567");
  await S.click("button:text-is('Issue pass')");
  await S.waitForSelector(".notice.ok", { timeout: 30000 });
  console.log("  immigration:", await S.locator(".notice.ok").textContent());
  await V.waitForTimeout(16000);
  await shot(V, "visitor-returning");
  await V.click("nav.tabs button:has-text('Points')");
  await V.waitForSelector("text=Spend points");
  await V.click("button:has-text('Use 500 points')");
  await V.waitForSelector("section:has(h2:text('Spend points')) .notice.ok", { timeout: 30000 });
  console.log("  voucher:", await V.locator("section:has(h2:text('Spend points')) .notice.ok").textContent());
  await shot(V, "visitor-redeemed");

  step("Merchant earnings and dashboard");
  await M.click("nav.tabs button:has-text('Earnings')");
  await M.waitForSelector("text=Recent payments");
  await shot(M, "merchant-earnings");
  const D = await actor("dash", "#/dashboard");
  await D.setViewportSize({ width: 1100, height: 900 });
  await D.waitForSelector(".kpi");
  await shot(D, "dashboard");
  console.log("  indicators:", JSON.stringify((await (await fetch(BASE + "/api/indicators")).json()), null, 0).slice(0, 600));
} catch (e) {
  console.log("FAILED:", e.message);
  process.exitCode = 1;
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: `${SHOTS}zz-fail-${Math.random().toString(36).slice(2, 6)}.png`, fullPage: true }).catch(() => {});
} finally {
  console.log("\nLOGS:\n" + logs.join("\n"));
  await browser.close();
}
