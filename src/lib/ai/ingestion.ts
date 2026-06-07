/**
 * Document ingestion — Phase 6.
 *
 * Pure-text first: paste a chunk of text (FAQ document, knowledge
 * dump) OR a URL, and we slice it into KB-sized rows.
 *
 * No PDF: a real PDF extractor (pdfjs / pdf-parse) adds ~5–10 MB to
 * the bundle and brings its own native quirks. Operators can paste
 * extracted text instead. We'll add a real PDF path in a later phase
 * if demand exists.
 *
 * Why chunking: a 50 KB doc as a single embedding loses local detail
 * — the vector averages across topics and the cosine search picks
 * the doc whether the question is about hours or returns. Smaller
 * chunks let each topic land on its own row.
 */

/** Target characters per chunk. KB rows the model actually reads as
 *  context — too small means too many rows match for a single answer,
 *  too large means lost specificity. ~800 chars ≈ 200 tokens. */
const TARGET_CHUNK_CHARS = 800
const MAX_CHUNK_CHARS = 1400
const MIN_CHUNK_CHARS = 80

export interface Chunk {
  /** Sequential index within the source — used to build titles. */
  index: number
  /** Best-effort short label for the chunk. May be derived from the
   *  first line or default to "{source} #N". */
  title: string
  content: string
}

/**
 * Split text into paragraph-respecting chunks. Algorithm:
 *
 *   1. Pre-split on blank lines → paragraphs.
 *   2. Greedily concatenate paragraphs while the running buffer is
 *      under TARGET_CHUNK_CHARS.
 *   3. Any paragraph already larger than MAX_CHUNK_CHARS gets a
 *      sentence-level fallback split on `.!?` boundaries.
 *   4. Drop chunks shorter than MIN_CHUNK_CHARS — they're usually
 *      page headers / footers and create noise in retrieval.
 */
export function chunkText(
  text: string,
  options: { sourceName?: string } = {},
): Chunk[] {
  const cleaned = normaliseWhitespace(text)
  if (!cleaned) return []

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)

  const expanded: string[] = []
  for (const p of paragraphs) {
    if (p.length <= MAX_CHUNK_CHARS) {
      expanded.push(p)
      continue
    }
    // Big paragraph — split on sentence boundaries.
    const sentences = splitSentences(p)
    let buf = ''
    for (const s of sentences) {
      if (buf && buf.length + s.length + 1 > MAX_CHUNK_CHARS) {
        expanded.push(buf.trim())
        buf = ''
      }
      buf = buf ? `${buf} ${s}` : s
    }
    if (buf) expanded.push(buf.trim())
  }

  // Greedy merge of small paragraphs into target-sized chunks.
  const merged: string[] = []
  let current = ''
  for (const piece of expanded) {
    if (!current) {
      current = piece
      continue
    }
    if (current.length + piece.length + 2 <= TARGET_CHUNK_CHARS) {
      current = `${current}\n\n${piece}`
    } else {
      merged.push(current)
      current = piece
    }
  }
  if (current) merged.push(current)

  return merged
    .filter((c) => c.length >= MIN_CHUNK_CHARS)
    .map((content, i) => ({
      index: i,
      title: deriveTitle(content, i, options.sourceName),
      content,
    }))
}

function deriveTitle(
  content: string,
  index: number,
  sourceName?: string,
): string {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? ''
  // Use the first line if it looks heading-ish: short and doesn't end
  // mid-sentence. Otherwise fall back to the source name + index.
  const trimmed = firstLine.trim()
  if (trimmed.length > 0 && trimmed.length <= 80 && !/[,;]$/.test(trimmed)) {
    return trimmed
  }
  return sourceName ? `${sourceName} #${index + 1}` : `Chunk ${index + 1}`
}

function normaliseWhitespace(s: string): string {
  return s
    // Collapse \r\n and \r into \n.
    .replace(/\r\n?/g, '\n')
    // Tab/NBSP → single space.
    .replace(/[\t ]+/g, ' ')
    // Squeeze runs of spaces.
    .replace(/ {2,}/g, ' ')
    .trim()
}

function splitSentences(p: string): string[] {
  // Naive but good-enough: split AFTER terminal punctuation followed
  // by whitespace. Doesn't handle abbreviations ("Dr." "Sr.") but
  // those produce slightly-too-many breaks, not wrong answers.
  return p.split(/(?<=[.!?])\s+/).filter(Boolean)
}

// ─── URL ingestion ─────────────────────────────────────────────────────

/**
 * Fetch a URL and extract a plain-text approximation.
 *
 * Strategy: drop `<script>` and `<style>` blocks, strip remaining
 * tags, decode the half-dozen entities that actually show up in real
 * HTML. We do this with regexes rather than pulling in a real HTML
 * parser (cheerio/jsdom) because (a) the output goes into an
 * embedding, where small parsing artefacts cost basically nothing,
 * and (b) those parsers blow up the bundle.
 *
 * Failure modes are visible (bad encoding, JS-rendered SPA returning
 * an empty body); we surface them to the caller verbatim.
 */
export async function fetchTextFromUrl(
  url: string,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ text: string; final_url: string }> {
  const u = parseHttpUrl(url)
  if (!u) throw new Error('Invalid URL — only http(s) supported')

  const timeoutMs = options.timeoutMs ?? 15_000
  const maxBytes = options.maxBytes ?? 1_500_000 // ~1.5 MB

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(u.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Some sites refuse default Node user-agents.
        'User-Agent':
          'Mozilla/5.0 (compatible; wacrm-ingest/1.0; +https://github.com/ArnasDon/wacrm)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
    })
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from ${u.host}`)
    }

    // Cap the body — defends against a 200 GB stream of nothing.
    const reader = resp.body?.getReader()
    if (!reader) throw new Error('No response body')
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new Error(`Response exceeds ${maxBytes} bytes`)
        }
        chunks.push(value)
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    const raw = buf.toString('utf-8')

    const ctype = resp.headers.get('content-type') ?? ''
    const text = ctype.includes('text/plain') ? raw : htmlToText(raw)
    return { text, final_url: resp.url }
  } finally {
    clearTimeout(timer)
  }
}

function parseHttpUrl(s: string): URL | null {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

export function htmlToText(html: string): string {
  return html
    // Drop scripts and styles entirely — their bodies are noise.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    // Replace block-ish tags with newlines so paragraphs survive.
    .replace(
      /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|br)\s*>/gi,
      '\n',
    )
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip all remaining tags.
    .replace(/<[^>]+>/g, ' ')
    // Decode the entities that appear in real-world HTML.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // Collapse whitespace.
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
