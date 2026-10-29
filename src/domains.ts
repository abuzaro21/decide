// Domain registry: one policy per action type, the server-side target binding, and the ONE simulated effect each.
// Effects run only inside execute()'s transaction and only issue SQL on that connection.
import { readFileSync } from 'node:fs';
import { sha256 } from './canonical.ts';
import type { Db } from './db.ts';
import type { Action, Policy } from './engine.ts';
import { deployPolicy } from './policy/deploy.ts';
import { vendorPolicy } from './policy/vendor.ts';
import { supportPolicy, canonicalEmail } from './policy/support.ts';
import { publish, readObs, type Scope } from './world.ts';

const hashFile = (rel: string) => sha256(readFileSync(new URL(rel, import.meta.url), 'utf8')).slice(0, 16);
type Binding = { expectedTargetVersions: Action['expectedTargetVersions']; recoveryScope: Action['recoveryScope'] };

export interface Domain {
  policy: Policy;
  policyHash: string;
  /** Server-resolved expected target versions from CURRENT state (06 §2). `{}` when required fields are absent (FIELDS → ASK decides); null when fields are present but the target does not exist. */
  bind: (db: Db, s: Scope, params: Record<string, any>) => Binding | null;
  apply: (db: Db, s: Scope, action: Action, now: number) => Record<string, unknown>;
}

const UNBOUND: Binding = { expectedTargetVersions: {}, recoveryScope: {} };
const has = (p: Record<string, any>, keys: string[]) => keys.every((k) => p[k] !== undefined && p[k] !== null && p[k] !== '');
export const PROCEDURE_HASH = 'rollback-procedure-v3';

export const DOMAINS: Record<string, Domain> = {
  deploy_release: {
    policy: deployPolicy,
    policyHash: `${deployPolicy.name}:${hashFile('./policy/deploy.ts')}`,
    bind: (db, s, p) => {
      if (!has(p, ['service', 'environment'])) return UNBOUND;
      const st = readObs(db, s, 'deploy_state', 'deployer', { service: String(p.service), env: String(p.environment) });
      if (!st) return null;
      const v = st.value as Record<string, string | number>;
      return { expectedTargetVersions: { generation: v.generation, currentArtifact: v.currentArtifact, schemaVersion: v.schemaVersion, configVersion: v.configVersion }, recoveryScope: { procedureHash: PROCEDURE_HASH } };
    },
    apply: (db, s, a, now) => {
      const p = a.params as Record<string, any>;
      const subject = { service: String(p.service), env: String(p.environment) };
      const st = readObs(db, s, 'deploy_state', 'deployer', subject);
      if (!st) throw new Error('deploy target vanished inside the execution transaction');
      const v = st.value as Record<string, any>;
      const next = { ...v, generation: v.generation + 1, currentArtifact: p.toArtifact, trafficPercent: p.trafficPercent };
      publish(db, s, { kind: 'deploy_state', sourceId: 'deployer', sourceClass: 'ADAPTER', subject, value: next }, now);
      return { effect: 'DEPLOYED', service: p.service, environment: p.environment, artifact: p.toArtifact, trafficPercent: p.trafficPercent, generation: next.generation };
    },
  },
  pay_vendor_invoice: {
    policy: vendorPolicy,
    policyHash: `${vendorPolicy.name}:${hashFile('./policy/vendor.ts')}`,
    bind: (db, s, p) => {
      if (!has(p, ['vendorId', 'invoiceId'])) return UNBOUND;
      const inv = readObs(db, s, 'invoice_state', 'erp', { invoiceId: String(p.invoiceId) });
      const bank = readObs(db, s, 'bank_details', 'vendor_master', { vendorId: String(p.vendorId) });
      if (!inv || !bank) return null;
      // The payout target is the vendor master's CURRENT account, fingerprinted into the action (06 §2, F-03).
      return { expectedTargetVersions: { invoiceVersion: inv.value.version as number, bankDetailsVersion: bank.value.bankDetailsVersion as number, accountDigest: String(bank.value.accountDigest) }, recoveryScope: {} };
    },
    apply: (db, s, a, now) => {
      const p = a.params as Record<string, any>;
      const invSubject = { invoiceId: String(p.invoiceId) };
      const inv = readObs(db, s, 'invoice_state', 'erp', invSubject)!;
      const left = Number(inv.value.openBalanceCents) - p.amountCents;
      publish(db, s, { kind: 'invoice_state', sourceId: 'erp', sourceClass: 'ADAPTER', subject: invSubject, value: { ...inv.value, openBalanceCents: left, status: left === 0 ? 'SETTLED' : 'OPEN', version: Number(inv.value.version) + 1 } }, now);
      const expSubject = { vendorId: String(p.vendorId), windowDays: 30 };
      const exp = readObs(db, s, 'vendor_exposure', 'ledger', expSubject)!;
      publish(db, s, { kind: 'vendor_exposure', sourceId: 'ledger', sourceClass: 'ADAPTER', subject: expSubject, value: { settledCents: Number(exp.value.settledCents) + p.amountCents } }, now);
      return { effect: 'PAID', vendorId: p.vendorId, invoiceId: p.invoiceId, amountCents: p.amountCents, rail: p.rail, toAccount: a.expectedTargetVersions.accountDigest };
    },
  },
  change_account_email: {
    policy: supportPolicy,
    policyHash: `${supportPolicy.name}:${hashFile('./policy/support.ts')}`,
    bind: (db, s, p) => {
      if (!has(p, ['accountId'])) return UNBOUND;
      const prof = readObs(db, s, 'account_profile', 'crm', { accountId: String(p.accountId) });
      if (!prof) return null;
      return { expectedTargetVersions: { accountVersion: prof.value.version as number, customerId: String(prof.value.customerId) }, recoveryScope: {} };
    },
    apply: (db, s, a, now) => {
      const p = a.params as Record<string, any>;
      const subj = { accountId: String(p.accountId) };
      const prof = readObs(db, s, 'account_profile', 'crm', subj)!;
      const oldEmail = String(prof.value.email ?? '');
      const newEmail = canonicalEmail(p.newEmail);
      publish(db, s, { kind: 'account_profile', sourceId: 'crm', sourceClass: 'ADAPTER', subject: subj, value: { ...prof.value, email: newEmail, version: Number(prof.value.version) + 1 } }, now);
      publish(db, s, { kind: 'email_index', sourceId: 'crm', sourceClass: 'ADAPTER', subject: { email: newEmail }, value: { ownerAccountId: p.accountId } }, now);
      if (oldEmail) publish(db, s, { kind: 'email_index', sourceId: 'crm', sourceClass: 'ADAPTER', subject: { email: oldEmail }, value: { ownerAccountId: null } }, now);
      return { effect: 'EMAIL_CHANGED', accountId: p.accountId, from: oldEmail, to: newEmail };
    },
  },
};
