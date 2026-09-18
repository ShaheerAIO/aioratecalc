"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { useSearchParams } from "next/navigation";
import { entraSignInAction } from "@/lib/actions/auth";
import {
  ENTRA_DENIAL_MESSAGES,
  ENTRA_PROVIDER_ID,
  parseEntraDenial,
} from "@/lib/auth/entraDenial";
import styles from "@/styles/auth.module.css";

const POPUP_NAME = "aioEntraSignIn";
/** Where a successful popup sign-in lands, so /rep never renders in the popup. */
const POPUP_DONE = "/login/popup-complete";
const POPUP_WIDTH = 520;
const POPUP_HEIGHT = 640;

/** Microsoft's four-square mark. Fixed brand colours — don't restyle. */
function MicrosoftLogo() {
  return (
    <svg
      className={styles.msLogo}
      width="18"
      height="18"
      viewBox="0 0 21 21"
      aria-hidden="true"
      focusable="false"
    >
      <path fill="#f25022" d="M1 1h9v9H1z" />
      <path fill="#7fba00" d="M11 1h9v9h-9z" />
      <path fill="#00a4ef" d="M1 11h9v9H1z" />
      <path fill="#ffb900" d="M11 11h9v9h-9z" />
    </svg>
  );
}

// Safari — and every iOS browser, all of which are WebKit underneath — handles
// OAuth popups badly: aggressive blocking, plus storage partitioning that can
// drop the PKCE/state cookies the callback needs. Those keep the plain
// top-level redirect, which always works.
function popupIsViable(): boolean {
  const { userAgent, platform, maxTouchPoints } = window.navigator;
  const iOS =
    /iP(ad|hone|od)/.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1); // iPadOS reports as Mac
  const safari =
    /Safari\//.test(userAgent) &&
    !/Chrome|Chromium|Edg|OPR|SamsungBrowser/.test(userAgent);
  return !iOS && !safari;
}

/** Submit button for the redirect path — driven by the server action. */
function RedirectButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={styles.msButton}>
      <MicrosoftLogo />
      {pending ? "Redirecting…" : "Sign in with Microsoft"}
    </button>
  );
}

function LoginCard() {
  const searchParams = useSearchParams();
  const [usePopup, setUsePopup] = useState(false);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [popupError, setPopupError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const timerRef = useRef<number | null>(null);

  // Starts false so the server-rendered markup is the redirect path; the popup
  // is a post-hydration enhancement, and no JS means the plain redirect.
  useEffect(() => {
    if (!popupIsViable()) return;
    let live = true;
    // The popup posts straight at Auth.js's REST signin endpoint, which wants
    // the double-submit CSRF token. No token → stay on the redirect path.
    fetch("/api/auth/csrf")
      .then((res) => res.json())
      .then((data: { csrfToken?: string }) => {
        if (live && data.csrfToken) {
          setCsrfToken(data.csrfToken);
          setUsePopup(true);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => stopPolling, []);

  function stopPolling() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // The outcome is read by polling the popup's URL from here, rather than having
  // the popup postMessage back: Chrome clears `window.name` across a
  // cross-origin navigation, so a page loaded inside the popup can't reliably
  // tell that it *is* the popup. The opener always can.
  function pollPopup(popup: Window) {
    if (popup.closed) {
      // Closed without reaching either landing page — treated as cancelled.
      stopPolling();
      setWaiting(false);
      return;
    }
    let url: URL;
    try {
      const href = popup.location.href;
      if (!href || href === "about:blank") return;
      url = new URL(href);
    } catch {
      // Still on login.microsoftonline.com: cross-origin reads throw, and that
      // throw is exactly the "keep waiting" signal.
      return;
    }
    if (url.origin !== window.location.origin) return;

    if (url.pathname === POPUP_DONE) {
      stopPolling();
      popup.close();
      window.location.assign("/rep");
    } else if (url.pathname === "/login") {
      // A refusal: the signIn callback in auth.config.ts redirects to
      // /login?error=<denial>.
      stopPolling();
      popup.close();
      setWaiting(false);
      setPopupError(url.searchParams.get("error") ?? "unknown");
    }
  }

  function openPopup() {
    if (!csrfToken) return;
    const left = Math.max(0, window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
    // location=yes deliberately: the address bar is how someone checks they're
    // really on microsoftonline.com before typing a password.
    const popup = window.open(
      "",
      POPUP_NAME,
      `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},location=yes,resizable=yes,scrollbars=yes`,
    );
    if (!popup) {
      // Blocked after all — fall back to the redirect.
      formRef.current?.requestSubmit();
      return;
    }

    setPopupError(null);
    setWaiting(true);

    const form = document.createElement("form");
    form.method = "POST";
    form.action = `/api/auth/signin/${ENTRA_PROVIDER_ID}`;
    form.target = POPUP_NAME;
    for (const [name, value] of Object.entries({ csrfToken, callbackUrl: POPUP_DONE })) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }
    document.body.append(form);
    form.submit();
    form.remove();
    popup.focus();

    timerRef.current = window.setInterval(() => pollPopup(popup), 250);
  }

  // Refusals arrive either as ?error=<denial> (redirect path) or read off the
  // popup's URL. Anything unrecognised is one of Auth.js's own OAuth errors.
  const raw = popupError ?? searchParams.get("error");
  const denial = parseEntraDenial(raw);
  const error = denial
    ? ENTRA_DENIAL_MESSAGES[denial]
    : raw
      ? "Sign-in didn't complete. Please try again."
      : null;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        {/* Plain <img>: nothing in this app uses next/image, and a 15 KB
            static logo gains nothing from the optimizer. Dimensions are the
            asset's own 520×355, scaled by CSS, so there's no layout shift. */}
        <img
          className={styles.brandLogo}
          src="/aio-logo.png"
          alt="AIO"
          width={520}
          height={355}
        />
        <h1 className={styles.brand}>EasyOB</h1>

        {error && <div className={styles.error}>{error}</div>}

        <form ref={formRef} action={entraSignInAction}>
          {usePopup ? (
            <button
              type="button"
              onClick={openPopup}
              disabled={waiting}
              aria-busy={waiting}
              className={styles.msButton}
            >
              <MicrosoftLogo />
              {waiting ? "Waiting for Microsoft…" : "Sign in with Microsoft"}
            </button>
          ) : (
            <RedirectButton />
          )}
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginCard />
    </Suspense>
  );
}
