// Ingress contracts (strict): unknown keys and wrong types are rejected (HTTP 400); ABSENT fields pass through
// so the evaluator's FIELDS gate can ASK for them (06 §2 structural vs policy validation).
import { z } from 'zod';

const Str = z.string().min(1).max(200);
export const PARAMS: Record<string, z.ZodType> = {
  deploy_release: z.strictObject({
    service: Str.optional(), environment: Str.optional(), toArtifact: Str.optional(), fromArtifact: Str.optional(),
    trafficPercent: z.number().int().optional(), intent: Str.optional(),
  }),
  pay_vendor_invoice: z.strictObject({
    vendorId: Str.optional(), invoiceId: Str.optional(), amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(), rail: Str.optional(),
  }),
  change_account_email: z.strictObject({ accountId: Str.optional(), ticketId: Str.optional(), newEmail: z.email().max(254).optional() }),
};
