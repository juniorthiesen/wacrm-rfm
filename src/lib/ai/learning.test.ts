import { describe, expect, it } from 'vitest'
import { __testing } from './learning'

const { parseExtraction } = __testing

describe('parseExtraction', () => {
  it('accepts well-formed JSON with extract:true', () => {
    const out = parseExtraction(
      '{"extract": true, "title": "Horário", "content": "9h às 18h"}',
    )
    expect(out).toEqual({ title: 'Horário', content: '9h às 18h' })
  })

  it('returns null when extract is false', () => {
    expect(
      parseExtraction(
        '{"extract": false, "reason": "only a greeting"}',
      ),
    ).toBeNull()
  })

  it('strips ```json fences some models emit', () => {
    const raw = '```json\n{"extract": true, "title": "X", "content": "Y"}\n```'
    expect(parseExtraction(raw)).toEqual({ title: 'X', content: 'Y' })
  })

  it('strips a plain ``` fence too', () => {
    const raw = '```\n{"extract": true, "title": "X", "content": "Y"}\n```'
    expect(parseExtraction(raw)).toEqual({ title: 'X', content: 'Y' })
  })

  it('returns null on invalid JSON', () => {
    expect(parseExtraction('not json at all')).toBeNull()
  })

  it('returns null if title or content is empty after trim', () => {
    expect(
      parseExtraction(
        '{"extract": true, "title": "   ", "content": "x"}',
      ),
    ).toBeNull()
    expect(
      parseExtraction(
        '{"extract": true, "title": "ok", "content": ""}',
      ),
    ).toBeNull()
  })

  it('returns null when extract is missing entirely', () => {
    expect(
      parseExtraction('{"title": "Horário", "content": "x"}'),
    ).toBeNull()
  })

  it('trims surrounding whitespace from title/content', () => {
    const out = parseExtraction(
      '{"extract": true, "title": "  Horário  ", "content": "  x  "}',
    )
    expect(out).toEqual({ title: 'Horário', content: 'x' })
  })
})
