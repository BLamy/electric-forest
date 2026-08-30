/**
 * Minimal Resend client. Locally this points at the vendored `@emulators/resend`
 * emulator (its inbox is the test oracle); in production at api.resend.com. The
 * platform only ever sends — receiving state lives on streams, never in the mailer.
 */
export interface ResendConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly from: string;
  readonly fetch?: typeof fetch;
}

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export class ResendMailer {
  constructor(private readonly config: ResendConfig) {}

  get from(): string {
    return this.config.from;
  }

  async send(email: OutboundEmail): Promise<{ readonly id: string }> {
    const fetcher = this.config.fetch ?? fetch;
    const response = await fetcher(`${this.config.baseUrl.replace(/\/+$/, "")}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.from,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });
    if (!response.ok) {
      throw new Error(`resend refused ${String(response.status)}: ${await response.text()}`);
    }
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== "string") throw new Error("resend response omitted an email id");
    return { id: body.id };
  }
}

export function inviteEmail(input: {
  readonly org: string;
  readonly inviter: string;
  readonly link: string;
}): Omit<OutboundEmail, "to"> {
  const subject = `You're invited to the ${input.org} workspace on Electric Forest`;
  const text = `${input.inviter} invited you to the ${input.org} workspace.\n\nSign in and accept the invitation:\n${input.link}\n\nThe invite is bound to this email address.`;
  const html = `<p>${escapeHtml(input.inviter)} invited you to the <strong>${escapeHtml(input.org)}</strong> workspace on Electric Forest.</p><p><a href="${escapeHtml(input.link)}">Sign in and accept the invitation</a></p><p>The invite is bound to this email address.</p>`;
  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
