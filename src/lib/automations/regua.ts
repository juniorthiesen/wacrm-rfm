import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { startOfLocalDay } from '@/lib/email/limits';

/**
 * Reactivation "régua": enrolment of lapsed customers into an automation.
 *
 *  - Candidates come from `recency_candidates()` (migration 054): in the
 *    recency window, with a valid e-mail, not opted out, not suppressed, not
 *    already enrolled, de-duplicated by e-mail.
 *  - A daily cap limits how many enter per local day (warm-up protection).
 *  - Every enrolled person gets a cohort. `control` people are enrolled and
 *    measured but NEVER contacted: that is what lets the report separate what
 *    the régua caused from what would have happened anyway.
 *  - The cohort is a stable hash of (automation, e-mail): the same person
 *    always lands in the same cohort, with no random state to store.
 *
 * DB access sits behind `RegueStore` (like the e-mail channel's `EmailStore`)
 * so the rules are unit-testable and the persistence can be swapped.
 */

export interface RecencyConfig {
  /** Window start: days since the last paid order (inclusive). */
  min_days: number;
  /** Window end (inclusive). */
  max_days: number;
  /** Max people enrolled per local day, control included. 0 pauses enrolment. */
  daily_cap: number;
  /** % of enrolled people held out as control (0–50). */
  control_percent: number;
}

export const RECENCY_DEFAULTS: RecencyConfig = {
  min_days: 90,
  max_days: 364,
  daily_cap: 100,
  control_percent: 10,
};

export type Cohort = 'treatment' | 'control';

export function parseRecencyConfig(
  raw: unknown
): { ok: true; value: RecencyConfig } | { ok: false; errors: string[] } {
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const errors: string[] = [];

  const pick = (key: keyof RecencyConfig, min: number, max: number): number => {
    const value = src[key];
    if (value === undefined || value === null || value === '')
      return RECENCY_DEFAULTS[key];
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push(`${key} must be an integer between ${min} and ${max}`);
      return RECENCY_DEFAULTS[key];
    }
    return n;
  };

  const value: RecencyConfig = {
    min_days: pick('min_days', 1, 3650),
    max_days: pick('max_days', 1, 3650),
    daily_cap: pick('daily_cap', 0, 5000),
    control_percent: pick('control_percent', 0, 50),
  };
  if (value.max_days < value.min_days)
    errors.push('max_days must be greater than or equal to min_days');

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Stable 0–99 bucket for (automation, e-mail). */
export function cohortBucket(automationId: string, email: string): number {
  const digest = createHash('sha256')
    .update(`${automationId}:${email.trim().toLowerCase()}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
}

export function assignCohort(
  automationId: string,
  email: string,
  controlPercent: number
): Cohort {
  return cohortBucket(automationId, email) < controlPercent
    ? 'control'
    : 'treatment';
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

/* ------------------------------ persistence ------------------------------ */

export interface Candidate {
  contact_id: string;
  name: string | null;
  email: string;
  recency_days: number;
}

export interface NewEnrollment {
  user_id: string;
  automation_id: string;
  contact_id: string;
  email: string;
  cohort: Cohort;
  recency_days: number;
}

export interface RegueStore {
  countEnrolledSince(automationId: string, since: Date): Promise<number>;
  countCandidates(
    userId: string,
    automationId: string,
    cfg: RecencyConfig
  ): Promise<number>;
  listCandidates(
    userId: string,
    automationId: string,
    cfg: RecencyConfig,
    limit: number
  ): Promise<Candidate[]>;
  /** true = inserted; false = already enrolled (a concurrent run won). */
  insertEnrollment(row: NewEnrollment): Promise<boolean>;
}

function fail(context: string, error: { message: string } | null): never {
  throw new Error(
    `[regua-store] ${context}: ${error?.message ?? 'unknown error'}`
  );
}

export function supabaseRegueStore(db: SupabaseClient): RegueStore {
  return {
    async countEnrolledSince(automationId, since) {
      const { count, error } = await db
        .from('automation_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('automation_id', automationId)
        .gte('enrolled_at', since.toISOString());
      if (error) fail('countEnrolledSince', error);
      return count ?? 0;
    },

    async countCandidates(userId, automationId, cfg) {
      const { data, error } = await db.rpc('recency_candidates_count', {
        p_user_id: userId,
        p_automation_id: automationId,
        p_min_days: cfg.min_days,
        p_max_days: cfg.max_days,
      });
      if (error) fail('countCandidates', error);
      return Number(data ?? 0);
    },

    async listCandidates(userId, automationId, cfg, limit) {
      const { data, error } = await db.rpc('recency_candidates', {
        p_user_id: userId,
        p_automation_id: automationId,
        p_min_days: cfg.min_days,
        p_max_days: cfg.max_days,
        p_limit: limit,
      });
      if (error) fail('listCandidates', error);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        contact_id: String(r.contact_id),
        name: (r.contact_name as string | null) ?? null,
        email: String(r.contact_email),
        recency_days: Number(r.recency_days),
      }));
    },

    async insertEnrollment(row) {
      const { data, error } = await db
        .from('automation_enrollments')
        .upsert(row, {
          onConflict: 'automation_id,email',
          ignoreDuplicates: true,
        })
        .select('id');
      if (error) fail('insertEnrollment', error);
      return (data ?? []).length > 0;
    },
  };
}

/* ------------------------------- readiness ------------------------------- */

export interface ReadinessInput {
  /** `daily_cap` of the recency trigger. */
  configuredCap: number;
  /** Marketing e-mail steps in the sequence (each enrolled person gets this many over time). */
  emailStepCount: number;
  hasCouponStep: boolean;
  emailActive: boolean;
  /** `email_config.daily_limit`, or null when the channel has no configuration. */
  emailDailyLimit: number | null;
  siteUrlSet: boolean;
  connectorReady: boolean;
}

export interface Readiness {
  /** Blocking: enrolling now would burn people (their first steps would fail and they are never re-enrolled). */
  problems: string[];
  warnings: string[];
  /** Daily cap that keeps the whole sequence inside the e-mail daily limit. */
  effectiveCap: number;
}

/**
 * Can this sequence actually run today, and at what pace?
 *
 * Pace: every enrolled person receives `emailStepCount` e-mails on different
 * days, so in steady state the channel sends about `cap × emailStepCount` e-mails
 * a day (D0 of today's cohort + D7 of last week's + D14 of the week before).
 * A marketing e-mail over the daily limit is skipped and NOT retried, so the cap
 * is lowered to `floor(limit / emailStepCount)` instead of silently dropping
 * the later e-mails of people already inside.
 */
export function evaluateRegueReadiness(input: ReadinessInput): Readiness {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (input.emailStepCount > 0) {
    if (!input.emailActive) {
      problems.push(
        'O canal de e-mail está inativo ou sem configuração (Configurações → E-mail).'
      );
    }
    if (!input.siteUrlSet) {
      problems.push(
        'NEXT_PUBLIC_SITE_URL não está definida: e-mails de marketing não saem sem o link de descadastro.'
      );
    }
  }
  if (input.hasCouponStep && !input.connectorReady) {
    problems.push(
      'Sem integração ativa com a loja: o passo "Criar cupom" falharia (a chave do WooCommerce precisa de leitura e escrita).'
    );
  }

  let effectiveCap = input.configuredCap;
  if (input.emailStepCount > 0 && input.emailDailyLimit !== null) {
    effectiveCap = Math.min(
      input.configuredCap,
      Math.floor(input.emailDailyLimit / input.emailStepCount)
    );
    if (effectiveCap < input.configuredCap) {
      warnings.push(
        `O limite diário de e-mail (${input.emailDailyLimit}) comporta ${effectiveCap} pessoas novas por dia, porque cada pessoa recebe ${input.emailStepCount} e-mails em dias diferentes e eles se somam. O teto da régua foi reduzido de ${input.configuredCap} para ${effectiveCap}. Aumente o limite em Configurações → E-mail para entrar mais gente por dia.`
      );
    }
  }

  return { problems, warnings, effectiveCap };
}

/* --------------------------------- plan ---------------------------------- */

export interface PlannedEnrollment extends Candidate {
  cohort: Cohort;
}

export interface RecencyPlan {
  /** Daily cap actually applied (the configured one, lowered by the e-mail capacity). */
  effectiveCap: number;
  config: RecencyConfig;
  /** Already enrolled today (local day), control included. */
  enrolledToday: number;
  /** How many more may enter today under the daily cap. */
  budget: number;
  /** Everyone currently eligible (not only today's batch). */
  eligibleTotal: number;
  picks: PlannedEnrollment[];
  treatmentCount: number;
  controlCount: number;
}

export async function planRecencyEnrollment(
  store: RegueStore,
  automation: { id: string; user_id: string; trigger_config: unknown },
  now: Date = new Date(),
  /** Lower bound from the e-mail capacity (see evaluateRegueReadiness). Never raises the configured cap. */
  options: { capOverride?: number } = {}
): Promise<{ ok: true; plan: RecencyPlan } | { ok: false; errors: string[] }> {
  const parsed = parseRecencyConfig(automation.trigger_config);
  if (!parsed.ok) return parsed;
  const config = parsed.value;

  const effectiveCap =
    options.capOverride === undefined
      ? config.daily_cap
      : Math.max(0, Math.min(config.daily_cap, options.capOverride));
  const enrolledToday = await store.countEnrolledSince(
    automation.id,
    startOfLocalDay(now)
  );
  const budget = Math.max(0, effectiveCap - enrolledToday);
  const eligibleTotal = await store.countCandidates(
    automation.user_id,
    automation.id,
    config
  );
  const candidates =
    budget > 0
      ? await store.listCandidates(
          automation.user_id,
          automation.id,
          config,
          budget
        )
      : [];

  const picks: PlannedEnrollment[] = candidates.map((c) => ({
    ...c,
    cohort: assignCohort(automation.id, c.email, config.control_percent),
  }));
  const controlCount = picks.filter((p) => p.cohort === 'control').length;

  return {
    ok: true,
    plan: {
      effectiveCap,
      config,
      enrolledToday,
      budget,
      eligibleTotal,
      picks,
      treatmentCount: picks.length - controlCount,
      controlCount,
    },
  };
}

/* --------------------------------- report -------------------------------- */

export interface ReportRow {
  cohort: Cohort;
  enrolled: number;
  matured: number;
  converted: number;
  orders_count: number;
  revenue: number;
}

export interface CohortSummary extends ReportRow {
  /** converted / enrolled, 0–1. */
  conversion_rate: number;
  revenue_per_person: number;
}

export interface RegueReport {
  treatment: CohortSummary;
  control: CohortSummary;
  /** Treatment minus control conversion, in percentage points. null without a control group. */
  uplift_points: number | null;
  /** Extra buyers the régua is estimated to have caused. null without a control group. */
  incremental_conversions: number | null;
  /** Extra revenue (R$) the régua is estimated to have caused. null without a control group. */
  incremental_revenue: number | null;
  warnings: string[];
}

const MIN_CONTROL_FOR_SIGNAL = 100;

function summarizeCohort(cohort: Cohort, rows: ReportRow[]): CohortSummary {
  const row = rows.find((r) => r.cohort === cohort);
  const base: ReportRow = row ?? {
    cohort,
    enrolled: 0,
    matured: 0,
    converted: 0,
    orders_count: 0,
    revenue: 0,
  };
  return {
    ...base,
    conversion_rate: base.enrolled > 0 ? base.converted / base.enrolled : 0,
    revenue_per_person: base.enrolled > 0 ? base.revenue / base.enrolled : 0,
  };
}

/**
 * Treatment vs control. The control group (enrolled, never contacted) is what
 * lets us separate what the régua caused from purchases that would have
 * happened anyway, which the legacy AutomateWoo numbers could not do.
 */
export function summarizeRegueReport(rows: ReportRow[]): RegueReport {
  const treatment = summarizeCohort('treatment', rows);
  const control = summarizeCohort('control', rows);
  const hasControl = control.enrolled > 0;

  const warnings: string[] = [];
  if (!hasControl) {
    warnings.push(
      'Sem grupo de controle: não dá para separar o efeito da régua das compras que aconteceriam de qualquer forma.'
    );
  } else if (control.enrolled < MIN_CONTROL_FOR_SIGNAL) {
    warnings.push(
      `Grupo de controle pequeno (${control.enrolled}): a diferença ainda pode ser acaso. Espere passar de ${MIN_CONTROL_FOR_SIGNAL} pessoas.`
    );
  }
  if (
    treatment.matured < treatment.enrolled ||
    control.matured < control.enrolled
  ) {
    warnings.push(
      'Parte das pessoas ainda está dentro da janela de medição: os números de conversão são um piso e vão subir.'
    );
  }

  return {
    treatment,
    control,
    uplift_points: hasControl
      ? (treatment.conversion_rate - control.conversion_rate) * 100
      : null,
    incremental_conversions: hasControl
      ? (treatment.conversion_rate - control.conversion_rate) *
        treatment.enrolled
      : null,
    incremental_revenue: hasControl
      ? (treatment.revenue_per_person - control.revenue_per_person) *
        treatment.enrolled
      : null,
    warnings,
  };
}

/* -------------------------------- execute -------------------------------- */

export interface EnrollmentResult {
  enrolled: number;
  treatment: number;
  control: number;
  /** Lost the race to a concurrent run: already enrolled, not contacted again. */
  alreadyEnrolled: number;
  /** Enrolled but the automation run threw (they stay enrolled, no retry). */
  runErrors: number;
  /** `shouldStop` fired before every pick was handled. */
  stoppedEarly: boolean;
}

/**
 * Enrols the planned people and starts the automation for the treatment ones.
 * The enrolment row is written BEFORE the automation runs, so a crash can
 * never make someone receive the sequence twice; the worst case is an enrolled
 * person whose first run failed (counted in `runErrors`).
 */
export async function executeRecencyEnrollment(
  store: RegueStore,
  automation: { id: string; user_id: string },
  picks: PlannedEnrollment[],
  run: (pick: PlannedEnrollment) => Promise<void>,
  /** Checked before each person (e.g. a time budget). Those not reached are NOT enrolled, so the next run takes them. */
  shouldStop: () => boolean = () => false
): Promise<EnrollmentResult> {
  const result: EnrollmentResult = {
    enrolled: 0,
    treatment: 0,
    control: 0,
    alreadyEnrolled: 0,
    runErrors: 0,
    stoppedEarly: false,
  };

  for (const pick of picks) {
    if (shouldStop()) {
      result.stoppedEarly = true;
      break;
    }
    const inserted = await store.insertEnrollment({
      user_id: automation.user_id,
      automation_id: automation.id,
      contact_id: pick.contact_id,
      email: pick.email,
      cohort: pick.cohort,
      recency_days: pick.recency_days,
    });
    if (!inserted) {
      result.alreadyEnrolled++;
      continue;
    }
    result.enrolled++;
    if (pick.cohort === 'control') {
      result.control++;
      continue;
    }
    result.treatment++;
    try {
      await run(pick);
    } catch (err) {
      result.runErrors++;
      console.error(
        '[regua] automation run failed for an enrolled contact',
        pick.contact_id,
        err
      );
    }
  }
  return result;
}
