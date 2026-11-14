import type { Store } from "./store";

export const SETTING_KEYS = ["resend_api_key", "email_from", "email_reply_to", "business_name", "resend_webhook_secret"] as const;
/** Secret values: leaving the box empty on the Settings page keeps the saved one. */
export const SECRET_KEYS: readonly string[] = ["resend_api_key", "resend_webhook_secret"];
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface EmailSettings {
  mode: "live" | "mock";
  apiKey: string;
  from: string;
  replyTo: string;
  businessName: string;
  /** Whether bounce tracking (Resend webhook) has a signing secret saved. */
  webhookConnected: boolean;
  /** Where each value came from, for the Settings page. */
  source: Record<"apiKey" | "from", "env" | "settings" | "none">;
}

/** Env vars override values saved on the Settings page. */
export async function emailSettings(store: Store): Promise<EmailSettings> {
  let saved: Partial<Record<SettingKey, string>> = {};
  try {
    saved = await store.getSettings();
  } catch {
    // Unauthorized or unreachable — fall back to env only.
  }
  const env = process.env;
  const apiKey = env.RESEND_API_KEY || saved.resend_api_key || "";
  const from = env.EMAIL_FROM || saved.email_from || "";
  const forced = env.EMAIL_MODE === "mock" || env.EMAIL_MODE === "live" ? env.EMAIL_MODE : null;
  return {
    mode: forced ?? (apiKey && from ? "live" : "mock"),
    apiKey,
    from,
    replyTo: env.EMAIL_REPLY_TO || saved.email_reply_to || "",
    businessName: env.BUSINESS_NAME || saved.business_name || "Our team",
    webhookConnected: Boolean(saved.resend_webhook_secret || env.RESEND_WEBHOOK_SECRET),
    source: {
      apiKey: env.RESEND_API_KEY ? "env" : saved.resend_api_key ? "settings" : "none",
      from: env.EMAIL_FROM ? "env" : saved.email_from ? "settings" : "none",
    },
  };
}
