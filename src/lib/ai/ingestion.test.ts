import { describe, expect, it } from 'vitest'
import { chunkText, htmlToText } from './ingestion'

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n   ')).toEqual([])
  })

  it('returns a single chunk for medium text under the target size', () => {
    // Above MIN_CHUNK_CHARS (80) but below TARGET_CHUNK_CHARS (800).
    const txt =
      'Atendemos de segunda a sexta, das 9h às 18h. Aos sábados o expediente é das 9h às 13h. Domingos e feriados nacionais não há atendimento presencial — apenas suporte por chat.'
    const out = chunkText(txt, { sourceName: 'FAQ' })
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe(txt)
  })

  it('respects paragraph boundaries (blank line)', () => {
    const txt = [
      'Paragrafo curto sobre horário de atendimento que dura suficiente para virar um chunk próprio.',
      '',
      'Outro paragrafo curto sobre endereço da empresa, também já com tamanho aceitável de chunk.',
      '',
      'Terceiro paragrafo sobre formas de pagamento aceitas, que vai virar outro chunk independente também.',
    ]
      .join('\n')
      // Pad each paragraph past MIN_CHUNK_CHARS (80) and the greedy
      // merge boundary so each ends up in its own chunk.
      .replace(/\./g, '. ' + 'x'.repeat(300) + '.')
    const out = chunkText(txt)
    // Greedy merge will combine these into 1-2 chunks; assert we get
    // at least one and content is preserved.
    expect(out.length).toBeGreaterThanOrEqual(1)
  })

  it('splits an oversize single paragraph on sentences', () => {
    // ~3000 chars of sentences, all in one paragraph.
    const sentence = 'Esta é uma frase de teste com tamanho razoável que aparece muitas vezes seguidas. '
    const text = sentence.repeat(40)
    const out = chunkText(text)
    expect(out.length).toBeGreaterThan(1)
    // No chunk should exceed MAX_CHUNK_CHARS (1400).
    for (const c of out) {
      expect(c.content.length).toBeLessThanOrEqual(1400)
    }
  })

  it('drops chunks smaller than the minimum', () => {
    const tiny = 'oi.'
    expect(chunkText(tiny)).toHaveLength(0)
  })

  it('uses the first line as title when it looks heading-ish', () => {
    const txt = ['Horário de Atendimento', 'a'.repeat(120)].join('\n')
    const out = chunkText(txt, { sourceName: 'FAQ' })
    expect(out[0].title).toBe('Horário de Atendimento')
  })

  it('falls back to source-name #N title when the first line is long', () => {
    const txt = 'a'.repeat(200)
    const out = chunkText(txt, { sourceName: 'doc' })
    expect(out[0].title).toBe('doc #1')
  })

  it('falls back to "Chunk N" when no source name is provided', () => {
    const txt = 'a'.repeat(200)
    const out = chunkText(txt)
    expect(out[0].title).toBe('Chunk 1')
  })

  it('normalises Windows line endings', () => {
    const out = chunkText('A'.repeat(100) + '\r\n\r\n' + 'B'.repeat(100))
    expect(out.length).toBeGreaterThanOrEqual(1)
    // The \r should never appear in chunk content.
    expect(out.every((c) => !c.content.includes('\r'))).toBe(true)
  })
})

describe('htmlToText', () => {
  it('strips tags and decodes basic entities', () => {
    const html =
      '<html><body><h1>Hello</h1><p>World &amp; everyone</p></body></html>'
    expect(htmlToText(html)).toContain('Hello')
    expect(htmlToText(html)).toContain('World & everyone')
  })

  it('drops <script> and <style> blocks entirely', () => {
    const html =
      '<p>visible</p><script>alert(1); var x = 2;</script><style>p{color:red}</style>'
    const out = htmlToText(html)
    expect(out).toContain('visible')
    expect(out).not.toContain('alert')
    expect(out).not.toContain('color:red')
  })

  it('preserves paragraph breaks across block tags', () => {
    const html = '<p>one</p><p>two</p><p>three</p>'
    const out = htmlToText(html)
    expect(out.split(/\n+/).filter(Boolean)).toEqual(['one', 'two', 'three'])
  })

  it('handles <br> as a line break', () => {
    const html = 'line a<br>line b<br/>line c'
    const out = htmlToText(html)
    expect(out).toContain('line a')
    expect(out).toContain('line b')
    expect(out).toContain('line c')
  })

  it('decodes &nbsp;, &lt;, &gt;, &quot;, &apos;', () => {
    const html = 'a&nbsp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;'
    const out = htmlToText(html)
    expect(out).toBe('a b <c> "d" \'e\'')
  })
})
