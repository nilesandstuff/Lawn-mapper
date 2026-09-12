# Turning accounts on

Everything here is optional and the site works without any of it. With none of
it set up, Lawn Mapper is what it was before: measure, correct, save to this
browser. Each piece below switches one more thing on.

All of it is done from a phone: GitHub settings pages, two sign-ups, then press
**Deploy**.

---

## 0. The database (nothing to do)

The deploy workflow finds or creates a D1 database called `lawn-mapper` and
applies `worker/schema.sql` on every deploy. The schema is idempotent, so new
tables appear on their own and nothing has to be run by hand.

If the Cloudflare API token cannot create databases, the deploy **still
succeeds** and accounts stay off — the binding is removed rather than left with
a placeholder in it. The workflow log says which happened.

If you want it on and it isn't: the token needs **D1: Edit** alongside the
Workers and KV permissions. The "Edit Cloudflare Workers" template at
<https://dash.cloudflare.com/profile/api-tokens> includes it.

---

## 1. Make yourself the owner

**GitHub → Settings → Secrets and variables → Actions → Variables → New**

| Name | Value |
| --- | --- |
| `ADMIN_EMAILS` | `nilesjac3@gmail.com` |

That address, when it signs in, gets:

- the **admin console** at `/admin.html`
- **unlimited detections** — no credits, never runs out

It is applied at every sign-in, so adding an address later promotes that account
the next time they sign in. It is a *variable*, not a secret — it is not
sensitive and you will want to read it back.

Comma- or space-separated for more than one.

---

## 2. Sign in with Google

**<https://console.cloud.google.com/apis/credentials>**

1. Create a project if you have none.
2. **OAuth consent screen** → External → fill in the app name and your email.
   While it is in *Testing* only addresses you list as test users can sign in;
   **Publish** it when you want anyone to. No review is needed for the
   `email`/`profile` scopes.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. Under **Authorised redirect URIs**, add exactly:

   ```
   https://lawnmap.nilesandstuff.com/api/auth/google/callback
   ```

   It has to match character for character, including the scheme and no
   trailing slash.

Then, in **GitHub → Secrets** (not variables — these are secret):

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the client ID, ending `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | the client secret |

**Facebook** is shaped for in `worker/src/auth.js` but deliberately not
enabled: its `email` permission needs Business Verification before it works for
anyone outside your own testers, and an account with no email address is the one
thing this design cannot have — the address *is* the account. Say the word when
you want it and the verification is done.

---

## 3. Sign in by email

**<https://resend.com>** — free tier, no card.

1. Sign up.
2. **API Keys → Create**. Copy it.
3. Optionally **Domains → Add** `nilesandstuff.com` and add the DNS records it
   gives you (Cloudflare, so this is a few taps).

| Where | Name | Value |
| --- | --- | --- |
| Secret | `RESEND_API_KEY` | the key, starting `re_` |
| Variable | `MAIL_FROM` | `Lawn Mapper <hello@nilesandstuff.com>` |

**Without `MAIL_FROM`** it uses Resend's shared `onboarding@resend.dev`, which
works immediately and **only delivers to your own Resend account address**.
That is right for trying it and useless for anyone else — so verify the domain
before friends try to sign in by email.

Using something other than Resend is one function: `sendMail()` in
`worker/src/mail.js`, one `fetch`.

---

## 4. Credits (optional)

| Where | Name | Value | Default |
| --- | --- | --- | --- |
| Variable | `WELCOME_CREDITS` | what a new account starts with | `20` |

`0` is a valid answer and means new accounts start empty.

Your own account ignores this entirely — `ADMIN_EMAILS` makes it unlimited.

---

## 5. Deploy

**Actions → 2. Deploy → Run workflow**, type `deploy`.

The log tells you what it found and what it skipped, including whether the
database was created and the schema applied.

---

## What you get

| | Signed out | Signed in | You |
| --- | --- | --- | --- |
| Measure a lawn | yes | yes | yes |
| Saved maps | this browser, 5 | the account, 50, any device | same |
| Detections | 20 passes a day | credits | unlimited |
| Console | — | — | `/admin.html` |

Everyone, signed in or not, is still subject to the per-address daily ceiling.
That is deliberate: an account starts with free credits, so without it "make
more accounts" would be a way to detect for free forever. It is generous enough
that a household never meets it.

---

## The console

`/admin.html`, or the button in your account menu. It shows:

- **AI passes** today, this week, this month, and a bar per day — the shape of
  the Replicate bill. Passes, not presses, because a four-box detection costs
  four predictions.
- **Every account**: balance, passes spent, maps saved, last seen. Search it.
  Grant or take credits, make somebody unlimited, make somebody an admin.
- **Credit history** for any account — "why do I have 12 credits" is the
  question people ask, and this is the answer.
- **Detection feedback**, worst first.
- **The measurement log**.

The log and feedback pages that take a token in the URL still work, unchanged.
They are the way back in if something about accounts goes wrong.

---

## Troubleshooting

**The account button is not there.** `/api/config` reports
`accounts: false` — the database is not bound. Check the deploy log.

**"redirect_uri_mismatch" from Google.** The URI in the Google console is not
character-for-character what the Worker sent. It is
`https://<your domain>/api/auth/google/callback`, with no trailing slash.

**The email never arrives.** If `MAIL_FROM` is unset, Resend only delivers to
your own account address. Verify a domain and set it. The sign-in panel shows
Resend's own refusal, which usually names the reason.

**Signed in, but the console says it is not for you.** The account was created
before `ADMIN_EMAILS` listed it. Sign out and back in — the flag is applied at
sign-in.

**I locked myself out.** The console refuses to remove your own admin, but if
the account was demoted some other way: make sure your address is in
`ADMIN_EMAILS`, deploy, sign out, sign in.
