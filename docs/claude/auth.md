# Auth — Entra staff sign-in, credentials, sessions

## Entra ID staff sign-in

Staff authenticate against AIO's Microsoft 365 (Entra) tenant. **Entra proves identity; `users.role`
grants authority.** There is deliberately no groups/appRoles claim plumbing — a rep is a rep because an
admin said so at `/admin/users`, not because of directory membership. Don't add group-driven roles
without raising it: it would make `/admin/users`' role editor a lie.

**Nothing is auto-provisioned.** A tenant member with no `users` row is refused (`not_provisioned`).
A rep account can read pillowed margins, configure quotes and open the one-way HubSpot publish door,
so that access is granted deliberately, never inherited from being an AIO employee.

**The merge.** Old password logins were joined to Entra lazily, on first sign-in, in
`resolveEntraStaffUser` (`lib/auth/entra.ts`): match `entra_oid` first, then `users.email`
(lowercased) — and on an email hit, stamp `entra_oid`/`entra_linked_at` onto the row. From then on
the immutable `oid` is authoritative, so a rep who changes their surname (and therefore their UPN)
keeps their account and their deals. Refusals: `not_provisioned`, `not_staff` (a customer row reached
by a colliding address — never silently upgraded), `disabled`, `oid_conflict` (a second Entra identity
claiming a linked row; recovery is "Unlink Microsoft account" at `/admin/users`), `wrong_tenant`,
`no_email`, `no_identity`. Copy for each lives in `entraDenial.ts`.

**Why the lookup is inside the provider's `profile()`** and not the `signIn` callback: it is the only
hook that gets the raw claims, and it is what decides which AIO row becomes the session. A refusal
can't throw from there without becoming an opaque OAuth error, so it's carried on the user object as
`denied` and turned into a message by the `signIn` callback in `auth.config.ts` (edge-safe: it only
reads the marker, never the DB). A refused identity is returned with **no `role`**, so even a session
that escaped the gate fails every check in `authorized`.

**`profile()` returns the AIO user id TWICE, as `id` and as `aioUserId`, and that is not
redundancy.** `@auth/core` (0.41.2, under `next-auth` 5.0.0-beta.31) **discards** an OAuth provider's
returned `id` and substitutes `crypto.randomUUID()` — deliberately, so the user stays independent of
the provider (`lib/actions/callback/oauth/callback.js`). That random id then seeds the token's `sub`,
and `sub` becomes `session.user.id`, which is written to `merchant_applications.owner_user_id`, a
strict FK. So the `jwt` callback in `auth.config.ts` restores `token.sub = user.aioUserId`; everything
`profile()` returns other than `id` survives, because the clobber spreads it first. **Delete
`aioUserId` and every staff session silently names a user that does not exist** — reads come back
empty and the first write dies on the foreign key. This is not hypothetical: it shipped that way, and
between the Entra cutover and 2026-09-23 no rep could create a prospect at all. An earlier version of
this document asserted the opposite (that `sub` came from `profile()`'s `id`) as the *reason* the
lookup lives there; it was true of some older `@auth/core` and is not true now. The credentials
provider is unaffected — it keeps `authorize()`'s `id` (`callback/index.js:238`), which is why
customer magic-link and admin breakglass sessions were always correct.

Regression cover is `sessionValidation.test.ts`, and it works by **modelling the clobber**
(`{ ...profileResult, id: randomUUID() }`) rather than asserting on `profile()`'s return — an
assertion on `profile()` alone passes happily while every session is broken.

**The `email` claim is not reliable.** Entra emits it only when the user has a `mail` attribute or the
app registration requests it as an optional claim, so `readEntraIdentity` falls back to
`preferred_username` (the UPN) and then `upn`. Don't remove the fallback — a tenant whose users lack
`mail` would match nobody. The email **on file** is what's returned, not the claim's: it feeds
`hs_sender_email` on published HubSpot quotes, which can't be amended.

**Tenant pinning** comes from `AUTH_MICROSOFT_ENTRA_ID_ISSUER`; `expectedTenantId()` parses the tenant
out of it and the `tid` claim is checked against it. `common`/`organizations` are treated as
unconfigured (they mean "any Microsoft account"), which makes the `tid` check a no-op rather than a
false guarantee — so **pin the issuer to the real tenant id**.

**Passwords.** Reps have no password path at all. `credentials` now requires a `scope`
(`"customer"` | `"breakglass"`) and refuses a role that doesn't match it — the two surfaces post the
same email+password shape, so without it a customer password would open a staff session. `scope`
missing → refused, so no stale bare-credentials caller can slip through. The admin breakglass
(`/login/breakglass`, unlisted) is the only staff password and exists solely so a broken or
unreachable Entra tenant can't lock everyone out of `/admin`.

**The password lookup is case-insensitive (2026-10-29).** The product owner reported "I set the password.
The login doesn't work when trying to sign back in." The cause was a mismatch between how the email
is written and how it was read. `createAccountFromLeadAction` stores it `trim().toLowerCase()`. The
magic-link branch of `authorize()` stores the token's address exactly as the rep typed it.
`authorize()`'s password branch then matched the raw typed value with a case-sensitive `=`, so a
capital letter, or an autofill from a browser profile that capitalises, could never find the row.
`authorize()` now matches `lower(users.email)` against the trimmed, lowercased input. That covers
both kinds of row, and it applies to breakglass too.

The other customer lookups by email had the same mismatch and now use the same predicate:
- `authorize()`'s magic-link branch. A rep-cased token missed the existing account and created a
  second one.
- `requestCustomerLoginAction` ("email me a link"). It sent nothing for a differently-cased address.
  It now also stores the token, and sends the mail, under the row's own email.
- `/api/customer/verify`'s set-password check. It sent merchants who already have a password through
  set-password again.
- `createAccountFromLeadAction`'s "already exists" check. It created a lowercased duplicate beside a
  magic-link account.

Regression cover is `customerEmailCase.test.ts`. It runs the real code: the provider through
`@auth/core`'s `Auth()`, plus the two actions and the verify route. It evaluates the compiled SQL with
Postgres's case-sensitive `=`.

Still open:
- `users.email`'s unique index is case-sensitive, so `Ana@x.com` and `ana@x.com` can both exist. The
  lookups take whichever row comes first.
- Entra's email fallback in `resolveEntraStaffUser` is still an exact match. It is safe while
  `createUserAction` lowercases every staff row.

**The app registration exists.** `EasyOB Staff Sign-In`, created 2026-09-17 in the AIO tenant
`e951f5b3-da6a-4b3d-9f40-993a88995573`, single-tenant (`signInAudience: AzureADMyOrg`). It carries
both redirect URIs, `email` + `upn` as optional ID-token claims, implicit flows off, and tenant-wide
admin consent for `openid profile email` so staff never see a consent prompt. It was created by
`scripts/entra-app-registration.ps1`, which is idempotent — re-running it is also the
**secret-rotation** path. **The client secret expires 2028-09-17**; rotating means re-running that
script (it rewrites `.env.local`, `\$`-escaped) and then replacing
`AUTH_MICROSOFT_ENTRA_ID_SECRET` in the Vercel project by hand, with the RAW `$`.

Requested scopes are just `openid profile email`; the provider's default adds Graph `User.Read`
purely to fetch a profile photo and base64 it into the session JWT, which `auth.ts` overrides away.

A registration created through Graph rather than the portal needs its **service principal created
explicitly** (`POST /servicePrincipals { appId }`) — the portal does that implicitly, Graph does not,
and without it sign-in fails with "application not found in the directory."

**Entra allows no wildcard redirect URIs**, and Auth.js builds `redirect_uri` from the request's own
Host header (`trustHost` is auto-true on Vercel, and `AUTH_URL` is deliberately unset so local dev
and production can share one config). So **only `http://localhost:5001` and the stable production
alias `https://aioeasyob.vercel.app` can complete an Entra sign-in** — per-deployment and preview
hostnames get a `redirect_uri` mismatch from Microsoft. Previews use `/login/breakglass`. Adding a
custom domain means adding its callback URI to the registration too.

**The sign-in button opens a popup, except on Safari.** `/login` POSTs to Auth.js's REST signin
endpoint into a named popup and watches it from the opener; success lands on
`/login/popup-complete` — a stub page that exists only so `/rep` never renders inside the popup —
and the opener then navigates the top window.

Two things there are load-bearing and easy to "simplify" wrongly:

- The outcome is read by **polling the popup's URL from the opener**, not by `postMessage`. Chrome
  clears `window.name` across a cross-origin navigation, so a page loaded inside the popup cannot
  reliably tell that it *is* the popup. The opener always can, and a cross-origin read simply throws
  while the popup is still on `login.microsoftonline.com` — that throw is the "keep waiting" signal.
- `/login/popup-complete` **must not call `window.close()`**. The opener tells "signed in" from
  "user cancelled" by whether the window closed before reaching that path, so self-closing would
  make every success look like a cancellation.

Safari and every iOS browser (all WebKit) keep the plain top-level redirect: popup blocking plus
storage partitioning that can drop the PKCE/state cookies the callback needs. The same redirect is
the fallback when JS hasn't hydrated, the CSRF fetch fails, or the popup is blocked — the form's
`entraSignInAction` server action is the no-JS path, so the button degrades instead of breaking.

## Constraints (do not reverse)

- **The session is resolved against `users` on every request, and that is load-bearing.** Auth.js
  never revalidates a JWT, so `sub` and `role` in the cookie are just claims: an account deleted,
  disabled or demoted after sign-in keeps satisfying `middleware.ts` (edge-side, no DB) and fails
  only at the first write, as an FK violation on `owner_user_id`. `getEffectiveRole` and
  `getCustomerSession` load the row, refuse a missing/disabled one, and take **`role` from the
  database, not the token** — so `/admin/users` disable and demote take effect immediately instead
  of at JWT expiry. Both are `cache()`d (one indexed PK read per request) and both reject a
  non-uuid `sub` before querying, because a refused Entra identity carries `entra:denied:<reason>`
  and a uuid column throws on it. The rep/admin layouts turn a null into
  `/login?error=session_stale`; middleware can't, because it can't reach Postgres.
- **Staff roles are NOT derived from Entra groups or app roles.** Entra authenticates; `users.role`
  authorizes. And **nothing is auto-provisioned** — an AIO tenant member with no `users` row is
  refused. Both are deliberate (2026-09-15): rep access reads pillowed margins and can open the
  one-way HubSpot publish door, so it's granted at `/admin/users`, never inherited from employment.
- **`credentials` requires a `scope` (`"customer"` | `"breakglass"`).** Customer password login and
  the admin breakglass post the identical email+password shape, so the scope is the only thing keeping
  them apart — without it a customer password opens a staff session. A call with no scope is refused,
  which is what stops a stale bare-credentials caller. Reps have no password path at all.
- **Don't delete the `preferred_username`/`upn` fallback in `readEntraIdentity`.** Entra emits the
  `email` claim only when the user has a `mail` attribute or the app requests it as an optional claim;
  without the fallback an AIO tenant whose users lack `mail` would match nobody.
