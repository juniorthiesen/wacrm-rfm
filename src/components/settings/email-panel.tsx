"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { CheckCircle2, Copy, Loader2, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * Settings → E-mail. Configures the Resend channel (src/lib/email).
 * The API key / webhook secret are write-only: they are sent on save and the
 * server only ever reports "already set".
 */

interface Form {
  api_key: string
  webhook_secret: string
  from_name: string
  from_email: string
  reply_to: string
  daily_limit: string
  marketing_min_gap_days: string
  logo_url: string
  company_name: string
  accent: string
  ink: string
  strip_text: string
  footer_note: string
  is_active: boolean
}

const EMPTY: Form = {
  api_key: "",
  webhook_secret: "",
  from_name: "",
  from_email: "",
  reply_to: "",
  daily_limit: "150",
  marketing_min_gap_days: "3",
  logo_url: "",
  company_name: "",
  accent: "",
  ink: "",
  strip_text: "",
  footer_note: "",
  is_active: false,
}

export function EmailPanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [form, setForm] = useState<Form>(EMPTY)
  const [hasApiKey, setHasApiKey] = useState(false)
  const [hasWebhookSecret, setHasWebhookSecret] = useState(false)
  const [siteUrlConfigured, setSiteUrlConfigured] = useState(true)

  const webhookUrl =
    typeof window === "undefined" ? "" : `${window.location.origin}/api/webhooks/resend`

  function patch(update: Partial<Form>) {
    setForm((f) => ({ ...f, ...update }))
  }

  function applyServerConfig(config: Record<string, unknown> | null) {
    if (!config) return
    const brand = (config.brand ?? {}) as Record<string, string | undefined>
    setHasApiKey(!!config.has_api_key)
    setHasWebhookSecret(!!config.has_webhook_secret)
    setForm({
      api_key: "",
      webhook_secret: "",
      from_name: String(config.from_name ?? ""),
      from_email: String(config.from_email ?? ""),
      reply_to: String(config.reply_to ?? ""),
      daily_limit: String(config.daily_limit ?? 150),
      marketing_min_gap_days: String(config.marketing_min_gap_days ?? 3),
      logo_url: brand.logo_url ?? "",
      company_name: brand.company_name ?? "",
      accent: brand.accent ?? "",
      ink: brand.ink ?? "",
      strip_text: brand.strip_text ?? "",
      footer_note: brand.footer_note ?? "",
      is_active: config.is_active === true,
    })
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/email/config")
        const json = await res.json()
        if (cancelled) return
        if (res.ok) {
          setSiteUrlConfigured(json.site_url_configured !== false)
          applyServerConfig(json.config)
        } else {
          toast.error(json.error ?? "Erro ao carregar")
        }
      } catch {
        if (!cancelled) toast.error("Erro ao carregar")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function save(next: Partial<Form> = {}) {
    const f = { ...form, ...next }
    setSaving(true)
    try {
      const res = await fetch("/api/email/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: f.api_key,
          webhook_secret: f.webhook_secret,
          from_name: f.from_name,
          from_email: f.from_email,
          reply_to: f.reply_to,
          daily_limit: f.daily_limit,
          marketing_min_gap_days: f.marketing_min_gap_days,
          is_active: f.is_active,
          brand: {
            logo_url: f.logo_url,
            company_name: f.company_name,
            accent: f.accent,
            ink: f.ink,
            strip_text: f.strip_text,
            footer_note: f.footer_note,
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? "Erro ao salvar")
        return
      }
      applyServerConfig(json.config)
      toast.success("Configuração salva")
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    setTesting(true)
    try {
      const res = await fetch("/api/email/test", { method: "POST" })
      const json = await res.json()
      if (res.ok) toast.success(`E-mail de teste enviado para ${json.to}`)
      else toast.error(json.error ?? "Falha no envio do teste")
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Loader2 className="size-4 animate-spin" /> Carregando…
      </div>
    )
  }

  const field = (label: string, key: keyof Form, props: { placeholder?: string; type?: string } = {}) => (
    <div className="space-y-1.5">
      <Label className="text-slate-300">{label}</Label>
      <Input
        value={form[key] as string}
        onChange={(e) => patch({ [key]: e.target.value } as Partial<Form>)}
        className="bg-slate-800 text-white"
        {...props}
      />
    </div>
  )

  return (
    <div className="space-y-6">
      {!siteUrlConfigured && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
          A variável <code>NEXT_PUBLIC_SITE_URL</code> não está definida no servidor: e-mails de
          marketing não serão enviados porque não há como montar o link de descadastro.
        </div>
      )}

      <Card className="border-slate-700 bg-slate-900">
        <CardHeader>
          <CardTitle className="text-white">Canal de e-mail (Resend)</CardTitle>
          <CardDescription>
            Antes de ativar, verifique o domínio de envio no Resend (SPF e DKIM). Sem isso os
            e-mails caem no spam.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-slate-700 p-3">
            <div>
              <p className="text-sm font-medium text-white">Canal ativo</p>
              <p className="text-xs text-slate-400">Desligado, nenhuma automação envia e-mail.</p>
            </div>
            <Switch
              checked={form.is_active}
              onCheckedChange={(checked) => save({ is_active: checked })}
              disabled={saving}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-slate-300">
                Chave da API do Resend {hasApiKey && <CheckCircle2 className="ml-1 inline size-3.5 text-emerald-400" />}
              </Label>
              <Input
                type="password"
                autoComplete="off"
                placeholder={hasApiKey ? "•••••• (já salva; preencha só para trocar)" : "re_..."}
                value={form.api_key}
                onChange={(e) => patch({ api_key: e.target.value })}
                className="bg-slate-800 text-white"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-slate-300">
                Segredo do webhook {hasWebhookSecret && <CheckCircle2 className="ml-1 inline size-3.5 text-emerald-400" />}
              </Label>
              <Input
                type="password"
                autoComplete="off"
                placeholder={hasWebhookSecret ? "•••••• (já salvo)" : "whsec_..."}
                value={form.webhook_secret}
                onChange={(e) => patch({ webhook_secret: e.target.value })}
                className="bg-slate-800 text-white"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-slate-300">URL do webhook (cadastre no Resend)</Label>
            <div className="flex gap-2">
              <Input readOnly value={webhookUrl} className="bg-slate-800 font-mono text-xs text-white" />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(webhookUrl)
                  toast.success("URL copiada")
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-slate-400">
              Eventos: delivered, bounced, complained, opened, clicked. É assim que o CRM aprende que
              um endereço não existe ou marcou spam e para de enviar.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {field("Nome do remetente", "from_name", { placeholder: "DLY Lingerie" })}
            {field("E-mail do remetente", "from_email", { placeholder: "ecom@dly.com.br" })}
            {field("Responder para (opcional)", "reply_to", { placeholder: "contato@dly.com.br" })}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {field("Limite diário de marketing", "daily_limit", { type: "number" })}
            {field("Dias entre e-mails de marketing ao mesmo cliente", "marketing_min_gap_days", { type: "number" })}
          </div>
          <p className="text-xs text-slate-400">
            O limite diário protege a reputação do domínio enquanto ele &quot;esquenta&quot; (comece baixo).
            O intervalo vale somando todas as automações. E-mails transacionais não são limitados.
          </p>
        </CardContent>
      </Card>

      <Card className="border-slate-700 bg-slate-900">
        <CardHeader>
          <CardTitle className="text-white">Identidade visual dos e-mails</CardTitle>
          <CardDescription>Logo, cores e textos fixos usados em todos os e-mails.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {field("Link da logo (PNG/JPG, https)", "logo_url", { placeholder: "https://…/logo.png" })}
            {field("Nome da empresa", "company_name", { placeholder: "DLY Lingerie" })}
            {field("Cor de destaque (botão, cupom)", "accent", { placeholder: "#087f58" })}
            {field("Cor do texto e rodapé", "ink", { placeholder: "#111111" })}
            {field("Faixa no topo (opcional)", "strip_text", { placeholder: "Kits com desconto automático" })}
            {field("Texto do rodapé (endereço, CNPJ)", "footer_note")}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Button onClick={() => save()} disabled={saving}>
          {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
          Salvar
        </Button>
        <Button variant="outline" onClick={sendTest} disabled={testing || saving}>
          {testing ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
          Enviar e-mail de teste para mim
        </Button>
      </div>
    </div>
  )
}
