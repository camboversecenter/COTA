// The approval sheet (SPEC §5.1, §6.3). Before anything is signed the holder
// sees the registered payee, the amount, and the currency by ISO code, with the
// home-currency equivalent and any reference-fare warning. Nothing is scanned.

import { useState } from "react";
import { stringToHex } from "viem";
import { CURRENCIES, formatAmount, SITES, type PendingRequest } from "../shared/protocol";
import { api } from "./api";
import { homeCurrency, inHome } from "./rates";
import { fmtDuration, Icon, Notice, useAction, useNow } from "./ui";
import { deadlineIn, useWallet } from "./wallet";

const categoryName: Record<string, string> = {
  tuktuk: "Tuk-tuk",
  boat: "Boat",
  restaurant: "Restaurant",
  site: "Site authority",
  hotel: "Hotel",
  shop: "Shop",
  guide: "Guide",
};

export function Approval({ req, onDone }: { req: PendingRequest; onDone: (message: string) => void }) {
  const wallet = useWallet();
  const { busy, error, run } = useAction();
  const now = useNow();
  const [home] = useState(homeCurrency.get());
  const left = req.expiresAt - now;

  const approve = () =>
    run(async () => {
      const deadline = deadlineIn(180);
      let signature: string;
      if (req.kind === "entry") {
        const site32 = stringToHex(req.siteId!, { size: 32 });
        signature = await wallet.sign("NokorAccess", "Enter", {
          holder: wallet.address,
          productId: BigInt(req.productId!),
          siteId: site32,
          gateRef: req.id,
          nonce: BigInt(req.nonce),
          deadline: BigInt(deadline),
        });
      } else {
        signature = await wallet.sign(CURRENCIES[req.currency!].token, "Pay", {
          payer: wallet.address,
          merchant: req.merchant,
          amount: BigInt(req.amount!),
          ref: req.id,
          nonce: BigInt(req.nonce),
          deadline: BigInt(deadline),
        });
      }
      const res = await api.post<{ points: number; warnings?: string[] }>(`/requests/${req.id}/approve`, { signature, deadline });
      const pts =
        (res.points ? ` You earned ${res.points} Nokor Points.` : "") +
        (res.warnings?.length ? ` Some follow-up steps did not finish and the operator has been notified (${res.warnings.join("; ")}).` : "");
      onDone(req.kind === "entry" ? `Entry recorded. Enjoy ${SITES[req.siteId!]?.name ?? "the site"}.${pts}` : `Paid ${formatAmount(req.amount!, req.currency!)} to ${req.merchantName}.${pts}`);
    });

  const decline = () =>
    run(async () => {
      await api.post(`/requests/${req.id}/decline`);
      onDone("Declined. Nothing was paid.");
    });

  return (
    <div className="sheet-backdrop">
      <section className="sheet stack" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        {req.kind === "entry" ? (
          <>
            <p className="muted" id="approval-title">
              {req.gateLabel} is asking to let you in
            </p>
            <p className="payee">{SITES[req.siteId!]?.name ?? req.siteId}</p>
            <p className="muted">Using your {req.productName ?? "site access"}.</p>
          </>
        ) : (
          <>
            <p className="muted" id="approval-title">
              {req.kind === "purchase" ? "Buy site access from" : "Payment requested by"}
            </p>
            <div>
              <p className="payee">{req.merchantName}</p>
              <p className="muted small">
                Registered {categoryName[req.merchantCategory ?? ""] ?? req.merchantCategory}
                {req.route ? `, route: ${req.route}` : ""}
              </p>
              {req.description && <p className="small">Merchant's note: “{req.description}”</p>}
            </div>
            <div className="charge" aria-label={formatAmount(req.amount!, req.currency!)}>
              <span className="figure">{formatAmount(req.amount!, req.currency!).split(" ")[0]}</span>
              <span className={`iso ${req.currency === "KHR" ? "khr" : ""}`}>{req.currency}</span>
            </div>
            <p className="muted">
              {req.currency === "KHR" ? "Cambodian riel" : "US dollars"}
              {home !== req.currency ? `, ${inHome(req.amount!, req.currency!, home)}` : ""}
            </p>
            {req.flagged && req.reference != null && (
              <Notice kind="warn">
                This is more than the reference fare of {formatAmount(req.reference, req.currency!)} for this route. You can decline and
                agree a fair price.
              </Notice>
            )}
            {!req.flagged && req.reference != null && (
              <Notice kind="info">Within the reference fare of {formatAmount(req.reference, req.currency!)} for this route.</Notice>
            )}
            <p className="muted small">
              The money is held for a short time before the merchant receives it. If something is wrong, you can dispute it from Activity.
            </p>
          </>
        )}
        <Notice kind="error">{error}</Notice>
        <div className="btn-row">
          <button className="btn secondary" onClick={decline} disabled={busy}>
            <Icon name="x" size={18} />
            Decline
          </button>
          <button className="btn" onClick={approve} disabled={busy || left <= 0}>
            <Icon name="check" size={18} />
            {busy ? "Approving…" : req.kind === "entry" ? "Let me in" : `Pay ${formatAmount(req.amount!, req.currency!)}`}
          </button>
        </div>
        <p className="muted small">{left > 0 ? `Expires in ${fmtDuration(left)}.` : "This request has expired."}</p>
      </section>
    </div>
  );
}
