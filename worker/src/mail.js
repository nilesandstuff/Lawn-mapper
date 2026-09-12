/**
 * Sending one kind of email: a sign-in link.
 *
 * WHY RESEND. A Worker cannot open an SMTP connection, so mail has to go over
 * HTTP to somebody. Resend is one POST with one API key, has a free tier that
 * does not ask for a card, and verifies a domain by DNS -- which matters here
 * because the whole point of this address is that it is the account. The
 * alternative that used to be free for Workers, MailChannels, stopped being
 * so; SendGrid and Postmark both work and both want more setup than a phone
 * makes pleasant.
 *
 * It is swappable: one function, one fetch. A deployment that would rather use
 * something else replaces sendMail() and nothing above it notices.
 *
 * NOT CONFIGURED IS NOT BROKEN. Without a key, the email door is simply not
 * offered -- the sign-in panel shows the providers it does have. An app that
 * displays a form which cannot work is worse than one that shows fewer
 * options.
 */

export const mailConfigured = (env) => Boolean(env?.RESEND_API_KEY && mailFrom(env));

/**
 * Who the mail comes from.
 *
 * Resend's shared onboarding@resend.dev works without verifying a domain and
 * only delivers to the account owner's own address, which makes it exactly
 * right for trying this out and useless in production. Naming it as the
 * fallback means a deployment that has not set MAIL_FROM still works for its
 * owner rather than silently failing.
 */
export const mailFrom = (env) =>
  String(env?.MAIL_FROM || 'Lawn Mapper <onboarding@resend.dev>').trim();

/**
 * One POST. Returns a reason rather than throwing, because the caller is
 * answering a person who pressed a button and needs to say something.
 */
/**
 * An address replies can go to, if the deployment has one.
 *
 * A From address that silently swallows replies is a small negative signal at
 * every mailbox provider, and a large one to a person: the first thing somebody
 * does with mail they did not expect is answer it and ask. Optional, because a
 * deployment without a monitored mailbox should not claim to have one.
 */
export const mailReplyTo = (env) => String(env?.MAIL_REPLY_TO || '').trim() || null;

export async function sendMail(env, { to, subject, text, html }) {
  if (!mailConfigured(env)) return { ok: false, detail: 'no mail provider configured' };

  try {
    const reply = mailReplyTo(env);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailFrom(env),
        to: [to],
        subject,
        text,
        html,
        ...(reply ? { reply_to: reply } : {}),
      }),
    });

    if (res.ok) return { ok: true };

    /*
     * Quote the provider, do not paraphrase it.
     *
     * "Sending failed" sends somebody to guess; "the domain is not verified"
     * or "you can only send to your own address on this plan" is the actual
     * next step. The same lesson the detector's 429 taught: the upstream
     * sentence is the useful part.
     */
    const body = await res.text();
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.message) detail = parsed.message;
      else if (parsed?.error) detail = String(parsed.error);
    } catch {
      if (body) detail = body.slice(0, 160);
    }
    return { ok: false, detail };
  } catch (err) {
    return { ok: false, detail: String(err?.message || err).slice(0, 160) };
  }
}

/**
 * The sign-in link itself.
 *
 * Plain text as well as HTML, because a mail client that shows the text part
 * is not an edge case and a link nobody can click is a sign-in that failed.
 * The expiry is in the words rather than only in the database -- somebody
 * coming back to an old email should be told why it no longer works before
 * they press it, not after.
 */
export async function sendMagicLink(env, to, link) {
  /*
   * WRITTEN AGAINST THE SHAPE OF A PHISHING EMAIL, because a magic link is one
   * by construction: short, from a domain you have never heard from, a single
   * urgent button, an expiry, and nothing else. That is the template, and
   * Gmail scores it as the template -- which is how the first one sent from a
   * new domain lands in spam even with SPF and DKIM passing.
   *
   * The differences below are the ones a filter can actually see, and each is
   * something real mail does and forged mail usually does not:
   *
   *   - IT NAMES THE RECIPIENT. Phishing is sent to a list and does not know
   *     who you are. "You asked to sign in as <address>" is also the sentence
   *     that lets somebody catch a link they did not request.
   *   - THE DESTINATION IS VISIBLE AS TEXT, not hidden behind a button. A link
   *     whose text and target agree is checkable by a person and by a filter;
   *     it is also the fallback when a client strips the button.
   *   - IT SAYS WHAT THE SITE IS. Two words of context, so the message stands
   *     on its own to somebody who signed up ten minutes ago and forgot.
   *
   * None of this outweighs DNS. It is the part the code owns.
   */
  const site = new URL(link).origin;
  const host = new URL(link).host;

  const text = [
    `You asked to sign in to Lawn Mapper as ${to}.`,
    '',
    'Open this link to finish:',
    link,
    '',
    'It works once and expires in 20 minutes.',
    '',
    `Lawn Mapper measures a lawn's square footage from its address — ${site}`,
    'If you did not ask to sign in, ignore this email. Nothing has changed and',
    'no account was created.',
  ].join('\n');

  const html = `
    <div style="font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#16211a">
      <p style="margin:0 0 14px">You asked to sign in to <b>Lawn&nbsp;Mapper</b>
        as ${escapeHtml(to)}.</p>
      <p style="margin:0 0 16px">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;padding:11px 18px;border-radius:10px;background:#2f7d32;color:#fff;text-decoration:none;font-weight:600">
          Sign in
        </a>
      </p>
      <p style="margin:0 0 16px;color:#5d6b62;font-size:13px">
        Or paste this into your browser:<br>
        <a href="${escapeHtml(link)}" style="color:#2f7d32;word-break:break-all">${escapeHtml(link)}</a>
      </p>
      <p style="margin:0 0 6px;color:#5d6b62;font-size:13px">
        It works once and expires in 20 minutes.
      </p>
      <p style="margin:0 0 6px;color:#5d6b62;font-size:13px">
        If you did not ask to sign in, ignore this — nothing has changed and no
        account was created.
      </p>
      <p style="margin:14px 0 0;color:#8a978f;font-size:12px">
        Lawn Mapper measures a lawn's square footage from its address.
        <a href="${escapeHtml(site)}" style="color:#8a978f">${escapeHtml(host)}</a>
      </p>
    </div>`;

  // Plain, and it says what it is. "Your ... link" reads like every credential
  // phish there has ever been; naming the action and the site does not.
  return sendMail(env, { to, subject: 'Sign in to Lawn Mapper', text, html });
}

/**
 * Escape for an HTML attribute.
 *
 * The link is built from our own origin and a base64url token, so there is
 * nothing dangerous in it today. It is escaped anyway because "this value is
 * safe" is a property of today's callers, and the next caller is the one that
 * breaks it.
 */
export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
