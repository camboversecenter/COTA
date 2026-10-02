// Nokor Pass reference Worker (SPEC §9).
// Serves the PWA from static assets and the API under /api.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { SITES } from "../shared/protocol";
import type { AppEnv } from "./auth";
import { chainConfig } from "./chain";
import type { Env } from "./env";
import { holder } from "./routes-holder";
import { merchant } from "./routes-merchant";
import { staff } from "./routes-staff";
import { releaseDue } from "./service";
import { now } from "./util";

export { Relayer } from "./chain";

const app = new Hono<AppEnv>().basePath("/api");

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
});

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// ------------------------------------------------------------------ public

app.get("/config", (c) => c.json(chainConfig(c.env)));

app.get("/products", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT p.*, m.name AS payee_name FROM products p LEFT JOIN merchants m ON m.address = p.payee ORDER BY p.product_id`,
  ).all<Record<string, unknown>>();
  return c.json(rows.results.map((p) => ({ ...p, sites: JSON.parse(p.sites as string) })));
});

app.get("/offers", async (c) => c.json((await c.env.DB.prepare("SELECT * FROM offers ORDER BY baseline DESC, points").all()).results));

app.get("/fares", async (c) => c.json((await c.env.DB.prepare("SELECT * FROM fares ORDER BY category, route").all()).results));

/** Aggregate indicators (SPEC §10). No personal data: counts and shares only. */
app.get("/indicators", async (c) => {
  const db = c.env.DB;
  const one = <T>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).first<T>();
  const angkor = Object.entries(SITES).filter(([, s]) => s.angkor).map(([id]) => id);

  const passes = await one<{ visitors: number; return_trip: number; residents: number }>(
    `SELECT SUM(category = 'Visitor') AS visitors,
            SUM(category = 'Visitor' AND previous_pass_id > 0) AS return_trip,
            SUM(category = 'Resident') AS residents FROM passes`,
  );
  const pts = await one<{ redeemed: number; return_trip: number; spread: number; awarded: number; gifted: number }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'redeem' THEN amount END), 0) AS redeemed,
            COALESCE(SUM(CASE WHEN kind = 'redeem' AND return_trip = 1 THEN amount END), 0) AS return_trip,
            COALESCE(SUM(CASE WHEN kind = 'redeem' AND spread = 1 THEN amount END), 0) AS spread,
            COALESCE(SUM(CASE WHEN kind = 'award' THEN amount END), 0) AS awarded,
            COALESCE(SUM(CASE WHEN kind = 'gift' THEN amount END), 0) AS gifted
       FROM point_events`,
  );
  const visits = await one<{ total: number; beyond: number }>(
    `SELECT COUNT(*) AS total, SUM(site_id NOT IN (${angkor.map(() => "?").join(",")})) AS beyond FROM visits`,
    ...angkor,
  );
  const pay = await one<{ total: number; disputed: number }>(
    "SELECT COUNT(*) AS total, SUM(disputed) AS disputed FROM payments",
  );
  const byPlace = await db
    .prepare(
      `SELECT m.province, m.category, p.currency, COUNT(*) AS payments, SUM(p.amount) AS amount, SUM(p.disputed) AS disputes
         FROM payments p JOIN merchants m ON m.address = p.merchant
        GROUP BY m.province, m.category, p.currency ORDER BY amount DESC`,
    )
    .all();
  const bySite = await db.prepare("SELECT site_id, COUNT(*) AS visits FROM visits GROUP BY site_id ORDER BY visits DESC").all();

  const share = (a?: number | null, b?: number | null) => (b ? (a ?? 0) / b : null);
  return c.json({
    asOf: now(),
    repeatVisitorRate: share(passes?.return_trip, passes?.visitors),
    returnValueRate: share(pts?.return_trip, pts?.redeemed),
    spreadRate: share(pts?.spread, pts?.redeemed),
    reachBeyondAngkor: share(visits?.beyond, visits?.total),
    disputesPerThousand: pay?.total ? ((pay.disputed ?? 0) / pay.total) * 1000 : null,
    totals: {
      visitorPasses: passes?.visitors ?? 0,
      returningVisitors: passes?.return_trip ?? 0,
      residentPasses: passes?.residents ?? 0,
      payments: pay?.total ?? 0,
      visits: visits?.total ?? 0,
      pointsAwarded: pts?.awarded ?? 0,
      pointsGifted: pts?.gifted ?? 0,
      pointsRedeemed: pts?.redeemed ?? 0,
    },
    spendingByPlace: byPlace.results,
    visitsBySite: bySite.results,
  });
});

app.route("/", holder);
app.route("/merchant", merchant);
app.route("/", staff);

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return app.fetch(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
  /** Every minute: release payments whose hold has passed (SPEC §5.6). */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(releaseDue(env, 50));
  },
} satisfies ExportedHandler<Env>;
