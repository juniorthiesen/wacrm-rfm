"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Users, Download, Send, Loader2, X } from "lucide-react"
import { createClient } from "@/lib/supabase/client"
import { Button } from "@/components/ui/button"

// ------------------------------------------------------------
// Públicos — audience builder. Composes e-commerce filters, shows a
// live count + preview, lets you take a % / fixed sample, and either
// export a CSV or launch a drip broadcast. All powered by the
// audience_rows / count_audience / list_audience / create_audience_campaign
// RPCs (migration 040), called directly (SECURITY DEFINER + auth.uid
// guard).
// ------------------------------------------------------------

const SEGMENTS = [
  { key: "champion", label: "Campeões" },
  { key: "loyal", label: "Fiéis" },
  { key: "new_customer", label: "Novos Clientes" },
  { key: "about_to_sleep", label: "Quase Adormecidos" },
  { key: "in_risk", label: "Em Risco" },
  { key: "hibernating", label: "Hibernando" },
  { key: "lost", label: "Perdidos" },
] as const

const MONTHS = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
]

const SEGMENT_LABEL: Record<string, string> = Object.fromEntries(
  SEGMENTS.map((s) => [s.key, s.label]),
)

interface Filters {
  segments: string[]
  minRecency: string
  maxRecency: string
  minMonetary: string
  maxMonetary: string
  minFrequency: string
  maxFrequency: string
  minAvgTicket: string
  maxAvgTicket: string
  productLike: string
  productNotLike: string
  firstOrderAfter: string
  firstOrderBefore: string
  birthdayMonth: string
  includeTagIds: string[]
  excludeTagIds: string[]
}

const EMPTY_FILTERS: Filters = {
  segments: [], minRecency: "", maxRecency: "", minMonetary: "", maxMonetary: "",
  minFrequency: "", maxFrequency: "", minAvgTicket: "", maxAvgTicket: "",
  productLike: "", productNotLike: "", firstOrderAfter: "", firstOrderBefore: "",
  birthdayMonth: "", includeTagIds: [], excludeTagIds: [],
}

interface AudienceRow {
  contact_id: string
  name: string | null
  phone: string | null
  email: string | null
  monetary_value: number | null
  frequency_count: number | null
  recency_days: number | null
  avg_ticket: number | null
  first_order_at: string | null
  segment: string | null
  total_count: number
}

interface TagRow { id: string; name: string }
interface TemplateRow { name: string; language: string | null; body_text: string | null; status: string | null }

const num = (s: string): number | null => {
  const t = s.trim()
  if (t === "") return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function buildArgs(userId: string, f: Filters) {
  return {
    p_user_id: userId,
    p_segments: f.segments.length ? f.segments : null,
    p_min_recency_days: num(f.minRecency),
    p_max_recency_days: num(f.maxRecency),
    p_min_monetary: num(f.minMonetary),
    p_max_monetary: num(f.maxMonetary),
    p_min_frequency: num(f.minFrequency),
    p_max_frequency: num(f.maxFrequency),
    p_min_avg_ticket: num(f.minAvgTicket),
    p_max_avg_ticket: num(f.maxAvgTicket),
    p_product_like: f.productLike.trim() || null,
    p_product_not_like: f.productNotLike.trim() || null,
    p_first_order_after: f.firstOrderAfter || null,
    p_first_order_before: f.firstOrderBefore || null,
    p_birthday_month: f.birthdayMonth ? Number(f.birthdayMonth) : null,
    p_include_tag_ids: f.includeTagIds.length ? f.includeTagIds : null,
    p_exclude_tag_ids: f.excludeTagIds.length ? f.excludeTagIds : null,
  }
}

const brl = (v: number | null) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v ?? 0)

const fieldClass =
  "w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-primary focus:outline-none"

export default function AudiencesPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const [userId, setUserId] = useState<string | null>(null)

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [order, setOrder] = useState<"spend" | "ticket" | "recent" | "name">("spend")
  const [count, setCount] = useState<number | null>(null)
  const [rows, setRows] = useState<AudienceRow[]>([])
  const [loading, setLoading] = useState(false)

  const [tags, setTags] = useState<TagRow[]>([])
  const [exporting, setExporting] = useState(false)
  const [showBroadcast, setShowBroadcast] = useState(false)

  // Sampling
  const [sampleMode, setSampleMode] = useState<"all" | "percent" | "limit">("all")
  const [samplePercent, setSamplePercent] = useState("10")
  const [sampleLimit, setSampleLimit] = useState("300")
  const [rank, setRank] = useState<"spend" | "ticket" | "recent" | "random">("spend")

  const set = useCallback(<K extends keyof Filters>(k: K, v: Filters[K]) => {
    setFilters((prev) => ({ ...prev, [k]: v }))
  }, [])

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.getSession()
      setUserId(data.session?.user?.id ?? null)
      const { data: tagRows } = await supabase.from("tags").select("id, name").order("name")
      setTags((tagRows as TagRow[]) ?? [])
    })()
  }, [supabase])

  // Live count + preview, debounced.
  const reqId = useRef(0)
  useEffect(() => {
    if (!userId) return
    const myId = ++reqId.current
    setLoading(true)
    const handle = setTimeout(async () => {
      const args = buildArgs(userId, filters)
      const { data, error } = await supabase.rpc("list_audience", {
        ...args, p_order: order, p_limit: 50, p_offset: 0,
      })
      if (myId !== reqId.current) return // a newer request superseded this
      if (error) {
        console.error("[audiences] list failed:", error)
        toast.error("Falha ao calcular o público")
        setLoading(false)
        return
      }
      const list = (data as AudienceRow[]) ?? []
      setRows(list)
      setCount(list.length > 0 ? Number(list[0].total_count) : 0)
      setLoading(false)
    }, 450)
    return () => clearTimeout(handle)
  }, [supabase, userId, filters, order])

  const sampleTarget = useMemo(() => {
    if (count == null) return null
    if (sampleMode === "percent") {
      const p = Number(samplePercent) || 0
      return Math.max(count > 0 ? 1 : 0, Math.ceil((count * p) / 100))
    }
    if (sampleMode === "limit") return Math.min(count, Number(sampleLimit) || 0)
    return count
  }, [count, sampleMode, samplePercent, sampleLimit])

  async function handleExportCsv() {
    if (!userId || !count) return
    setExporting(true)
    try {
      const args = buildArgs(userId, filters)
      const pageSize = 1000
      const all: AudienceRow[] = []
      for (let offset = 0; offset < count && offset < 50000; offset += pageSize) {
        const { data, error } = await supabase.rpc("list_audience", {
          ...args, p_order: order, p_limit: pageSize, p_offset: offset,
        })
        if (error) throw error
        const page = (data as AudienceRow[]) ?? []
        all.push(...page)
        if (page.length < pageSize) break
      }
      const header = ["nome", "telefone", "email", "gasto_total", "num_pedidos", "ticket_medio", "dias_ultima_compra", "primeira_compra", "segmento"]
      const lines = all.map((r) => [
        r.name ?? "", r.phone ?? "", r.email ?? "",
        String(r.monetary_value ?? 0), String(r.frequency_count ?? 0), String(r.avg_ticket ?? 0),
        String(r.recency_days ?? ""), r.first_order_at ? r.first_order_at.slice(0, 10) : "",
        SEGMENT_LABEL[r.segment ?? ""] ?? r.segment ?? "",
      ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      const csv = "﻿" + [header.join(","), ...lines].join("\r\n")
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `publico-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`${all.length} contatos exportados`)
    } catch (err) {
      console.error("[audiences] export failed:", err)
      toast.error("Falha ao exportar CSV")
    } finally {
      setExporting(false)
    }
  }

  const sampling = { sampleMode, samplePercent, sampleLimit, rank }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Públicos</h1>
          <p className="mt-1 text-sm text-slate-400">
            Monte públicos por comportamento de compra, exporte um CSV ou dispare uma transmissão.
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 px-4 py-2">
          <Users className="h-5 w-5 text-primary" />
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500">Público</p>
            <p className="text-xl font-bold tabular-nums text-white">
              {loading ? <Loader2 className="h-5 w-5 animate-spin text-slate-500" /> : (count ?? 0).toLocaleString("pt-BR")}
              {!loading && <span className="ml-1 text-sm font-normal text-slate-500">contatos</span>}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Filters */}
        <section className="space-y-4 lg:col-span-1">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Filtros</h2>
              <button onClick={() => setFilters(EMPTY_FILTERS)} className="text-xs text-slate-500 hover:text-slate-300">
                Limpar
              </button>
            </div>

            {/* Segments */}
            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">Segmentos RFM</p>
            <div className="flex flex-wrap gap-1.5">
              {SEGMENTS.map((s) => {
                const on = filters.segments.includes(s.key)
                return (
                  <button
                    key={s.key}
                    onClick={() =>
                      set("segments", on ? filters.segments.filter((x) => x !== s.key) : [...filters.segments, s.key])
                    }
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      on ? "border-primary bg-primary/15 text-primary" : "border-slate-700 text-slate-400 hover:border-slate-600"
                    }`}
                  >
                    {s.label}
                  </button>
                )
              })}
            </div>

            <RangeRow label="Gasto total (R$)" min={filters.minMonetary} max={filters.maxMonetary}
              onMin={(v) => set("minMonetary", v)} onMax={(v) => set("maxMonetary", v)} />
            <RangeRow label="Nº de pedidos" min={filters.minFrequency} max={filters.maxFrequency}
              onMin={(v) => set("minFrequency", v)} onMax={(v) => set("maxFrequency", v)} />
            <RangeRow label="Ticket médio (R$)" min={filters.minAvgTicket} max={filters.maxAvgTicket}
              onMin={(v) => set("minAvgTicket", v)} onMax={(v) => set("maxAvgTicket", v)} />
            <RangeRow label="Dias desde a última compra" min={filters.minRecency} max={filters.maxRecency}
              onMin={(v) => set("minRecency", v)} onMax={(v) => set("maxRecency", v)} />

            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">Comprou (produto/categoria)</p>
            <input className={fieldClass} placeholder="ex.: Sutiã, Calcinha…"
              value={filters.productLike} onChange={(e) => set("productLike", e.target.value)} />
            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">NÃO comprou (cross-sell)</p>
            <input className={fieldClass} placeholder="ex.: Calcinha"
              value={filters.productNotLike} onChange={(e) => set("productNotLike", e.target.value)} />
            <p className="mt-1.5 text-[11px] text-slate-600">Acentos são ignorados (&quot;sutia&quot; acha &quot;Sutiã&quot;).</p>

            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">1ª compra entre</p>
            <div className="flex items-center gap-2">
              <input type="date" className={fieldClass} value={filters.firstOrderAfter} onChange={(e) => set("firstOrderAfter", e.target.value)} />
              <span className="text-slate-600">–</span>
              <input type="date" className={fieldClass} value={filters.firstOrderBefore} onChange={(e) => set("firstOrderBefore", e.target.value)} />
            </div>

            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">Aniversariantes do mês</p>
            <select className={fieldClass} value={filters.birthdayMonth} onChange={(e) => set("birthdayMonth", e.target.value)}>
              <option value="">Qualquer</option>
              {MONTHS.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
            </select>

            <TagPicker label="Com as tags" tags={tags} selected={filters.includeTagIds} onChange={(v) => set("includeTagIds", v)} />
            <TagPicker label="Sem as tags" tags={tags} selected={filters.excludeTagIds} onChange={(v) => set("excludeTagIds", v)} />
          </div>

          {/* Sampling */}
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="text-sm font-semibold text-white">Amostragem</h2>
            <div className="mt-3 flex gap-1.5">
              {([["all", "Todos"], ["percent", "% do público"], ["limit", "Nº fixo"]] as const).map(([m, lbl]) => (
                <button key={m} onClick={() => setSampleMode(m)}
                  className={`flex-1 rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                    sampleMode === m ? "border-primary bg-primary/15 text-primary" : "border-slate-700 text-slate-400"
                  }`}>{lbl}</button>
              ))}
            </div>
            {sampleMode === "percent" && (
              <div className="mt-3 flex items-center gap-2">
                <input type="number" min={1} max={100} className={fieldClass} value={samplePercent}
                  onChange={(e) => setSamplePercent(e.target.value)} />
                <span className="text-sm text-slate-500">%</span>
              </div>
            )}
            {sampleMode === "limit" && (
              <input type="number" min={1} className={`${fieldClass} mt-3`} value={sampleLimit}
                onChange={(e) => setSampleLimit(e.target.value)} />
            )}
            {sampleMode !== "all" && (
              <>
                <p className="mt-3 mb-1.5 text-xs font-medium text-slate-400">Selecionar por</p>
                <select className={fieldClass} value={rank} onChange={(e) => setRank(e.target.value as typeof rank)}>
                  <option value="spend">Maior gasto</option>
                  <option value="ticket">Maior ticket</option>
                  <option value="recent">Mais recentes</option>
                  <option value="random">Aleatório</option>
                </select>
              </>
            )}
            <p className="mt-3 text-sm text-slate-300">
              Vai usar <span className="font-bold text-white">{(sampleTarget ?? 0).toLocaleString("pt-BR")}</span> contatos
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 border-slate-700 bg-slate-800"
              disabled={!count || exporting} onClick={handleExportCsv}>
              {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Exportar CSV
            </Button>
            <Button className="flex-1" disabled={!sampleTarget} onClick={() => setShowBroadcast(true)}>
              <Send className="mr-2 h-4 w-4" />
              Criar transmissão
            </Button>
          </div>
        </section>

        {/* Preview */}
        <section className="lg:col-span-2">
          <div className="rounded-xl border border-slate-800 bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-white">Prévia {count != null && <span className="text-slate-500">(primeiros {rows.length} de {count.toLocaleString("pt-BR")})</span>}</h2>
              <select className="rounded-lg border border-slate-700 bg-slate-950/50 px-2 py-1 text-xs text-white"
                value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
                <option value="spend">Maior gasto</option>
                <option value="ticket">Maior ticket</option>
                <option value="recent">Mais recentes</option>
                <option value="name">Nome (A–Z)</option>
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-2 font-medium">Cliente</th>
                    <th className="px-4 py-2 font-medium">Telefone</th>
                    <th className="px-4 py-2 text-right font-medium">Gasto</th>
                    <th className="px-4 py-2 text-right font-medium">Pedidos</th>
                    <th className="px-4 py-2 text-right font-medium">Últ. compra</th>
                    <th className="px-4 py-2 font-medium">Segmento</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.contact_id} className="border-t border-slate-800/60">
                      <td className="max-w-[180px] truncate px-4 py-2 text-slate-200">{r.name ?? "—"}</td>
                      <td className="px-4 py-2 text-slate-400">{r.phone ?? "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-200">{brl(r.monetary_value)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-400">{r.frequency_count ?? 0}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-400">{r.recency_days != null ? `${r.recency_days}d` : "—"}</td>
                      <td className="px-4 py-2 text-slate-400">{SEGMENT_LABEL[r.segment ?? ""] ?? r.segment ?? "—"}</td>
                    </tr>
                  ))}
                  {!loading && rows.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500">Nenhum contato com esse filtro.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {showBroadcast && userId && (
        <BroadcastModal
          supabase={supabase}
          userId={userId}
          filters={filters}
          sampling={sampling}
          targetCount={sampleTarget ?? 0}
          onClose={() => setShowBroadcast(false)}
          onCreated={(id) => router.push(`/broadcasts/${id}`)}
        />
      )}
    </div>
  )
}

function RangeRow({ label, min, max, onMin, onMax }: {
  label: string; min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void
}) {
  return (
    <>
      <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">{label}</p>
      <div className="flex items-center gap-2">
        <input type="number" className={fieldClass} placeholder="mín" value={min} onChange={(e) => onMin(e.target.value)} />
        <span className="text-slate-600">–</span>
        <input type="number" className={fieldClass} placeholder="máx" value={max} onChange={(e) => onMax(e.target.value)} />
      </div>
    </>
  )
}

function TagPicker({ label, tags, selected, onChange }: {
  label: string; tags: TagRow[]; selected: string[]; onChange: (v: string[]) => void
}) {
  if (tags.length === 0) return null
  return (
    <>
      <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => {
          const on = selected.includes(t.id)
          return (
            <button key={t.id}
              onClick={() => onChange(on ? selected.filter((x) => x !== t.id) : [...selected, t.id])}
              className={`max-w-full truncate rounded-full border px-2.5 py-1 text-xs transition-colors ${
                on ? "border-primary bg-primary/15 text-primary" : "border-slate-700 text-slate-400 hover:border-slate-600"
              }`}>{t.name}</button>
          )
        })}
      </div>
    </>
  )
}

// ------------------------------------------------------------
// Broadcast modal — pick an approved template, map its {{n}} variables,
// then snapshot the (sampled) audience into a drip campaign.
// ------------------------------------------------------------

interface Sampling {
  sampleMode: "all" | "percent" | "limit"
  samplePercent: string
  sampleLimit: string
  rank: "spend" | "ticket" | "recent" | "random"
}

function BroadcastModal({ supabase, userId, filters, sampling, targetCount, onClose, onCreated }: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  userId: string
  filters: Filters
  sampling: Sampling
  targetCount: number
  onClose: () => void
  onCreated: (broadcastId: string) => void
}) {
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [templateName, setTemplateName] = useState("")
  const [name, setName] = useState("")
  const [vars, setVars] = useState<Record<string, { kind: "static" | "first_name" | "full_name"; value: string }>>({})
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("message_templates")
        .select("name, language, body_text, status")
        .order("name")
      const list = ((data as TemplateRow[]) ?? []).filter(
        (t) => (t.status ?? "").toLowerCase() === "approved",
      )
      setTemplates(list)
    })()
  }, [supabase])

  const selected = templates.find((t) => t.name === templateName)
  const varIndexes = useMemo(() => {
    const body = selected?.body_text ?? ""
    const found = new Set<number>()
    for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(m[1]))
    return Array.from(found).sort((a, b) => a - b)
  }, [selected])

  function varDef(i: number) {
    return vars[String(i)] ?? { kind: "first_name" as const, value: "" }
  }

  async function handleCreate() {
    if (!templateName || !name.trim()) {
      toast.error("Dê um nome e escolha um template")
      return
    }
    const templateVariables: Record<string, string> = {}
    for (const i of varIndexes) {
      const d = varDef(i)
      templateVariables[String(i)] =
        d.kind === "first_name" ? "{{customer.first_name}}"
        : d.kind === "full_name" ? "{{customer.name}}"
        : d.value
    }
    setCreating(true)
    try {
      const { data, error } = await supabase.rpc("create_audience_campaign", {
        ...buildArgs(userId, filters),
        p_name: name.trim(),
        p_template_name: templateName,
        p_template_language: selected?.language ?? "pt_BR",
        p_template_variables: templateVariables,
        p_sample_percent: sampling.sampleMode === "percent" ? Number(sampling.samplePercent) : null,
        p_sample_limit: sampling.sampleMode === "limit" ? Number(sampling.sampleLimit) : null,
        p_rank: sampling.rank,
      })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      toast.success(`Transmissão criada — ${result?.total_recipients ?? 0} destinatários`)
      onCreated(result?.broadcast_id)
    } catch (err) {
      console.error("[audiences] create campaign failed:", err)
      toast.error("Falha ao criar a transmissão")
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-slate-800 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Criar transmissão</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Vai disparar para <span className="font-semibold text-white">{targetCount.toLocaleString("pt-BR")}</span> contatos.
        </p>

        <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">Nome da transmissão</p>
        <input className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Reativação Hibernando — Junho" />

        <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">Template aprovado</p>
        <select className={fieldClass} value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
          <option value="">Selecione…</option>
          {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
        </select>
        {templates.length === 0 && (
          <p className="mt-1.5 text-[11px] text-amber-400">Nenhum template aprovado encontrado.</p>
        )}

        {varIndexes.length > 0 && (
          <>
            <p className="mt-4 mb-1.5 text-xs font-medium text-slate-400">Variáveis</p>
            <div className="space-y-2">
              {varIndexes.map((i) => {
                const d = varDef(i)
                return (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-8 text-xs text-slate-500">{`{{${i}}}`}</span>
                    <select className={fieldClass} value={d.kind}
                      onChange={(e) => setVars((p) => ({ ...p, [String(i)]: { kind: e.target.value as "static" | "first_name" | "full_name", value: d.value } }))}>
                      <option value="first_name">Nome do cliente</option>
                      <option value="full_name">Nome completo</option>
                      <option value="static">Texto fixo</option>
                    </select>
                    {d.kind === "static" && (
                      <input className={fieldClass} value={d.value} placeholder="texto"
                        onChange={(e) => setVars((p) => ({ ...p, [String(i)]: { kind: "static", value: e.target.value } }))} />
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" className="border-slate-700 bg-slate-800" onClick={onClose}>Cancelar</Button>
          <Button disabled={creating || !templateName || !name.trim()} onClick={handleCreate}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            Criar e enviar
          </Button>
        </div>
      </div>
    </div>
  )
}
