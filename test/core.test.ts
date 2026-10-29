import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/canonical.ts';
import { tierOf, TIERS, evaluateCore, expandPolicy, type Policy, type GateDef, type Tier } from '../src/engine.ts';
import { deployPolicy } from '../src/policy/deploy.ts';
import { deployBase, META, without } from './fixtures.ts';

test('JCS: sorted keys, ES number serialization (RFC 8785 §3.2.2.3 vectors)', () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'x'], c: { z: 0, y: -0 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0,"z":0}}');
  const vectors: [number, string][] = [[1e21, '1e+21'], [1e-7, '1e-7'], [333333333.3333333, '333333333.3333333'], [0.000001, '0.000001'], [9007199254740991, '9007199254740991']];
  for (const [n, s] of vectors) assert.equal(canonicalize(n), s);
  assert.equal(canonicalize({ '€': 1, '\r': 2, 'a': 3 }), '{"\\r":2,"a":3,"€":1}');
  assert.throws(() => canonicalize(Number.NaN));
});

test('risk matrix: all 64 tuples match 06 §5 and are monotone', () => {
  const table: Tier[][] = [
    ['LOW', 'LOW', 'LOW', 'LOW'], ['LOW', 'LOW', 'MEDIUM', 'MEDIUM'], ['MEDIUM', 'MEDIUM', 'HIGH', 'HIGH'], ['HIGH', 'HIGH', 'HIGH', 'CRITICAL'],
  ];
  for (let I = 0; I < 4; I++) for (let B = 0; B < 4; B++) for (let U = 0; U < 4; U++) {
    const t = tierOf(I, B, U);
    assert.equal(t, table[Math.max(I, B)][U]);
    for (const [dI, dB, dU] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
      if (I + dI > 3 || B + dB > 3 || U + dU > 3) continue;
      assert.ok(TIERS.indexOf(tierOf(I + dI, B + dB, U + dU)) >= TIERS.indexOf(t), `monotone at ${I}${B}${U}`);
    }
  }
  assert.throws(() => tierOf(4, 0, 0));
});

test('policy lint rejects duplicate ids, unknown evidence, dangling deps, cycles, two APPROVE gates', () => {
  const g = (id: string, extra: Partial<GateDef> = {}): GateDef => ({ id, resolver: 'EXTERNAL', eval: () => ({ status: 'PASS' }), ...extra });
  const mk = (gates: GateDef[]): Policy => ({ ...deployPolicy, gates });
  assert.throws(() => expandPolicy(mk([g('X'), g('X')])), /duplicate/);
  assert.throws(() => expandPolicy(mk([g('X', { reads: ['nope'] })])), /unknown evidence/);
  assert.throws(() => expandPolicy(mk([g('X', { dependsOn: ['GHOST'] })])), /unknown GHOST/);
  assert.throws(() => expandPolicy(mk([g('X', { dependsOn: ['Y'] }), g('Y', { dependsOn: ['X'] })])), /cycle/);
  assert.throws(() => expandPolicy(mk([g('A1', { purpose: 'APPROVE', resolver: 'AUTHORITY' }), g('A2', { purpose: 'APPROVE', resolver: 'AUTHORITY' })])), /more than one APPROVE/);
  assert.throws(() => expandPolicy(mk([g('N', { resolver: 'NONE', repair: { kind: 'telemetry', value: {} } })])), /repair/);
  expandPolicy(deployPolicy); // the shipped policy is valid
});

test('ST-1 (R-01): NOT_APPLICABLE prerequisite satisfies APPROVE dependency; outcome defined', () => {
  const p: Policy = { ...deployPolicy, gates: [{ id: 'OPT', resolver: 'EXTERNAL', eval: () => ({ status: 'NOT_APPLICABLE' }) }, ...deployPolicy.gates] };
  const d = evaluateCore(p, deployBase(), META);
  assert.equal(d.outcome, 'ESCALATE');
  assert.deepEqual(d.obligations.map((x) => x.gateId), ['D-APPROVE']);
});

test('ST-6: unknown action type → REFUSE UNSUPPORTED_ACTION without adapter call', () => {
  const s = deployBase();
  const d = evaluateCore({ ...deployPolicy, risk: () => { throw new Error('adapter called'); } }, { ...s, action: { ...s.action, actionType: 'drop_database' } }, META);
  assert.equal(d.outcome, 'REFUSE');
  assert.equal(d.obligations[0].reasonCode, 'UNSUPPORTED_ACTION');
});

// Seeded PRNG so the property test is reproducible.
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

test('totality property: random acyclic policies always yield exactly one outcome (real evaluator, 2000 cases)', () => {
  const rand = rng(42);
  const statuses = ['PASS', 'FAIL', 'NOT_APPLICABLE'] as const;
  const resolvers = ['REQUESTER', 'EXTERNAL', 'AUTHORITY', 'NONE'] as const;
  for (let n = 0; n < 2000; n++) {
    const count = 1 + Math.floor(rand() * 8);
    const gates: GateDef[] = [];
    for (let i = 0; i < count; i++) {
      const deps = gates.filter(() => rand() < 0.3).map((x) => x.id); // only earlier gates -> acyclic
      const st = statuses[Math.floor(rand() * 3)];
      gates.push({ id: `G${i}`, resolver: resolvers[Math.floor(rand() * 4)], dependsOn: deps, eval: () => ({ status: st }) });
    }
    const p: Policy = { ...deployPolicy, evidence: [], currentState: [], gates, risk: () => ({ I: 0, B: 0, U: 0 }) };
    const d = evaluateCore(p, deployBase(), META);
    const anyFail = d.gates.some((g) => g.status === 'FAIL');
    const anyBlocked = d.gates.some((g) => g.status === 'BLOCKED');
    assert.ok(['EXECUTE', 'ASK', 'DEFER', 'ESCALATE', 'REFUSE'].includes(d.outcome));
    assert.equal(d.outcome === 'EXECUTE', !anyFail && !anyBlocked);
    if (anyBlocked) assert.ok(anyFail, 'BLOCKED implies some FAIL');
  }
});

test('agent self-confidence never changes outcome, gates or risk', () => {
  const variants = [deployBase(), without(deployBase(), 'telemetry'), without(deployBase(), 'rollback_drill'), deployBase({ trafficPercent: undefined })];
  for (const s of variants) {
    const ref = evaluateCore(deployPolicy, { ...s, agentConfidence: 0.99 }, META);
    for (const c of [0, 0.5, 1, undefined]) {
      const d = evaluateCore(deployPolicy, { ...s, agentConfidence: c }, META);
      assert.equal(d.outcome, ref.outcome);
      assert.deepEqual(d.gates, ref.gates);
      assert.deepEqual(d.risk, ref.risk);
    }
  }
});

test('removing all observations of any mandatory slot never yields EXECUTE', () => {
  for (const e of deployPolicy.evidence) {
    for (const s of [deployBase(), deployBase({ service: 'search-api', trafficPercent: 1 })]) {
      const d = evaluateCore(deployPolicy, without(s, e.kind), META);
      assert.notEqual(d.outcome, 'EXECUTE', e.kind);
    }
  }
});

test('JCS rejects lone surrogates in strings and keys (RFC 8785 §3.2.2.2)', () => {
  assert.throws(() => canonicalize({ x: '\ud800' }), /surrogate/);
  assert.throws(() => canonicalize({ ['\udc00']: 1 }), /surrogate/);
  assert.equal(canonicalize('😀'), '"😀"');
});
