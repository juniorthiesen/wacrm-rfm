import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * Contacts of one RFM segment, for the RFM page's segment drill-down.
 *
 *   GET ?segment=in_risk&page=0&search=ana   → JSON page (50/row)
 *   GET ?segment=in_risk&export=1            → CSV of the whole segment
 *
 * Backed by rfm_segment_contacts() (migration 033), which returns each
 * row's window total_count so the UI gets count + page in one trip.
 */
const PAGE_SIZE = 50
const EXPORT_CAP = 20000

interface Row {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  monetary_value: number | string | null
  recency_days: number | null
  frequency_count: number | null
  total_count: number | string | null
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const segment = searchParams.get('segment')
  if (!segment) {
    return NextResponse.json({ error: 'segment is required' }, { status: 400 })
  }
  const search = searchParams.get('search')?.trim() || null
  const isExport = searchParams.get('export') === '1'

  if (isExport) {
    const { data, error } = await supabase.rpc('rfm_segment_contacts', {
      p_user_id: user.id,
      p_segment: segment,
      p_search: search,
      p_limit: EXPORT_CAP,
      p_offset: 0,
    })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const rows = (data ?? []) as Row[]
    const header = 'nome,email,telefone,valor_total,recencia_dias,pedidos'
    const lines = rows.map((r) =>
      [
        csvCell(r.name),
        csvCell(r.email),
        csvCell(r.phone),
        csvCell(r.monetary_value),
        csvCell(r.recency_days),
        csvCell(r.frequency_count),
      ].join(','),
    )
    const csv = [header, ...lines].join('\n')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rfm_${segment}.csv"`,
      },
    })
  }

  const page = Math.max(0, Number(searchParams.get('page') ?? '0') || 0)
  const { data, error } = await supabase.rpc('rfm_segment_contacts', {
    p_user_id: user.id,
    p_segment: segment,
    p_search: search,
    p_limit: PAGE_SIZE,
    p_offset: page * PAGE_SIZE,
  })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as Row[]
  const total = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0
  return NextResponse.json({
    contacts: rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      monetary_value: Number(r.monetary_value ?? 0),
      recency_days: r.recency_days,
      frequency_count: r.frequency_count,
    })),
    total,
    page,
    page_size: PAGE_SIZE,
  })
}
