import { renderTemplate } from './templates';

/**
 * wa.me link with a prefilled message. No WhatsApp API: staff tap it and send by hand.
 * The phone was normalised at intake (digits, optional +). A number without "+" and without
 * a country code (e.g. 10-digit Indian mobile) gets the client's default country code.
 */
export function whatsappLink(phone: string, defaultCountryCode: string, template: string, vars: Record<string, string>): string {
  let digits = phone.replace(/\D/g, '');
  if (!phone.startsWith('+')) {
    digits = digits.replace(/^0+/, '');
    if (digits.length <= 10) digits = `${defaultCountryCode}${digits}`;
  }
  return `https://wa.me/${digits}?text=${encodeURIComponent(renderTemplate(template, vars))}`;
}
