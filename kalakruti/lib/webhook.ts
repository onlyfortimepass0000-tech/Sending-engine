import { emailSettings } from "./settings";
import type { Store } from "./store";

export type ConnectResult = { ok: true; detail: string } | { ok: false; error: string };

/**
 * Registers this site as a Resend webhook for bounces and spam complaints and
 * saves the signing secret. Needs a Resend API key with full access; a
 * send-only key is refused by Resend, in which case the owner can create the
 * webhook by hand and paste its signing secret on the Settings page.
 */
export async function connectBounceTracking(store: Store, origin: string): Promise<ConnectResult> {
  const email = await emailSettings(store);
  if (!email.apiKey) return { ok: false, error: "Add your Resend API key first." };
  const endpoint = `${origin}/api/webhooks/resend`;

  let res: Response;
  try {
    res = await fetch("https://api.resend.com/webhooks", {
      method: "POST",
      headers: { Authorization: `Bearer ${email.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, events: ["email.bounced", "email.complained"] }),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach Resend: ${(err as Error).message}` };
  }

  const body = (await res.json().catch(() => ({}))) as { signing_secret?: string; message?: string; name?: string };
  if (res.ok && body.signing_secret) {
    await store.setSetting("resend_webhook_secret", body.signing_secret);
    return { ok: true, detail: `Bounce tracking connected (${endpoint}).` };
  }
  const manual = ` You can instead create the webhook in Resend → Webhooks with URL ${endpoint} and events "email.bounced" and "email.complained", then paste its signing secret below.`;
  const restricted = res.status === 401 || res.status === 403;
  return {
    ok: false,
    error: `Resend refused (${res.status}${body.name ? ` ${body.name}` : ""}): ${body.message ?? "unknown error"}.${
      restricted ? " This API key may only be allowed to send email." : ""
    }${manual}`,
  };
}
