import type {
  AutomationStepConfig,
  AutomationStepType,
  AutomationTriggerConfig,
  AutomationTriggerType,
} from '@/types'

export type TemplateSlug =
  | 'welcome_message'
  | 'out_of_office'
  | 'lead_qualifier'
  | 'follow_up_reminder'
  | 'promo_offer_follow_up'

export interface TemplateStepSeed {
  step_type: AutomationStepType
  step_config: AutomationStepConfig
  branch?: 'yes' | 'no' | null
  /** Index (within this seed list) of the Condition parent, if nested. */
  parent_index?: number | null
}

export interface AutomationTemplateDefinition {
  slug: TemplateSlug
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: AutomationTriggerConfig
  steps: TemplateStepSeed[]
}

export const AUTOMATION_TEMPLATES: Record<TemplateSlug, AutomationTemplateDefinition> = {
  welcome_message: {
    slug: 'welcome_message',
    name: 'Welcome Message',
    description: 'Auto-reply to first-time contacts with a greeting.',
    // first_inbound_message (added in PR #33) catches both brand-new
    // contacts AND manually-added/imported contacts on their first-ever
    // reply, which is what a user setting up a "welcome" automation
    // almost always wants. new_contact_created would miss the
    // manually-imported case.
    trigger_type: 'first_inbound_message',
    trigger_config: {},
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      {
        step_type: 'add_tag',
        step_config: { tag_id: '' },
      },
    ],
  },
  out_of_office: {
    slug: 'out_of_office',
    name: 'Out of Office',
    description: 'Auto-reply during off-hours so nobody is left waiting.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'condition',
        step_config: {
          subject: 'time_of_day',
          operand: '18:00-09:00',
        },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
        },
        parent_index: 0,
        branch: 'yes',
      },
    ],
  },
  lead_qualifier: {
    slug: 'lead_qualifier',
    name: 'Lead Qualifier',
    description: 'Ask qualification questions to filter inbound leads.',
    trigger_type: 'keyword_match',
    trigger_config: {
      keywords: ['pricing', 'quote', 'buy'],
      match_type: 'contains',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?",
        },
      },
      {
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ],
  },
  follow_up_reminder: {
    slug: 'follow_up_reminder',
    name: 'Follow-up Reminder',
    description: 'Send a nudge if a contact has not replied within 24 hours.',
    trigger_type: 'new_message_received',
    trigger_config: {},
    steps: [
      {
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
      },
      {
        step_type: 'send_message',
        step_config: {
          text:
            "Just circling back — did you have any other questions for us? Happy to help!",
        },
      },
    ],
  },
  // ─────────────────────────────────────────────────────────────
  // Promo offer follow-up — the cost-strategy starter.
  // See docs/whatsapp-cost-strategy.md for the full pattern.
  //
  // Pairs with a UTILITY template that has a Quick Reply button
  // labeled "Ver minha seleção" (or similar). When the contact
  // taps the button, Meta delivers the tap as an inbound message
  // (button title becomes message_text), which opens the 24h
  // service window. This automation matches the button title and
  // immediately sends the actual promo pitch via free-form —
  // grátis instead of paying for a Marketing template.
  //
  // Customize: replace the keyword list with the QR titles of
  // YOUR utility-abridor template, and rewrite the send_message
  // body with your real offer copy.
  // ─────────────────────────────────────────────────────────────
  promo_offer_follow_up: {
    slug: 'promo_offer_follow_up',
    name: 'Promo follow-up (free in-window)',
    description:
      'Send the actual promo pitch via free-form when a contact taps the Quick Reply on your Utility-abridor template. Grátis instead of paid.',
    trigger_type: 'keyword_match',
    trigger_config: {
      // These must match the EXACT button title text on the Utility
      // template. Edit after creating the automation to fit your
      // own template's Quick Reply labels.
      keywords: [
        'Ver minha seleção',
        'Ver linha PLUS',
        'Acessar agora',
        'Sim, mandar',
        'Finalizar pedido',
        'Ver outras peças',
      ],
      match_type: 'exact',
    },
    steps: [
      {
        step_type: 'send_message',
        step_config: {
          text:
            'Oi! Aqui está a campanha completa:\n\n3 peças regulares por R$ 99,99 (códigos 404, 407, 331, 423, 401).\nLinha PLUS 3 por R$ 199,90 (códigos 900, 901, 909).\n\nQuer que eu te mande os mais procurados esta semana?',
        },
      },
    ],
  },
}

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null
}
