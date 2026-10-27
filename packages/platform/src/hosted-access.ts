const ALLOWED_EMAIL_DOMAINS = new Set(["replay.io", "reloulexei.resend.app"]);

export function hasHostedAccess(email: string): boolean {
  const at = email.indexOf("@");
  return (
    at > 0 &&
    at === email.lastIndexOf("@") &&
    !/\s/.test(email) &&
    ALLOWED_EMAIL_DOMAINS.has(email.slice(at + 1).toLowerCase())
  );
}
