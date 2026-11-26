import type { AutomationTriggerType } from '@/types'
import { parseRecencyConfig } from './regua'
import { parseAbOperand } from './ab-bucket'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  message: string
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
    })
    return issues
  }
  walk(steps, '', issues)
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues)
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues)
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues)
    }
  })
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: 'message text is required' })
      }
      break
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: 'template name is required' })
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required' })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: 'field name is required' })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'field value is required' })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: 'pipeline is required' })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required' })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required' })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'wait amount must be greater than 0' })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
        })
      }
      break
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({ path: `${path}.subject`, message: 'condition subject is required' })
      }
      // purchased_since_enrollment reads vars.enrolled_at: it has no operand.
      if (c.subject !== 'purchased_since_enrollment' && !nonEmpty(c.operand)) {
        issues.push({ path: `${path}.operand`, message: 'condition operand is required' })
      }
      // ab_bucket: "N:K" with 2 <= N <= 10 and 0 <= K < N, e.g. "3:1".
      if (c.subject === 'ab_bucket' && nonEmpty(c.operand) && !parseAbOperand(String(c.operand))) {
        issues.push({
          path: `${path}.operand`,
          message: 'A/B split operand must look like "3:1" (group 1 of 3; between 2 and 10 groups)',
        })
      }
      break
    case 'create_coupon': {
      const amount = Number(c.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'coupon amount must be greater than zero' })
      } else if (c.discount_type === 'percent' && amount > 100) {
        issues.push({ path: `${path}.amount`, message: 'percent coupons cannot exceed 100' })
      }
      if (c.discount_type !== 'fixed_cart' && c.discount_type !== 'percent') {
        issues.push({
          path: `${path}.discount_type`,
          message: 'coupon type must be fixed_cart or percent',
        })
      }
      const days = Number(c.valid_days)
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        issues.push({
          path: `${path}.valid_days`,
          message: 'coupon validity must be between 1 and 90 days',
        })
      }
      if (c.minimum_amount !== undefined && c.minimum_amount !== '' && !(Number(c.minimum_amount) >= 0)) {
        issues.push({ path: `${path}.minimum_amount`, message: 'minimum cart value cannot be negative' })
      }
      break
    }
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required' })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL' })
      }
      break
    case 'send_email': {
      if (!nonEmpty(c.subject)) {
        issues.push({ path: `${path}.subject`, message: 'e-mail subject is required' })
      }
      if (!nonEmpty(c.heading)) {
        issues.push({ path: `${path}.heading`, message: 'e-mail heading is required' })
      }
      if (!nonEmpty(c.body)) {
        issues.push({ path: `${path}.body`, message: 'e-mail body is required' })
      }
      const hasLabel = nonEmpty(c.cta_label)
      const hasUrl = nonEmpty(c.cta_url)
      if (hasLabel !== hasUrl) {
        issues.push({
          path: `${path}.cta_url`,
          message: 'button text and URL must be filled together',
        })
      } else if (hasUrl && !/^(https?:\/\/|\{\{)/i.test(String(c.cta_url).trim())) {
        issues.push({
          path: `${path}.cta_url`,
          message: 'button URL must start with http(s):// or a {{variable}}',
        })
      }
      if (
        c.category !== undefined &&
        c.category !== 'marketing' &&
        c.category !== 'transactional'
      ) {
        issues.push({
          path: `${path}.category`,
          message: 'e-mail type must be marketing or transactional',
        })
      }
      break
    }
    case 'close_conversation':
      // No config required.
      break
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}` })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings' })
    }
    if (cfg.match_type !== 'exact' && cfg.match_type !== 'contains') {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
      })
    }
  } else if (triggerType === 'time_based') {
    if (!nonEmpty(cfg.schedule)) {
      issues.push({ path: 'trigger.schedule', message: 'schedule is required' })
    }
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required' })
    }
  } else if (triggerType === 'recency_reached') {
    const parsed = parseRecencyConfig(cfg)
    if (!parsed.ok) {
      for (const message of parsed.errors) issues.push({ path: 'trigger', message })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}
