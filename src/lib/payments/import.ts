import { z } from 'zod';
import { addDays, daysBetween, parseDateInput, parseMoneyInput, type ISODate } from './dates';
import type { NewEntry } from './store';

export const MAX_IMPORT_ROWS = 500;
export const LONG_OVERDUE_DAYS = 30;

export interface ImportLine {
  row: number;
  name: string;
  email: string;
  outcome: 'imported' | 'skipped';
  /** why it was skipped, or what to look at for an imported row */
  reason: string | null;
  paused: boolean;
  entry?: NewEntry;
}

export interface ImportContext {
  today: ISODate;
  currency: string;
  /** existing unpaid entries of this client: "email|due_date|amount_minor" */
  existing: Set<string>;
  /** addresses that bounced, complained or opted out for this client */
  suppressed: Set<string>;
}

const HEADER_ALIASES: Record<'name' | 'email' | 'amount' | 'due' | 'phone' | 'note', string[]> = {
  name: ['name', 'customer', 'customer name', 'customer_name', 'client', 'client name', 'party', 'party name'],
  email: ['email', 'e-mail', 'email id', 'email address', 'mail', 'email_id'],
  amount: ['amount', 'amount due', 'due amount', 'balance', 'outstanding', 'pending', 'pending amount', 'amount_due', 'total'],
  due: ['due', 'due date', 'due_date', 'duedate', 'payment date', 'last date', 'date'],
  phone: ['phone', 'mobile', 'phone number', 'contact', 'whatsapp', 'mobile number'],
  note: ['note', 'notes', 'invoice', 'invoice no', 'invoice number', 'reference', 'ref', 'remarks', 'description'],
};

const ROLE_ADDRESSES = new Set(['info', 'admin', 'sales', 'support', 'contact', 'hello', 'office', 'accounts', 'billing', 'enquiry', 'enquiries', 'mail']);
const DISPOSABLE = new Set(['mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'throwawaymail.com']);
const emailSchema = z.email().max(254);

/** Minimal CSV/TSV parser: quotes, escaped quotes and newlines inside quotes. */
export function parseTable(text: string): string[][] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const firstLine = clean.split('\n', 1)[0]!;
  const count = (c: string) => firstLine.split(c).length - 1;
  const delim = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

type Field = keyof typeof HEADER_ALIASES;

function mapHeader(cells: string[]): Partial<Record<Field, number>> | null {
  const map: Partial<Record<Field, number>> = {};
  cells.forEach((c, i) => {
    const h = c.trim().toLowerCase();
    for (const f of Object.keys(HEADER_ALIASES) as Field[]) if (map[f] === undefined && HEADER_ALIASES[f].includes(h)) map[f] = i;
  });
  return map.email !== undefined ? map : null;
}

/**
 * Turns a pasted sheet into import lines. Pure: the caller supplies today's date and what already exists, and
 * writes the accepted lines. Rules, in the order they are applied to each row:
 *  - email present, valid, not a no-reply or throw-away address
 *  - amount is a positive number, due date is a real date
 *  - not a repeat inside the file, not already on the client's unpaid list, not a suppressed address
 *  - shared addresses (info@, accounts@ ...) are accepted with a note; rows more than 30 days overdue are
 *    accepted as PAUSED so the owner can look before any reminder is sent
 */
export function parseImport(text: string, ctx: ImportContext): { lines: ImportLine[]; hadHeader: boolean } {
  const table = parseTable(text);
  if (table.length === 0) return { lines: [], hadHeader: false };
  const header = mapHeader(table[0]!);
  const body = header ? table.slice(1) : table;
  const col = header ?? { name: 0, email: 1, amount: 2, due: 3, phone: 4, note: 5 };
  const get = (r: string[], f: Field) => (col[f] === undefined ? '' : (r[col[f]!] ?? '').trim());
  const seen = new Set<string>();
  const lines: ImportLine[] = [];

  body.forEach((r, i) => {
    const row = i + 1;
    const name = get(r, 'name').replace(/\s+/g, ' ').slice(0, 100);
    const email = get(r, 'email').toLowerCase();
    const base = { row, name, email };
    const skip = (reason: string): ImportLine => ({ ...base, outcome: 'skipped', reason, paused: false });
    if (row > MAX_IMPORT_ROWS) return void lines.push(skip(`Over the ${MAX_IMPORT_ROWS} rows allowed per import: send the rest in another batch`));
    if (!email) return void lines.push(skip('No email address'));
    if (!emailSchema.safeParse(email).success) return void lines.push(skip('Email address is not valid'));
    const [local, domain] = [email.split('@')[0]!, email.split('@')[1]!];
    if (/^(no-?reply|do-?not-?reply|donotreply|noreply)/.test(local)) return void lines.push(skip('No-reply address'));
    if (DISPOSABLE.has(domain)) return void lines.push(skip('Throw-away email domain'));
    const amountRaw = get(r, 'amount');
    const amount = parseMoneyInput(amountRaw);
    if (amount === null) return void lines.push(skip(amountRaw ? `Amount "${amountRaw}" is not a positive number` : 'No amount'));
    const dueRaw = get(r, 'due');
    const due = parseDateInput(dueRaw);
    if (due === null) return void lines.push(skip(dueRaw ? `Due date "${dueRaw}" not understood (use 15/10/2026 or 2026-10-15)` : 'No due date'));
    const key = `${email}|${due}|${amount}`;
    if (seen.has(key)) return void lines.push(skip('Repeated earlier in this file'));
    if (ctx.existing.has(key)) return void lines.push(skip('Already on the list (same customer, amount and due date)'));
    if (ctx.suppressed.has(email)) return void lines.push(skip('This address bounced, complained or opted out before'));
    seen.add(key);

    const notes: string[] = [];
    if (!name) notes.push('No name: the email will say "Dear Customer"');
    if (ROLE_ADDRESSES.has(local)) notes.push('Shared address (info@, accounts@ ...): check it is the right one');
    const overdue = daysBetween(due, ctx.today);
    const paused = overdue > LONG_OVERDUE_DAYS;
    if (paused) notes.push(`${overdue} days overdue: added as Paused, review it before resuming`);
    else if (due < addDays(ctx.today, -0) && overdue > 0) notes.push(`${overdue} day${overdue === 1 ? '' : 's'} overdue: reminders will go out one per day`);
    const phone = get(r, 'phone').replace(/[^\d+]/g, '').slice(0, 20) || null;
    lines.push({
      ...base,
      outcome: 'imported',
      reason: notes.join('. ') || null,
      paused,
      entry: { customer_name: name || 'Customer', email, phone, note: get(r, 'note').slice(0, 200) || null, currency: ctx.currency, amount_minor: amount, due_date: due, paused },
    });
  });
  return { lines, hadHeader: header !== null };
}

export function summarize(lines: ImportLine[]) {
  const imported = lines.filter((l) => l.outcome === 'imported');
  return {
    rows: lines.length,
    imported: imported.length,
    skipped: lines.length - imported.length,
    warnings: imported.filter((l) => l.reason).length,
    paused: imported.filter((l) => l.paused).length,
  };
}
