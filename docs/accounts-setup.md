# Turning accounts on

Everything here is optional and the site works without any of it. With none of
it set up, Lawn Mapper is what it was before: measure, correct, save to this
browser. Each piece below switches one more thing on.

All of it is done from a phone: one sign-up, a couple of GitHub settings pages,
then press **Deploy**.

---

## 0. The database (nothing to do)

The deploy workflow finds or creates a D1 database called `lawn-mapper` and
applies `worker/schema.sql` on every deploy. The schema is idempotent, so new
tables appear on their own and nothing has to be run by hand.

If the Cloudflare API token cannot create databases, the deploy **still
succeeds** and accounts stay off — the binding is removed rather than left with
a placeholder in it. The workflow log says which happened, and why.

**This is the usual first-run snag.** D1 is newer than this project, so a token
created before it existed carries Workers and KV permissions and not D1, and
the deploy reports:

```
  could not create one (… Authentication error [code: 10000])
  ACCOUNTS ARE OFF for this deploy.
```

Fix: **<https://dash.cloudflare.com/profile/api-tokens>** → your token → **Edit**
→ add permission **Account · D1 · Edit** → save. Then deploy again. Nothing else
changes and nothing is lost; the database is created and the schema applied on
the next run.

If you would rather not touch the token: make it by hand in the Cloudflare
dashboard (**Storage & Databases → D1 → Create**, named `lawn-mapper`) and set
its id as a repository **variable** called `D1_DATABASE_ID`.

---

## 1. Make yourself the owner

**GitHub → Settings → Secrets and variables → Actions → Variables → New**

| Name | Value |
| --- | --- |
| `ADMIN_EMAILS` | `you@example.com` |

That address, when it signs in, gets:

- the **admin console** at `/admin.html`
- **unlimited detections** — no credits, never runs out

It is applied at every sign-in, so adding an address later promotes that account
the next time they sign in. It is a *variable*, not a secret — it is not
sensitive and you will want to read it back.

Comma- or space-separated for more than one.

---

## 2. Sign in

**<https://resend.com>** — free tier, no card.

1. Sign up.
2. **API Keys → Create**. Copy it.
3. **Domains → Add** `nilesandstuff.com` and add the DNS records it gives you.
   Cloudflare hosts the DNS, so this is a few taps.

| Where | Name | Value |
| --- | --- | --- |
| Secret | `RESEND_API_KEY` | the key, starting `re_` |
| Variable | `MAIL_FROM` | `Lawn Mapper <hello@nilesandstuff.com>` |
| Variable | `MAIL_REPLY_TO` | optional — an address you actually read |

**Without `MAIL_FROM`** it uses Resend's shared `onboarding@resend.dev`, which
works immediately and **only delivers to your own Resend account address**.
That is right for trying it and useless for anyone else — so verify the domain
before friends try to sign in.

There is no password. The link in the email *is* the verification: receiving it
proves the address is yours, which is what makes it safe for the address to be
the account. Nothing to forget, reuse, leak or reset.

### What the DNS should end up looking like

A working zone, as a reference — this is every record the whole site needs,
mail and app together. Written down because it is easy to check against and
tedious to reconstruct from four provider help pages.

| Type | Name | Points at | Proxy |
| --- | --- | --- | --- |
| Worker | `lawnmap` | the Worker | **Proxied** (orange) |
| TXT | `resend._domainkey` | `p=MIGf…` (DKIM) | DNS only |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | DNS only |
| MX | `send` | `feedback-smtp.<region>.amazonses.com`, priority 10 | DNS only |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@example.com` | DNS only |
| CNAME | `links` | `links1.resend-dns.com` | DNS only — *only if* click tracking is on |

**The app's record must stay proxied.** Workers custom domains only work
through Cloudflare's proxy, so the orange cloud on that row is load-bearing:
switching it to DNS only takes the site down. Every mail record is grey, and it
is worth not generalising from that to the one row where it matters.

**Why SPF is on `send` and not on the domain itself**, which looks wrong and is
not: Resend sends with an envelope sender at `send.yourdomain.com` while the
visible From is `yourdomain.com`. DMARC's relaxed alignment treats those as one
organisation, so SPF aligns — and DKIM signs as the domain proper, which aligns
directly. Adding an SPF record at the apex buys nothing.

**Cloudflare will say visitors cannot reach the apex or `www`.** True, and not a
problem: the app is on its own subdomain. Pointing the apex somewhere is
optional, and mildly worth doing for a reason Cloudflare does not mention — a
sending domain whose root does not resolve at all is a small negative signal to
some filters.

### When the link goes to spam

Expect this at first. A sign-in link is a phishing email by construction —
short, from a domain nobody has heard from, one urgent button, an expiry — and
a brand-new sending domain has no reputation to argue with. SPF and DKIM
passing is not enough on its own.

In rough order of how much each one buys you:

**1. Add a DMARC record.** Resend sets up SPF and DKIM and does *not* ask for
this, and it is the biggest single thing Gmail looks at that you are probably
missing. In Cloudflare DNS add a **TXT** record:

| Name | Value |
| --- | --- |
| `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@example.com` |

`p=none` is monitoring only — it cannot cause your own mail to be rejected, so
it is safe to add without understanding the rest of DMARC. Put your own address
in `rua` and you get a weekly report of who is sending as your domain.

**2. Make sure links are not rewritten to somebody else's domain.** With click
tracking on, Resend replaces every link with one pointing at *its* tracking
host — so the mail says it is from you while its button goes somewhere else,
which is the pattern spam filters hunt for, and you inherit a shared domain's
reputation.

Check **Domains → your domain → Settings** in Resend. There are two good
outcomes and one bad one:

- **Click tracking off** — nothing to do, and this is the default. A sign-in
  link should not be tracked anyway.
- **Click tracking on, with a tracking domain of your own** — also fine. The
  rewritten link is then on *your* domain, so there is no mismatch. Resend asks
  for a subdomain and a CNAME to go with it.
- **Click tracking on, using Resend's shared host** — the bad one. Turn it off,
  or give it a domain of your own.

If you do set a tracking subdomain, `links.yourdomain.com` is a good name.
Do **not** reuse `send.` (that is the sending subdomain, and already holds the
SPF and DKIM records) and do not use the subdomain the site itself is served
from. In Cloudflare, set the CNAME to **DNS only** — the grey cloud, not the
orange one. Proxying it breaks the tracking host's certificate.

**3. Send from the site's own domain**, so the link and the sender match. The
deploy log checks this and warns if they do not.

**4. Give it a reply address.** Set `MAIL_REPLY_TO` to something you read, even
a forward. Mail nobody can reply to is a small negative signal, and a bigger
problem for the confused person trying to reply.

**5. For your own inbox, right now**: open the message in spam, press **Report
not spam**, then add the sender to Contacts. In Gmail you can also make a
filter — search `from:hello@yourdomain.com`, then *Create filter* → *Never send
it to spam*. This fixes your mailbox immediately and does nothing for anybody
else's, so do it to unblock your own testing and then fix the DNS properly.

**6. Then just wait.** A new domain's first handful of messages often land in
spam and get better as real people open them and do not complain. Low volume
and nobody marking it as spam is exactly how reputation gets built.

The email itself already does what it can: it names the recipient, shows the
link as visible text rather than hiding it behind a button, and says what the
site is. Those are the differences a filter can see between real transactional
mail and a forgery. They do not outweigh the DNS.

**Why not "sign in with Google"?** It was built and then removed. What it buys
is one tap instead of a trip to an inbox; what it costs is a registered
application, a consent screen to keep current, a client secret to rotate, and a
second code path through the most security-sensitive part of the app. It also
rests on remembering to check the provider's `email_verified` claim every time
a provider is added — a rule that fails silently when somebody forgets. With
one door, that rule is not a rule, it is the mechanism.

Adding one later is a configuration change, not a migration: the account model
already supports several ways in to one address, and `identities` already
records which was used.

---

## 3. Daily limits (optional — and editable later without a deploy)

Everybody gets a daily allowance of AI passes that comes back in the morning.
Signing in makes it bigger. That is the whole arrangement.

| Where | Name | What it is | Default |
| --- | --- | --- | --- |
| Variable | `ANON_DAILY` | signed out, per browser | `5` |
| Variable | `FREE_DAILY` | a signed-in account | `30` |
| Variable | `IP_DAILY` | any one address, shared | `80` |

**These are only the starting numbers.** Once the site is up, all of them are
in the console under **Daily limits**, and a change there takes effect in about
fifteen seconds with no deploy. Change them there; the variables decide what a
fresh deployment begins with.

Once you have changed one in the console, that number is set from the console
and these variables stop affecting it. The console's **Back to 5** button on
that row hands it back.

`0` is a valid answer everywhere and means exactly zero, not "use the default".

If you already set `WELCOME_CREDITS`, it still works — it is read as the
free-account number. It used to name a one-off grant and now names the daily
allowance, so the number you chose keeps applying.

Your own account ignores all of it — `ADMIN_EMAILS` makes it unlimited.

### Why there is no "one account per address" rule

Making accounts is the obvious way round a limit, and three things answer it.

**There is nothing to farm.** The allowance is daily, not a signing-up bonus, so
a fresh account buys tomorrow's passes today and nothing beyond that. New
accounts start with a balance of zero — the allowance *is* what they get.

**The address ceiling is shared by everyone behind it**, accounts included. Ten
accounts on one wifi do not get ten allowances; they get the address's 80. It is
the one number a new account cannot move, so it is the only real limit, and it
is what to raise or lower if farming ever actually happens.

**And a ceiling needs a door.** An office of eight people sharing one IP looks
exactly like eight accounts made by one person, and no rule will ever tell them
apart. So the console does instead: give that account its own daily limit, and
it is both raised *and* taken out of the shared-address count entirely. Four
seconds, one field, and a person made the judgement.

A cap on accounts per address was considered and rejected. It fails precisely
where it matters — households, offices and phone networks are all one address
with many real people behind it — and it stops nobody who can clear a cookie or
switch to mobile data.

---

## 4. Deploy

**Actions → 2. Deploy → Run workflow**, type `deploy`.

The log tells you what it found and what it skipped, including whether the
database was created and the schema applied.

---

## What you get

| | Signed out | Signed in | You |
| --- | --- | --- | --- |
| Measure a lawn | yes | yes | yes |
| Saved maps | this browser, 5 | the account, 50, any device | same |
| AI passes | 5 a day | 30 a day | unlimited |
| Console | — | — | `/admin.html` |

Drawing by hand is unlimited for everybody and always was — the allowance is
only for the AI passes, because those are the ones Replicate bills for.

Everyone, signed in or not, is still subject to the per-address daily ceiling,
for the reasons above. It is generous enough that a household never meets it,
and one field in the console excuses an account that does.

---

## The console

`/admin.html`, or the button in your account menu. It shows:

- **AI passes** today, this week, this month, and a bar per day — the shape of
  the Replicate bill. Passes, not presses, because a four-box detection costs
  four predictions.
- **Daily limits** — the three numbers above, editable in place. Each box saves
  on its own and says whether anybody has changed it, so you can tell a save
  landed.

  A row reading **not changed yet** follows whatever the site was deployed
  with, so editing the repository variable and deploying moves it. A row
  reading **changed here** is set from this page instead and a deploy will
  *not* move it — **Back to 5** undoes that and hands the number back to the
  deploy settings.
- **Every account**: today's allowance, passes spent, maps saved, last seen.
  Search it. Give somebody its own daily limit (which also exempts them from
  the shared-address ceiling), grant or take bought credits, make somebody
  unlimited, make somebody an admin.
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

**The email never arrives.** If `MAIL_FROM` is unset, Resend only delivers to
your own account address. Verify a domain and set it. The sign-in panel shows
Resend's own refusal, which usually names the reason.

**The email arrives, in spam.** Expected on a new domain, and fixable — see
[When the link goes to spam](#when-the-link-goes-to-spam) above. The short
version: add a DMARC record, and check that Resend is not rewriting your links
to its own domain.

**"This site cannot send email yet."** `RESEND_API_KEY` is not set, so there is
no way in at all. Measuring and saving to this browser still work.

**Signed in, but the console says it is not for you.** The account was created
before `ADMIN_EMAILS` listed it. Sign out and back in — the flag is applied at
sign-in.

**I locked myself out.** The console refuses to remove your own admin, but if
the account was demoted some other way: make sure your address is in
`ADMIN_EMAILS`, deploy, sign out, sign in.
