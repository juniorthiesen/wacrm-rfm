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
  | 'reativacao_90_dias'
  | 'carrinho_abandonado_email'
  | 'link_magico_email'

/** Slugs defined below the generic ones (tenant-specific copy, DLY). */
type DlyTemplateSlug = 'reativacao_90_dias' | 'carrinho_abandonado_email' | 'link_magico_email'

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

const BASE_TEMPLATES: Record<Exclude<TemplateSlug, DlyTemplateSlug>, AutomationTemplateDefinition> = {
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

/**
 * Win-back régua for customers 90+ days without buying (see
 * docs/handoff-email-channel.md, sections 3 and 12).
 *
 * Shape (relative to the day the person is enrolled, D0):
 *   D0   e-mail "sentimos sua falta" (no coupon)
 *   D7   if they have not bought: create a personal coupon (single use, tied to
 *        their e-mail, expires in 10 days) + e-mail with the coupon
 *   D14  if still not bought: "seu cupom vence em 3 dias" reminder
 * The whole sequence is created INACTIVE. The `recency_reached` trigger enrols
 * people daily with a cap and a control group; run the dry run
 * (POST /api/automations/[id]/dry-run) before activating.
 *
 * TENANT-SPECIFIC (move to tenant config when this becomes a product): the
 * copy, the dly.com.br links and the R$ 20 / R$ 100 / 10-day coupon.
 */
const REATIVACAO_90_DIAS: AutomationTemplateDefinition = {
  slug: 'reativacao_90_dias',
  name: 'Régua de reativação (90+ dias sem comprar)',
  description:
    'Inscreve clientes parados uma única vez: e-mail, cupom pessoal de uso único uma semana depois e um último lembrete. Inclui grupo de controle para medir o efeito real.',
  trigger_type: 'recency_reached',
  trigger_config: { min_days: 90, max_days: 364, daily_cap: 100, control_percent: 10 },
  steps: [
    // 0 — D0
    {
      step_type: 'send_email',
      step_config: {
        subject: '{{customer.first_name|Oi}}, sentimos sua falta',
        heading: 'Sentimos sua falta',
        body:
          'Oi, {{customer.first_name|linda}}.\n\nFaz um tempo que você não passa por aqui. Separamos as novidades em calcinhas, sutiãs e kits para você voltar quando quiser.',
        cta_label: 'Ver novidades',
        cta_url: 'https://dly.com.br/',
        benefit: 'Pague no Pix ou em até 6x sem juros.',
        category: 'marketing',
        campaign_key: 'reativacao_d0',
      },
    },
    // 1 — wait a week
    { step_type: 'wait', step_config: { amount: 7, unit: 'days' } },
    // 2 — bought since entering? yes: the sequence ends. no: continue below.
    { step_type: 'condition', step_config: { subject: 'purchased_since_enrollment' } },
    // 3 — personal coupon (WooCommerce enforces single use + e-mail + expiry)
    {
      step_type: 'create_coupon',
      parent_index: 2,
      branch: 'no',
      step_config: {
        code_prefix: 'VOLTA',
        discount_type: 'fixed_cart',
        amount: 20,
        minimum_amount: 100,
        valid_days: 10,
      },
    },
    // 4 — D7 e-mail with the coupon box
    {
      step_type: 'send_email',
      parent_index: 2,
      branch: 'no',
      step_config: {
        subject: '{{customer.first_name|Oi}}, um presente para você voltar',
        heading: 'Um presente para você voltar',
        body: 'Oi, {{customer.first_name|linda}}.\n\nLiberamos um cupom só seu, válido por 10 dias.',
        coupon_code: '{{vars.coupon_code}}',
        coupon_headline: 'R$ 20 de desconto',
        coupon_note: 'Válido por 10 dias, em compras a partir de R$ 100, só para este e-mail.',
        cta_label: 'Usar meu cupom',
        cta_url: 'https://dly.com.br/',
        benefit: 'Pague no Pix ou em até 6x sem juros.',
        category: 'marketing',
        campaign_key: 'reativacao_d7',
      },
    },
    // 5 — wait another week (D14)
    { step_type: 'wait', parent_index: 2, branch: 'no', step_config: { amount: 7, unit: 'days' } },
    // 6 — still not bought?
    {
      step_type: 'condition',
      parent_index: 2,
      branch: 'no',
      step_config: { subject: 'purchased_since_enrollment' },
    },
    // 7 — D14 last reminder (the coupon has 3 days left)
    {
      step_type: 'send_email',
      parent_index: 6,
      branch: 'no',
      step_config: {
        subject: 'Seu cupom de R$ 20 vence em 3 dias',
        heading: 'Seu cupom vence em 3 dias',
        body: 'Oi, {{customer.first_name|linda}}.\n\nEste é o último lembrete: seu cupom pessoal vence em 3 dias.',
        coupon_code: '{{vars.coupon_code}}',
        coupon_headline: 'R$ 20 de desconto',
        coupon_note: 'Válido por mais 3 dias, em compras a partir de R$ 100, só para este e-mail.',
        cta_label: 'Usar meu cupom agora',
        cta_url: 'https://dly.com.br/',
        category: 'marketing',
        campaign_key: 'reativacao_d14',
      },
    },
  ],
}

/**
 * Cart recovery by e-mail, fed by the WooCommerce checkout plugin's webhook
 * (POST /api/integrations/woocommerce/carts). Replaces the plugin's own three
 * e-mails (1 h / 24 h / 72 h, no unsubscribe link) with the same cadence sent
 * from the e-mail channel, so every message carries a working "cancelar inscrição"
 * and respects the suppression list.
 *
 * Timing: the plugin only reports a cart after 15 min of inactivity and syncs
 * every 10 min, so "wait 45 min" lands the first e-mail about 1 h after the
 * abandonment. {{cart.recovery_url}} is the plugin's recovery link: it restores
 * the cart and pre-fills the checkout.
 *
 * Each e-mail opts out of the per-address marketing gap (respect_min_gap: false):
 * the customer started this sequence, and three e-mails in three days would
 * otherwise be blocked by the "1 e-mail every 3 days" rule. The daily cap and the
 * suppression list still apply.
 *
 * TENANT-SPECIFIC (move to tenant config when this becomes a product): copy,
 * links and the 5% / 7-day coupon.
 */
const CARRINHO_ABANDONADO_EMAIL: AutomationTemplateDefinition = {
  slug: 'carrinho_abandonado_email',
  name: 'Carrinho abandonado (e-mail, 3 lembretes)',
  description:
    'Recupera quem deixou o carrinho: lembrete cerca de 1 h depois, outro com 24 h e um último com cupom de 5%, sempre com o link que restaura o carrinho. Para quando a pessoa compra.',
  trigger_type: 'cart_abandoned',
  trigger_config: {},
  steps: [
    // 0 — the plugin reports ~25 min after the last activity; +45 min ≈ 1 h
    { step_type: 'wait', step_config: { amount: 45, unit: 'minutes' } },
    // 1 — bought meanwhile? yes: ends. no: continue below.
    { step_type: 'condition', step_config: { subject: 'purchased_since_enrollment' } },
    // 2 — e-mail 1 (~1 h)
    {
      step_type: 'send_email',
      parent_index: 1,
      branch: 'no',
      step_config: {
        subject: '{{customer.first_name|Oi}}, você esqueceu algo no carrinho',
        preheader: 'Suas peças ainda estão separadas para você.',
        heading: 'Suas peças ainda estão aqui',
        body:
          'Oi, {{customer.first_name|linda}}.\n\nVocê deixou estas peças no carrinho:\n\n{{cart.items_list}}\n\nTotal: {{cart.total}}. É só voltar de onde parou.',
        cta_label: 'Voltar ao meu carrinho',
        cta_url: '{{cart.recovery_url}}',
        benefit: 'Pague no Pix ou em até 6x sem juros.',
        category: 'marketing',
        respect_min_gap: false,
        campaign_key: 'carrinho_d0',
      },
    },
    // 3 — wait until ~24 h after the abandonment
    { step_type: 'wait', parent_index: 1, branch: 'no', step_config: { amount: 23, unit: 'hours' } },
    // 4 — still not bought?
    {
      step_type: 'condition',
      parent_index: 1,
      branch: 'no',
      step_config: { subject: 'purchased_since_enrollment' },
    },
    // 5 — e-mail 2 (~24 h)
    {
      step_type: 'send_email',
      parent_index: 4,
      branch: 'no',
      step_config: {
        subject: '{{customer.first_name|Oi}}, seu carrinho ainda está esperando',
        preheader: 'Ficou com alguma dúvida? É só responder este e-mail.',
        heading: 'Seu carrinho ainda está esperando',
        body:
          'Oi, {{customer.first_name|linda}}.\n\nSeparamos suas peças:\n\n{{cart.items_list}}\n\nSe ficou com alguma dúvida de tamanho ou de entrega, é só responder este e-mail que a gente ajuda.',
        cta_label: 'Finalizar minha compra',
        cta_url: '{{cart.recovery_url}}',
        benefit: 'Troca fácil e frete calculado antes de pagar.',
        category: 'marketing',
        respect_min_gap: false,
        campaign_key: 'carrinho_d1',
      },
    },
    // 6 — wait until ~72 h after the abandonment
    { step_type: 'wait', parent_index: 4, branch: 'no', step_config: { amount: 48, unit: 'hours' } },
    // 7 — still not bought?
    {
      step_type: 'condition',
      parent_index: 4,
      branch: 'no',
      step_config: { subject: 'purchased_since_enrollment' },
    },
    // 8 — personal coupon (WooCommerce enforces single use + e-mail + expiry)
    {
      step_type: 'create_coupon',
      parent_index: 7,
      branch: 'no',
      step_config: {
        code_prefix: 'VOLTEI',
        discount_type: 'percent',
        amount: 5,
        valid_days: 7,
      },
    },
    // 9 — e-mail 3 (~72 h) with the coupon box
    {
      step_type: 'send_email',
      parent_index: 7,
      branch: 'no',
      step_config: {
        subject: '{{customer.first_name|Oi}}, 5% de desconto para finalizar',
        preheader: 'Um cupom só seu, válido por 7 dias.',
        heading: 'Um cupom para você finalizar',
        body:
          'Oi, {{customer.first_name|linda}}.\n\nSeu carrinho continua guardado:\n\n{{cart.items_list}}\n\nLiberamos um cupom só seu para você fechar a compra.',
        coupon_code: '{{vars.coupon_code}}',
        coupon_headline: '5% de desconto',
        coupon_note: 'Digite o código no checkout. Válido por 7 dias, só para este e-mail.',
        cta_label: 'Voltar ao meu carrinho',
        cta_url: '{{cart.recovery_url}}',
        category: 'marketing',
        respect_min_gap: false,
        campaign_key: 'carrinho_d3',
      },
    },
  ],
}

/**
 * Sends the SmartCheckout "magic login" link by e-mail. The plugin's webhook fires
 * when the customer asks for a login link; confirm that the shop does not ALSO
 * e-mail it through WordPress before turning this on, or the customer gets two.
 * Transactional: no unsubscribe link, no marketing limits (the customer just asked).
 */
const LINK_MAGICO_EMAIL: AutomationTemplateDefinition = {
  slug: 'link_magico_email',
  name: 'Link mágico de acesso (e-mail)',
  description:
    'Envia por e-mail o link de acesso sem senha pedido no checkout. Transacional. Antes de ativar, confirme que o WordPress não envia o mesmo e-mail.',
  trigger_type: 'customer_magic_login_requested',
  trigger_config: {},
  steps: [
    {
      step_type: 'send_email',
      step_config: {
        subject: 'Seu link de acesso à DLY',
        preheader: 'Entre sem precisar de senha.',
        heading: 'Seu link de acesso',
        body:
          'Oi, {{customer.first_name|linda}}.\n\nClique no botão abaixo para entrar na sua conta, sem senha. Se não foi você que pediu, pode ignorar este e-mail.',
        cta_label: 'Entrar na minha conta',
        cta_url: '{{magic_login.url}}',
        category: 'transactional',
        campaign_key: 'link_magico',
      },
    },
  ],
}

export const AUTOMATION_TEMPLATES: Record<TemplateSlug, AutomationTemplateDefinition> = {
  ...BASE_TEMPLATES,
  reativacao_90_dias: REATIVACAO_90_DIAS,
  carrinho_abandonado_email: CARRINHO_ABANDONADO_EMAIL,
  link_magico_email: LINK_MAGICO_EMAIL,
}

export function getTemplate(slug: string): AutomationTemplateDefinition | null {
  return AUTOMATION_TEMPLATES[slug as TemplateSlug] ?? null
}
