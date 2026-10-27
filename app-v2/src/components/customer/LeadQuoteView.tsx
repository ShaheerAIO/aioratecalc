"use client";

import { useState } from "react";
import { amountInvoiced } from "@/lib/quoting";
import { fmt$ } from "@/lib/utils";
import type { CustomerSafeQuote } from "@/types/merchant";
import QuoteSummary from "./QuoteSummary";
import styles from "./LeadQuoteView.module.css";

// The customer's view of a quote, always one the rep prepared. (Until
// 2026-10-13 a customer with no quote could generate one here by uploading
// their statement; that flow is gone — see the header on the route above.) It
// only ever receives a CustomerSafeQuote: no margin, no cost, no floor,
// nothing derived from them.
//
// The quote itself renders through QuoteSummary, shared with the authenticated
// "Your Quote" tab; this component owns the public page chrome and whatever
// the merchant's next step is.
//
// THERE IS ONE ACCEPTANCE, and for almost everyone it does not happen here.
// A quote with products on it is signed and paid on HubSpot's hosted page —
// e-signature and ACH mandate in one — so the panel is one button out to it.
// EasyOB used to ask the merchant to accept first and THEN send them there to
// accept again, which is one acceptance too many. Entering billing details IS
// accepting the quote.
//
// THE MERCHANT OPENS THE DOOR, and since 2026-10-15 there is a step in front
// of it: they confirm their own details at ../confirm, and confirming is what
// builds and publishes the HubSpot quote. Nothing is published when the rep
// sends the link any more, because a published quote can't be edited,
// replaced or voided — so a rep's typo of a billing contact or an address was
// frozen onto a document nobody could amend, and the rep was locked out of
// their own quote the moment they sent it.
//
// So the primary CTA here is a LINK to the confirmation form, not a fetch, and
// the irreversibility prompt went with it: it belongs next to the fields the
// merchant is being asked to vouch for, not next to a summary. What survives
// here is `continueToBilling`, for the two states where the merchant has
// already confirmed — their publish is still catching up, or they signed and
// never paid.
//
// The in-app accept form below survives for exactly one case, `canAcceptHere`:
// a rate-only quote, which creates no HubSpot document at all (see the header
// on /api/lead/[token]/accept). For those merchants there is nothing to sign
// and nothing to pay, so this is their only acceptance, not a duplicate one.

type Props = {
  token: string;
  quote: CustomerSafeQuote;
  businessName: string | null;
  contactEmail: string | null;
  /**
   * HubSpot's hosted quote — sign + pay in one. Present once the quote has
   * been published; null before that, which is now the ordinary state rather
   * than a wait, because pressing the button below is what publishes it.
   */
  checkoutUrl?: string | null;
  /** True when the merchant signed the hosted quote but never finished paying. */
  signedWithoutPaying?: boolean;
  /** Rate-only: no HubSpot document exists, so the merchant accepts right here. */
  canAcceptHere?: boolean;
  /** True when this quote has already been accepted (re-opened link). */
  alreadyAccepted?: boolean;
  /**
   * True once the merchant has confirmed their details at ../confirm — which
   * is what authorises the publish. False is the ORDINARY state for a fresh
   * link, not a wait: it just means nobody has been through the form yet.
   */
  detailsConfirmed?: boolean;
};

export default function LeadQuoteView({
  token, quote, businessName, contactEmail,
  checkoutUrl = null, canAcceptHere = false, alreadyAccepted = false,
  signedWithoutPaying = false, detailsConfirmed = false,
}: Props) {
  const [email, setEmail]         = useState(contactEmail || "");
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted]   = useState(alreadyAccepted);
  const [resent, setResent]       = useState(false);
  const [devUrl, setDevUrl]       = useState<string | null>(null);
  const [error, setError]         = useState<string | null>(null);

  // The billing hand-off. `going` covers the publish, which is 8-12 HubSpot
  // calls plus a ~3s link read, so the merchant is told it is working rather
  // than left on a dead button. There is no `confirming` prompt here any more
  // — the confirmation form owns it, next to the fields it is about.
  const [going, setGoing]           = useState(false);
  const [goError, setGoError]       = useState<string | null>(null);

  // What the merchant is told when the quote can't be published. Never the
  // real reason: those messages name AIO's internals and the person who can
  // fix them is a rep, not this merchant (see the route's own header).
  const CHECKOUT_ERRORS: Record<string, string> = {
    link_pending: "Your quote is being finalised right now — give it a few seconds and try again.",
    not_ready: "We couldn't open billing just yet. Your AIO representative has been notified and will sort it out — no need to do anything.",
    rate_only: "This quote has nothing to bill, so there's nothing to pay. Accept it below instead.",
    no_quote: "There's no quote on this link yet.",
    // Only reachable from a stale tab: the button that reaches this route is
    // only rendered once `detailsConfirmed` is true.
    not_confirmed: "Please check and confirm your details first.",
    no_payment_plan: "Please choose how you'd like to pay first.",
    expired: "This link has expired. Ask your AIO representative for a new one.",
    invalid: "This link is no longer valid. Ask your AIO representative for a new one.",
  };

  // Publishes the HubSpot quote if it isn't published yet, then sends the
  // merchant to it. Idempotent server-side, so a double click can't produce a
  // second document.
  //
  // Once it exists, the subscription opens in a new tab like the card's own
  // link, so this page — with the invoice beside it — stays put. A publish
  // that only just happened reloads this page onto the two documents instead
  // (2026-10-23).
  const continueToBilling = async () => {
    if (checkoutUrl) {
      if (!window.open(checkoutUrl, "_blank", "noopener")) window.location.href = checkoutUrl;
      return;
    }
    setGoing(true);
    setGoError(null);
    try {
      const res = await fetch(`/api/lead/${token}/checkout`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setGoError(CHECKOUT_ERRORS[data.error] ?? CHECKOUT_ERRORS.not_ready);
        setGoing(false);
        return;
      }
      // Deliberately not resetting `going` — the navigation is the end of this
      // component's life, and flipping the button back to idle mid-redirect
      // invites a second click on a door that only opens once.
      window.location.hash = "documents";
      window.location.reload();
    } catch {
      setGoError(CHECKOUT_ERRORS.not_ready);
      setGoing(false);
    }
  };

  // Rate-only only. Accepting and re-requesting the sign-in email are the same
  // call: that route records acceptance once and issues a fresh
  // 30-minute login token every time, so a customer who let theirs expire has
  // a way back in from this page.
  const accept = async () => {
    if (!email) return;
    const wasAccepted = accepted;
    setAccepting(true);
    setResent(false);
    setError(null);
    try {
      const res = await fetch(`/api/lead/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not accept the quote");
      setAccepted(true);
      setDevUrl(data.devUrl || null);
      if (wasAccepted) setResent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the quote");
    }
    setAccepting(false);
  };

  // Both documents, side by side under the quote they split it into
  // (2026-10-23): the subscription the merchant signs and pays, and the
  // one-time invoice AIO charges later. Only once published — before that
  // neither exists. A legacy quote (one-time lines on the quote itself) and a
  // quote with nothing invoiced show the subscription alone.
  const invoiceTotal = amountInvoiced(quote.lines);
  const hasInvoice = quote.oneTimeInvoiced && invoiceTotal > 0;
  // Confirmed and published, nothing signed yet: "View Subscription" above IS
  // the next step, so the panel's own Continue would be the same button twice.
  // The panel stays for the retry case — confirmed but no link yet.
  const panelRedundant =
    !accepted && !signedWithoutPaying && detailsConfirmed && !canAcceptHere && !!checkoutUrl;

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <div className={styles.quoteHead}>
          <div className={styles.quoteEyebrow}>Your Quote</div>
          <h1 className={styles.quoteBusiness}>{businessName || "Your Business"}</h1>
        </div>

        <div className={styles.wide}>
          <QuoteSummary quote={quote} />
        </div>

        {checkoutUrl && (
          <div id="documents" className={`${styles.wide} ${styles.docLinks}`} data-split={hasInvoice || undefined}>
            <div className={styles.docLink}>
              <div className={styles.docLinkLabel}>Subscription</div>
              <p className={styles.docLinkText}>
                {accepted ? "Signed, with your billing details in." : "Sign it and enter your billing details."}
              </p>
              <a href={checkoutUrl} target="_blank" rel="noopener noreferrer" className={styles.docLinkCta}>
                View Subscription →
              </a>
            </div>
            {hasInvoice && (
              <div className={styles.docLink}>
                <div className={styles.docLinkLabel}>Invoice · {fmt$(invoiceTotal)}</div>
                <p className={styles.docLinkText}>
                  {quote.invoice?.paid
                    ? "Paid. Thank you."
                    : "We'll charge it to the bank account you set up for your subscription — nothing to do."}
                </p>
                {quote.invoice?.link ? (
                  <a href={quote.invoice.link} target="_blank" rel="noopener noreferrer" className={styles.docLinkCta}>
                    View Invoice →
                  </a>
                ) : (
                  <span className={styles.docLinkPending}>Your invoice is being prepared — refresh in a minute.</span>
                )}
              </div>
            )}
          </div>
        )}

        {!panelRedundant && <div className={styles.panel}>
          {accepted ? (
            // Two quite different "done" states share this branch. A rate-only
            // merchant accepted with the form below and needs their login link
            // (and a way to re-request it). Everyone else signed on HubSpot,
            // and their link was emailed the moment we saw the payment.
            canAcceptHere ? (
              <div>
                <p className={styles.acceptSuccess}>
                  {resent
                    ? "New link sent. Check your email to finish setting up your account."
                    : "Quote accepted. Check your email for a link to finish setting up your account."}
                </p>
                {devUrl && (
                  <div className={styles.devUrl}>
                    Dev mode (no email configured): <a href={devUrl}>{devUrl}</a>
                  </div>
                )}
                <p className={styles.panelText}>
                  That link is good for 30 minutes. If it expired or never arrived, we&apos;ll send another.
                </p>
                <div className={styles.acceptRow}>
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="you@business.com"
                    className={styles.acceptInput}
                  />
                  <button
                    onClick={accept}
                    disabled={!email || accepting}
                    className={styles.acceptBtn}
                  >
                    {accepting ? "Sending…" : "Email Me a New Link"}
                  </button>
                </div>
                {error && <div className={styles.acceptError}>{error}</div>}
              </div>
            ) : (
              <div>
                <p className={styles.acceptSuccess}>
                  You&apos;re all set — this quote is signed and your billing is in.
                </p>
                <p className={styles.panelText}>
                  We&apos;ve emailed you a link to set up your account and finish onboarding. If it
                  expired, you can request a new one from the sign-in page.
                </p>
                <div className={styles.acceptRow}>
                  <a href="/customer/login" className={styles.acceptBtn}>Sign In →</a>
                </div>
              </div>
            )
          ) : signedWithoutPaying ? (
            // Signed, not paid. The two happen on the same HubSpot page but
            // are separate acts, and only the second one accepts the quote —
            // so this merchant believes they are finished and is looking at a
            // checklist that has unlocked nothing. Say exactly that, and send
            // them back to the same page to finish.
            <>
              <h2 className={styles.panelTitle}>You&apos;ve signed — one step left</h2>
              <p className={styles.panelText}>
                Thanks for signing. Your billing details still need to go in before we can set up
                your account and open the rest of your onboarding. It&apos;s the same page you
                signed on, and it takes a minute.
              </p>
              <div className={styles.acceptRow}>
                <button onClick={continueToBilling} disabled={going} className={styles.acceptBtn}>
                  {going ? "Opening…" : "Enter Billing Details →"}
                </button>
              </div>
              {goError && <div className={styles.acceptError}>{goError}</div>}
            </>
          ) : !detailsConfirmed ? (
            // THE ORDINARY STARTING STATE, and the step that now precedes
            // everything else — rate-only quotes included, which is why this
            // branch sits above `canAcceptHere`. The merchant checks what the
            // rep entered about them before any of it is committed: on a
            // billed quote that's a HubSpot document nobody can amend, and on
            // a rate-only one it's the detail AIO's tenant create refuses to
            // run without.
            //
            // A link rather than a fetch. The irreversibility prompt lives on
            // that page, beside the fields it is actually about.
            <>
              <h2 className={styles.panelTitle}>Ready to move forward?</h2>
              <p className={styles.panelText}>
                First, take a quick look at the details we hold for you — your business, your
                address and who we should bill. It only takes a minute.
              </p>
              <div className={styles.acceptRow}>
                <a href={`/lead/${token}/payment`} className={styles.acceptBtn}>
                  Continue
                </a>
              </div>
            </>
          ) : canAcceptHere ? (
            // Rate-only: no HubSpot document exists or ever will, so there is
            // nothing to sign and nothing to pay. This form is these
            // merchants' only acceptance, not a duplicate of one.
            <>
              <h2 className={styles.panelTitle}>Ready to move forward?</h2>
              <p className={styles.panelText}>
                We&apos;ll create your account so you can finish onboarding yourself — no need to
                wait on a rep.
              </p>
              <div className={styles.acceptRow}>
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@business.com"
                  className={styles.acceptInput}
                />
                <button
                  onClick={accept}
                  disabled={!email || accepting}
                  className={styles.acceptBtn}
                >
                  {accepting ? "Continuing…" : "Continue"}
                </button>
              </div>
              {error && <div className={styles.acceptError}>{error}</div>}
            </>
          ) : (
            // Confirmed, with a billed quote: straight through to HubSpot.
            // No prompt — they gave their answer on the confirmation form, and
            // asking a second time would be asking them to authorise something
            // they already did.
            //
            // `continueToBilling` still handles the publish itself, because
            // confirming and publishing are two steps and the second can lag
            // or fail: a merchant who confirmed while HubSpot was unreachable
            // lands here with no `checkoutUrl`, and this button is their retry.
            <>
              <h2 className={styles.panelTitle}>Ready to move forward?</h2>
              <p className={styles.panelText}>
                Review the full quote, sign it, and enter your billing details — all on one
                secure page. That&apos;s everything; we&apos;ll set your account up from there.
              </p>
              <div className={styles.acceptRow}>
                <button onClick={continueToBilling} disabled={going} className={styles.acceptBtn}>
                  {going ? "Opening…" : "Continue"}
                </button>
              </div>
              {goError && <div className={styles.acceptError}>{goError}</div>}
            </>
          )}
        </div>}

        <p className={styles.footnote}>
          Prefer to talk it through? Your AIO representative will follow up shortly too.
        </p>
      </div>
    </div>
  );
}
