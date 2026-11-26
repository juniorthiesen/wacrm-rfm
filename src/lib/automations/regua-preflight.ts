import type { SupabaseClient } from '@supabase/supabase-js';
import { loadStoreConnector } from '@/lib/commerce/connector';
import { supabaseEmailStore } from '@/lib/email/store';
import { maxMarketingEmailsPerPath, type PathStepRow } from './email-path';
import {
  evaluateRegueReadiness,
  parseRecencyConfig,
  type Readiness,
} from './regua';

/**
 * Gathers, for one recency automation, what its sequence depends on and runs
 * the pure readiness rules (regua.ts). Shared by the daily cron (which must NOT
 * enrol anyone when the sequence cannot run) and the dry run (which only warns).
 *
 * Why this exists: the engine records a failed step in the automation log but
 * does not throw. Without this guard, activating the régua while the e-mail
 * channel is off would enrol up to `daily_cap` people per day whose first step
 * fails silently, and they would never be enrolled again.
 */
export async function loadRegueReadiness(
  db: SupabaseClient,
  automation: { id: string; user_id: string; trigger_config: unknown }
): Promise<Readiness & { emailStepCount: number; hasCouponStep: boolean }> {
  const { data: steps, error } = await db
    .from('automation_steps')
    .select('id, parent_step_id, branch, step_type, step_config')
    .eq('automation_id', automation.id);
  if (error)
    throw new Error(`[regua-preflight] could not read steps: ${error.message}`);

  const list = (steps ?? []) as PathStepRow[];
  // E-mails ONE person can receive (an A/B split delivers a single variant, so
  // its branches do not add up). Transactional e-mail is not subject to the
  // marketing daily limit.
  const emailStepCount = maxMarketingEmailsPerPath(list);
  const hasCouponStep = list.some((s) => s.step_type === 'create_coupon');

  const emailConfig =
    emailStepCount > 0
      ? await supabaseEmailStore(db).getConfig(automation.user_id)
      : null;

  let connectorReady = false;
  if (hasCouponStep) {
    try {
      connectorReady = !!(await loadStoreConnector(db, automation.user_id));
    } catch {
      connectorReady = false;
    }
  }

  const parsed = parseRecencyConfig(automation.trigger_config);
  const readiness = evaluateRegueReadiness({
    configuredCap: parsed.ok ? parsed.value.daily_cap : 0,
    emailStepCount,
    hasCouponStep,
    emailActive:
      !!emailConfig &&
      emailConfig.is_active &&
      !!emailConfig.api_key_encrypted &&
      !!emailConfig.from_email,
    emailDailyLimit: emailConfig ? emailConfig.daily_limit : null,
    siteUrlSet: !!process.env.NEXT_PUBLIC_SITE_URL,
    connectorReady,
  });
  return { ...readiness, emailStepCount, hasCouponStep };
}
