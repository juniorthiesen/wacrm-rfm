import { describe, expect, it } from 'vitest'
import {
  hasVariableAtBounds,
  isNameConflictError,
  suggestNextName,
  MAX_TEMPLATE_NAME_LENGTH,
  TEMPLATE_NAME_RE,
} from './template-name'

describe('isNameConflictError', () => {
  it('matches the English deletion-conflict message', () => {
    expect(
      isNameConflictError({
        message:
          'You cannot add new content in Portuguese (BR) while existing content in Portuguese (BR) is being deleted. Try again in less than 1 minute or create another message template.',
      }),
    ).toBe(true)
  })

  it('matches the localised Portuguese error_user_msg', () => {
    expect(
      isNameConflictError({
        message: '(#100) Invalid parameter',
        error_user_msg:
          'Não é possível adicionar novo conteúdo em Portuguese (BR) enquanto o conteúdo existente em Portuguese (BR) está sendo excluído. Tente novamente em less than 1 minute ou crie outro modelo de mensagem.',
      }),
    ).toBe(true)
  })

  it('rejects unrelated Meta errors', () => {
    expect(
      isNameConflictError({
        message: '(#132001) Template name does not exist in the translation',
      }),
    ).toBe(false)
    expect(isNameConflictError({ message: 'Invalid OAuth access token' })).toBe(
      false,
    )
  })

  it('handles missing input', () => {
    expect(isNameConflictError(undefined)).toBe(false)
    expect(isNameConflictError(null)).toBe(false)
    expect(isNameConflictError({})).toBe(false)
  })
})

describe('hasVariableAtBounds', () => {
  it('flags a body that ends with a variable', () => {
    expect(
      hasVariableAtBounds(
        'Olá, *{{1}}*!\n\nRecebemos seu pedido *#{{2}}*.\nUse o Pix abaixo:\n\n{{3}}',
      ),
    ).toBe(true)
    expect(hasVariableAtBounds('Código: {{1}}  ')).toBe(true)
  })

  it('flags a body that starts with a variable', () => {
    expect(hasVariableAtBounds('{{1}}, seu pedido chegou!')).toBe(true)
    expect(hasVariableAtBounds('  {{ 1 }} no início')).toBe(true)
  })

  it('flags a body that is only a variable', () => {
    expect(hasVariableAtBounds('{{1}}')).toBe(true)
  })

  it('accepts variables in the middle', () => {
    expect(
      hasVariableAtBounds('Pagamento confirmado, *{{1}}*! Pedido *#{{2}}* ok.'),
    ).toBe(false)
    expect(hasVariableAtBounds('Sem variável nenhuma.')).toBe(false)
  })
})

describe('suggestNextName', () => {
  it('appends _v2 to a plain name', () => {
    expect(suggestNextName('woo_order_paid', [])).toBe('woo_order_paid_v2')
  })

  it('skips suffixes that are already taken', () => {
    expect(
      suggestNextName('woo_order_paid', [
        'woo_order_paid',
        'woo_order_paid_v2',
        'woo_order_paid_v3',
      ]),
    ).toBe('woo_order_paid_v4')
  })

  it('bumps an existing _vN suffix instead of stacking', () => {
    expect(suggestNextName('woo_order_paid_v2', [])).toBe('woo_order_paid_v3')
    expect(suggestNextName('promo_v10', [])).toBe('promo_v11')
  })

  it('only treats a trailing _vN as a version suffix', () => {
    expect(suggestNextName('inv_v2_report', [])).toBe('inv_v2_report_v2')
  })

  it('keeps the result within Meta name-length limits and valid charset', () => {
    const longBase = 'a'.repeat(MAX_TEMPLATE_NAME_LENGTH)
    const result = suggestNextName(longBase, [])
    expect(result.length).toBeLessThanOrEqual(MAX_TEMPLATE_NAME_LENGTH)
    expect(result.endsWith('_v2')).toBe(true)
    expect(TEMPLATE_NAME_RE.test(result)).toBe(true)
  })
})
