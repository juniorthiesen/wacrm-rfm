import { describe, expect, it, vi } from 'vitest';
import {
  assignCohort,
  cohortBucket,
  executeRecencyEnrollment,
  maskEmail,
  parseRecencyConfig,
  planRecencyEnrollment,
  RECENCY_DEFAULTS,
  evaluateRegueReadiness,
  summarizeRegueReport,
  type Candidate,
  type NewEnrollment,
  type RegueStore,
} from './regua';

const AUTO = { id: 'auto-1', user_id: 'user-1' };

describe('parseRecencyConfig', () => {
  it('applies defaults for an empty config', () => {
    expect(parseRecencyConfig({})).toEqual({
      ok: true,
      value: RECENCY_DEFAULTS,
    });
    expect(parseRecencyConfig(null)).toEqual({
      ok: true,
      value: RECENCY_DEFAULTS,
    });
  });

  it('accepts numeric strings (form inputs) and rejects out-of-range values', () => {
    expect(
      parseRecencyConfig({
        min_days: '90',
        max_days: '364',
        daily_cap: '50',
        control_percent: '10',
      })
    ).toEqual({
      ok: true,
      value: {
        min_days: 90,
        max_days: 364,
        daily_cap: 50,
        control_percent: 10,
      },
    });
    const bad = parseRecencyConfig({
      min_days: 0,
      daily_cap: -1,
      control_percent: 80,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(3);
  });

  it('requires max_days >= min_days', () => {
    const bad = parseRecencyConfig({ min_days: 200, max_days: 100 });
    expect(bad).toEqual({
      ok: false,
      errors: ['max_days must be greater than or equal to min_days'],
    });
  });

  it('allows a daily cap of 0 (paused) and no control group', () => {
    expect(parseRecencyConfig({ daily_cap: 0, control_percent: 0 }).ok).toBe(
      true
    );
  });
});

describe('cohort assignment', () => {
  it('is deterministic and case-insensitive on the e-mail', () => {
    expect(assignCohort('a', 'Maria@Gmail.com', 10)).toBe(
      assignCohort('a', 'maria@gmail.com', 10)
    );
    expect(cohortBucket('a', 'x@y.co')).toBe(cohortBucket('a', ' X@Y.co '));
  });

  it('holds out about control_percent of a large population', () => {
    const n = 5000;
    let control = 0;
    for (let i = 0; i < n; i++)
      if (assignCohort('auto-1', `user${i}@example.com`, 10) === 'control')
        control++;
    expect(control / n).toBeGreaterThan(0.08);
    expect(control / n).toBeLessThan(0.12);
  });

  it('never holds out anyone at 0%, and splits differently per automation', () => {
    for (let i = 0; i < 200; i++)
      expect(assignCohort('auto-1', `u${i}@x.co`, 0)).toBe('treatment');
    const a = Array.from({ length: 300 }, (_, i) =>
      assignCohort('auto-1', `u${i}@x.co`, 50)
    );
    const b = Array.from({ length: 300 }, (_, i) =>
      assignCohort('auto-2', `u${i}@x.co`, 50)
    );
    expect(a).not.toEqual(b);
  });
});

describe('summarizeRegueReport', () => {
  const row = (
    cohort: 'treatment' | 'control',
    enrolled: number,
    converted: number,
    revenue: number,
    matured = enrolled
  ) => ({
    cohort,
    enrolled,
    matured,
    converted,
    orders_count: converted,
    revenue,
  });

  it('computes uplift and incremental results against the control', () => {
    const r = summarizeRegueReport([
      row('treatment', 900, 27, 5400),
      row('control', 100, 1, 200),
    ]);
    expect(r.treatment.conversion_rate).toBeCloseTo(0.03);
    expect(r.control.conversion_rate).toBeCloseTo(0.01);
    expect(r.uplift_points).toBeCloseTo(2);
    expect(r.incremental_conversions).toBeCloseTo(18);
    // (6.0 - 2.0) R$/pessoa * 900
    expect(r.incremental_revenue).toBeCloseTo(3600);
    expect(r.warnings).toEqual([]);
  });

  it('warns instead of inventing an effect when there is no (or a tiny) control', () => {
    const none = summarizeRegueReport([row('treatment', 500, 10, 2000)]);
    expect(none.uplift_points).toBeNull();
    expect(none.incremental_revenue).toBeNull();
    expect(none.warnings[0]).toMatch(/Sem grupo de controle/);

    const small = summarizeRegueReport([
      row('treatment', 450, 9, 1800),
      row('control', 50, 1, 200),
    ]);
    expect(small.warnings.join(' ')).toMatch(/Grupo de controle pequeno/);
  });

  it('flags windows that have not fully elapsed', () => {
    const r = summarizeRegueReport([
      row('treatment', 900, 5, 1000, 400),
      row('control', 100, 0, 0, 40),
    ]);
    expect(r.warnings.join(' ')).toMatch(/dentro da janela/);
  });

  it('handles an empty report', () => {
    const r = summarizeRegueReport([]);
    expect(r.treatment.enrolled).toBe(0);
    expect(r.treatment.conversion_rate).toBe(0);
  });
});

describe('evaluateRegueReadiness', () => {
  const ready = {
    configuredCap: 100,
    emailStepCount: 3,
    hasCouponStep: true,
    emailActive: true,
    emailDailyLimit: 1000,
    siteUrlSet: true,
    connectorReady: true,
  };

  it('passes untouched when everything is ready and the limit is generous', () => {
    expect(evaluateRegueReadiness(ready)).toEqual({
      problems: [],
      warnings: [],
      effectiveCap: 100,
    });
  });

  it('blocks when the e-mail channel is not active, the site URL is missing or the store is not connected', () => {
    expect(
      evaluateRegueReadiness({ ...ready, emailActive: false }).problems
    ).toHaveLength(1);
    expect(
      evaluateRegueReadiness({ ...ready, siteUrlSet: false }).problems[0]
    ).toMatch(/NEXT_PUBLIC_SITE_URL/);
    expect(
      evaluateRegueReadiness({ ...ready, connectorReady: false }).problems[0]
    ).toMatch(/integração ativa com a loja/);
    expect(
      evaluateRegueReadiness({
        ...ready,
        emailActive: false,
        siteUrlSet: false,
        connectorReady: false,
      }).problems
    ).toHaveLength(3);
  });

  it('does not demand an e-mail channel or a store when the sequence has neither step', () => {
    const r = evaluateRegueReadiness({
      ...ready,
      emailStepCount: 0,
      hasCouponStep: false,
      emailActive: false,
      siteUrlSet: false,
      connectorReady: false,
    });
    expect(r.problems).toEqual([]);
  });

  it('lowers the cap so the whole sequence fits in the daily e-mail limit', () => {
    // 3 e-mails per person -> a limit of 150 supports 50 new people a day, not 100
    const r = evaluateRegueReadiness({ ...ready, emailDailyLimit: 150 });
    expect(r.effectiveCap).toBe(50);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/reduzido de 100 para 50/);
  });

  it('never raises the configured cap and handles a zero limit', () => {
    expect(
      evaluateRegueReadiness({
        ...ready,
        configuredCap: 20,
        emailDailyLimit: 1000,
      }).effectiveCap
    ).toBe(20);
    expect(
      evaluateRegueReadiness({ ...ready, emailDailyLimit: 0 }).effectiveCap
    ).toBe(0);
  });
});

describe('planRecencyEnrollment with a capacity override', () => {
  it('applies the lower of the configured cap and the e-mail capacity', async () => {
    const { store } = memoryStore(people(500));
    const res = await planRecencyEnrollment(
      store,
      { ...AUTO, trigger_config: { daily_cap: 100 } },
      new Date(),
      {
        capOverride: 50,
      }
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.plan.effectiveCap).toBe(50);
    expect(res.plan.budget).toBe(50);
    expect(res.plan.picks).toHaveLength(50);
  });

  it('an override above the configured cap does not raise it', async () => {
    const { store } = memoryStore(people(500));
    const res = await planRecencyEnrollment(
      store,
      { ...AUTO, trigger_config: { daily_cap: 30 } },
      new Date(),
      {
        capOverride: 1000,
      }
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.plan.effectiveCap).toBe(30);
  });
});

describe('maskEmail', () => {
  it('keeps only the first letter and the domain', () => {
    expect(maskEmail('maria.silva@gmail.com')).toBe('m***@gmail.com');
    expect(maskEmail('sem-arroba')).toBe('***');
  });
});

/** In-memory store with the same semantics as the SQL functions. */
function memoryStore(candidates: Candidate[], enrolledToday = 0) {
  const enrolled: NewEnrollment[] = [];
  const seen = new Set<string>();
  let enrolledCount = enrolledToday;
  const store: RegueStore = {
    async countEnrolledSince() {
      return enrolledCount;
    },
    async countCandidates() {
      return candidates.filter((c) => !seen.has(c.email)).length;
    },
    async listCandidates(_u, _a, _cfg, limit) {
      return candidates.filter((c) => !seen.has(c.email)).slice(0, limit);
    },
    async insertEnrollment(row) {
      if (seen.has(row.email)) return false;
      seen.add(row.email);
      enrolled.push(row);
      enrolledCount++;
      return true;
    },
  };
  return { store, enrolled };
}

const people = (n: number): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({
    contact_id: `c${i}`,
    name: `Pessoa ${i}`,
    email: `p${i}@example.com`,
    recency_days: 90 + i,
  }));

describe('planRecencyEnrollment', () => {
  it('respects the daily cap minus what already entered today', async () => {
    const { store } = memoryStore(people(500), 30);
    const res = await planRecencyEnrollment(store, {
      ...AUTO,
      trigger_config: { daily_cap: 100 },
    });
    if (!res.ok) throw new Error('expected ok');
    expect(res.plan.enrolledToday).toBe(30);
    expect(res.plan.budget).toBe(70);
    expect(res.plan.picks).toHaveLength(70);
    expect(res.plan.eligibleTotal).toBe(500);
    expect(res.plan.treatmentCount + res.plan.controlCount).toBe(70);
  });

  it('plans nothing when the cap is used up or set to 0', async () => {
    const used = await planRecencyEnrollment(
      memoryStore(people(10), 100).store,
      { ...AUTO, trigger_config: { daily_cap: 100 } }
    );
    expect(used.ok && used.plan.picks).toEqual([]);
    const paused = await planRecencyEnrollment(memoryStore(people(10)).store, {
      ...AUTO,
      trigger_config: { daily_cap: 0 },
    });
    expect(paused.ok && paused.plan.budget).toBe(0);
  });

  it('returns config errors instead of planning', async () => {
    const res = await planRecencyEnrollment(memoryStore([]).store, {
      ...AUTO,
      trigger_config: { min_days: 500, max_days: 10 },
    });
    expect(res.ok).toBe(false);
  });

  it('labels each pick with a stable cohort', async () => {
    const a = await planRecencyEnrollment(memoryStore(people(200)).store, {
      ...AUTO,
      trigger_config: { daily_cap: 200, control_percent: 20 },
    });
    const b = await planRecencyEnrollment(memoryStore(people(200)).store, {
      ...AUTO,
      trigger_config: { daily_cap: 200, control_percent: 20 },
    });
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.plan.picks.map((p) => p.cohort)).toEqual(
      b.plan.picks.map((p) => p.cohort)
    );
    expect(a.plan.controlCount).toBeGreaterThan(0);
  });
});

describe('executeRecencyEnrollment', () => {
  it('enrols everyone but only runs the automation for the treatment cohort', async () => {
    const { store, enrolled } = memoryStore(people(40));
    const planned = await planRecencyEnrollment(store, {
      ...AUTO,
      trigger_config: { daily_cap: 40, control_percent: 25 },
    });
    if (!planned.ok) throw new Error('expected ok');
    const run = vi.fn(async () => {});
    const result = await executeRecencyEnrollment(
      store,
      AUTO,
      planned.plan.picks,
      run
    );

    expect(result.enrolled).toBe(40);
    expect(result.control + result.treatment).toBe(40);
    expect(run).toHaveBeenCalledTimes(result.treatment);
    expect(enrolled.filter((e) => e.cohort === 'control')).toHaveLength(
      result.control
    );
    // control people are never passed to the runner
    const ran = (run.mock.calls as unknown as Array<[{ cohort: string }]>).map(
      (c) => c[0].cohort
    );
    expect(ran.every((c) => c === 'treatment')).toBe(true);
  });

  it('never contacts someone who is already enrolled (concurrent run)', async () => {
    const { store } = memoryStore(people(3));
    const planned = await planRecencyEnrollment(store, {
      ...AUTO,
      trigger_config: { daily_cap: 10, control_percent: 0 },
    });
    if (!planned.ok) throw new Error('expected ok');
    const run = vi.fn(async () => {});
    await executeRecencyEnrollment(store, AUTO, planned.plan.picks, run);
    const again = await executeRecencyEnrollment(
      store,
      AUTO,
      planned.plan.picks,
      run
    );
    expect(again).toMatchObject({ enrolled: 0, alreadyEnrolled: 3 });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('stops before enrolling anyone it did not reach (time budget)', async () => {
    const { store, enrolled } = memoryStore(people(10));
    const planned = await planRecencyEnrollment(store, {
      ...AUTO,
      trigger_config: { daily_cap: 10, control_percent: 0 },
    });
    if (!planned.ok) throw new Error('expected ok');
    let handled = 0;
    const run = vi.fn(async () => {
      handled++;
    });
    const result = await executeRecencyEnrollment(
      store,
      AUTO,
      planned.plan.picks,
      run,
      () => handled >= 4
    );
    expect(result).toMatchObject({ enrolled: 4, stoppedEarly: true });
    expect(enrolled).toHaveLength(4); // the other 6 stay eligible for the next run
  });

  it('keeps going when one run fails and reports it', async () => {
    const { store } = memoryStore(people(3));
    const planned = await planRecencyEnrollment(store, {
      ...AUTO,
      trigger_config: { daily_cap: 10, control_percent: 0 },
    });
    if (!planned.ok) throw new Error('expected ok');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn(async (pick: { contact_id: string }) => {
      if (pick.contact_id === 'c1') throw new Error('boom');
    });
    const result = await executeRecencyEnrollment(
      store,
      AUTO,
      planned.plan.picks,
      run
    );
    expect(result).toMatchObject({ enrolled: 3, treatment: 3, runErrors: 1 });
    expect(run).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
