"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Copy,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Eye,
  EyeOff,
  Loader2,
  ExternalLink,
  DownloadCloud,
  StopCircle,
} from "lucide-react"
import { createClient } from "@/lib/supabase/client"

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

interface WooConfig {
  id?: string
  store_url: string
  status: "active" | "inactive"
  webhook_secret: string | null
  credentials: {
    consumer_key?: string
    consumer_secret?: string
  }
}

const empty: WooConfig = {
  store_url: "",
  status: "inactive",
  webhook_secret: null,
  credentials: {},
}

export function WooCommercePanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [config, setConfig] = useState<WooConfig>(empty)
  const [testResult, setTestResult] = useState<
    | { ok: true; version: string | null; timezone: string | null }
    | { ok: false; error: string }
    | null
  >(null)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    Promise.all([
      supabase.auth.getUser(),
      fetch("/api/integrations/woocommerce/config").then((r) => r.json()),
    ]).then(([{ data }, configRes]) => {
      if (cancelled) return
      setUserId(data.user?.id ?? null)
      if (configRes.config) {
        setConfig({
          id: configRes.config.id,
          store_url: configRes.config.store_url ?? "",
          status: configRes.config.status ?? "inactive",
          webhook_secret: configRes.config.webhook_secret ?? null,
          credentials: configRes.config.credentials ?? {},
        })
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Build the public webhook URL the user has to paste in
  // WooCommerce → Settings → Advanced → Webhooks → Delivery URL.
  // Uses window.location so it stays correct across dev / preview /
  // production deploys without needing NEXT_PUBLIC_SITE_URL.
  const webhookUrl =
    typeof window !== "undefined" && userId
      ? `${window.location.origin}/api/integrations/woocommerce/webhook?user_id=${userId}`
      : ""

  async function save(payload: Partial<WooConfig> & { regenerate_secret?: boolean }) {
    setSaving(true)
    try {
      // Credentials come from the live form state, mirroring how
      // store_url falls back to config above. Without this the main
      // "Salvar" button — which calls save({}) — never sent the
      // consumer key/secret the user typed, so they were dropped on
      // every save (the toggle and regenerate-secret paths also call
      // save() with no credentials in the payload).
      const credentials = payload.credentials ?? config.credentials
      const body: Record<string, unknown> = {
        store_url: payload.store_url ?? config.store_url,
        status: payload.status ?? config.status,
      }
      if (credentials.consumer_key !== undefined) {
        body.consumer_key = credentials.consumer_key
      }
      if (credentials.consumer_secret !== undefined) {
        body.consumer_secret = credentials.consumer_secret
      }
      if (payload.regenerate_secret) {
        body.regenerate_secret = true
      }
      const res = await fetch("/api/integrations/woocommerce/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json.error ?? "Erro ao salvar")
        return
      }
      setConfig({
        id: json.config.id,
        store_url: json.config.store_url ?? "",
        status: json.config.status ?? "inactive",
        webhook_secret: json.config.webhook_secret ?? null,
        credentials: json.config.credentials ?? {},
      })
      toast.success("Configuração salva")
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch("/api/integrations/woocommerce/test", {
        method: "POST",
      })
      const json = await res.json()
      setTestResult(json)
      if (json.ok) {
        toast.success(`Conectado à WooCommerce ${json.version ?? ""}`)
      } else {
        toast.error(json.error ?? "Falha na conexão")
      }
    } finally {
      setTesting(false)
    }
  }

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${label} copiado`)
    } catch {
      toast.error("Falha ao copiar")
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Carregando...
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* ----- Conexão ----- */}
      <Card className="border-slate-800 bg-slate-900">
        <CardHeader>
          <CardTitle className="text-white">Integração WooCommerce</CardTitle>
          <CardDescription>
            Conecta sua loja WooCommerce ao WaCRM para sincronizar pedidos,
            disparar mensagens transacionais e calcular RFM dos clientes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-slate-800 bg-slate-950 p-3">
            <div>
              <p className="text-sm text-white">Ativar integração</p>
              <p className="text-xs text-slate-400">
                Quando desativada, o webhook ignora todos os eventos da loja.
              </p>
            </div>
            <Switch
              checked={config.status === "active"}
              onCheckedChange={(checked) =>
                save({ status: checked ? "active" : "inactive" })
              }
              disabled={saving}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="store-url" className="text-slate-300">
              URL da loja
            </Label>
            <Input
              id="store-url"
              value={config.store_url}
              onChange={(e) =>
                setConfig((c) => ({ ...c, store_url: e.target.value }))
              }
              placeholder="https://minhaloja.com.br"
              className="bg-slate-800 text-white"
            />
            <p className="text-xs text-slate-500">
              Sem barra no final. Ex: <code>https://loja.com</code>
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="consumer-key" className="text-slate-300">
              Consumer Key (REST API)
            </Label>
            <Input
              id="consumer-key"
              value={config.credentials.consumer_key ?? ""}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  credentials: { ...c.credentials, consumer_key: e.target.value },
                }))
              }
              placeholder="ck_xxxxxxxxxxxxxxxxxxxxxxxx"
              className="bg-slate-800 font-mono text-white"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="consumer-secret" className="text-slate-300">
              Consumer Secret (REST API)
            </Label>
            <div className="flex gap-2">
              <Input
                id="consumer-secret"
                type={showSecret ? "text" : "password"}
                value={config.credentials.consumer_secret ?? ""}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    credentials: {
                      ...c.credentials,
                      consumer_secret: e.target.value,
                    },
                  }))
                }
                placeholder="cs_xxxxxxxxxxxxxxxxxxxxxxxx"
                className="bg-slate-800 font-mono text-white"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setShowSecret((v) => !v)}
                className="border-slate-700 bg-slate-800"
                aria-label="Toggle visibility"
              >
                {showSecret ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Gerado em WordPress → WooCommerce → Configurações → Avançado →{" "}
              <a
                href="https://woocommerce.com/document/woocommerce-rest-api/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                REST API <ExternalLink className="h-3 w-3" />
              </a>
              . Permissão: <strong>Leitura/Gravação</strong>.
            </p>
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => save({})}
              disabled={saving}
              className="bg-primary text-white"
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Salvar
            </Button>
            <Button
              variant="outline"
              onClick={testConnection}
              disabled={testing || !config.store_url}
              className="border-slate-700 bg-slate-800"
            >
              {testing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Testar conexão
            </Button>
          </div>

          {testResult && (
            <div
              className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
                testResult.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-300"
              }`}
            >
              {testResult.ok ? (
                <>
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div>
                    <p>Conectado com sucesso</p>
                    {testResult.version && (
                      <p className="mt-1 text-xs opacity-80">
                        WC {testResult.version}
                        {testResult.timezone && ` · ${testResult.timezone}`}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <div>
                    <p>Falha na conexão</p>
                    <p className="mt-1 text-xs opacity-80">{testResult.error}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ----- Sincronização inicial ----- */}
      <SyncCard
        canSync={
          config.status === "active" &&
          !!config.credentials.consumer_key &&
          !!config.credentials.consumer_secret
        }
      />

      {/* ----- Webhook ----- */}
      <Card className="border-slate-800 bg-slate-900">
        <CardHeader>
          <CardTitle className="text-white">Webhook do WooCommerce</CardTitle>
          <CardDescription>
            Configure este webhook no WordPress para que cada mudança de status
            de pedido dispare automações no WaCRM.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label className="text-slate-300">URL de entrega</Label>
            <div className="flex gap-2">
              <Input
                value={webhookUrl}
                readOnly
                className="bg-slate-800 font-mono text-sm text-white"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(webhookUrl, "URL")}
                className="border-slate-700 bg-slate-800"
                aria-label="Copy URL"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Cola este valor no campo <strong>Delivery URL</strong> ao criar o
              webhook no WordPress.
            </p>
          </div>

          <div className="grid gap-2">
            <Label className="text-slate-300">Webhook Secret</Label>
            <div className="flex gap-2">
              <Input
                value={config.webhook_secret ?? ""}
                readOnly
                placeholder="Clique em Gerar para criar"
                className="bg-slate-800 font-mono text-sm text-white"
              />
              {config.webhook_secret && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() =>
                    copyToClipboard(config.webhook_secret ?? "", "Secret")
                  }
                  className="border-slate-700 bg-slate-800"
                  aria-label="Copy Secret"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => save({ regenerate_secret: true })}
                disabled={saving}
                className="border-slate-700 bg-slate-800"
                aria-label="Regenerate"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Cola este valor no campo <strong>Secret</strong> ao criar o
              webhook. Se rotacionar, atualize no WP também.
            </p>
          </div>

          <div className="rounded-md border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
            <p className="mb-2 font-medium text-slate-300">Passo a passo no WP</p>
            <ol className="list-inside list-decimal space-y-1">
              <li>WooCommerce → Configurações → Avançado → Webhooks → <strong>Adicionar webhook</strong></li>
              <li>Nome: <code>WaCRM</code> · Status: <code>Ativo</code></li>
              <li>Tópico: <code>Pedido atualizado</code> (cria 1 segundo com <code>Pedido criado</code> também se quiser disparar no recebimento)</li>
              <li>Delivery URL: cola a URL acima</li>
              <li>Secret: cola o secret acima</li>
              <li>API Version: <code>WP REST API Integration v3</code></li>
              <li>Salva</li>
            </ol>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------
// Sync card — one-shot manual REST API backfill.
// ---------------------------------------------------------------------

interface SyncStateView {
  status: "idle" | "running" | "error" | "completed"
  phase: "orders" | "customers"
  started_at: string | null
  completed_at: string | null
  orders: {
    current_page: number
    total_pages: number | null
    synced_count: number
  }
  customers: {
    current_page: number
    total_pages: number | null
    synced_count: number
  }
  error: string | null
}

function SyncCard({ canSync }: { canSync: boolean }) {
  const [state, setState] = useState<SyncStateView | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  // Initial fetch + resume detection. If the server reports `running`,
  // pick up where we left off (browser refresh during sync shouldn't
  // strand progress).
  useEffect(() => {
    let cancelled = false
    fetch("/api/integrations/woocommerce/sync")
      .then((r) => (r.ok ? r.json() : { state: null }))
      .then((json) => {
        if (cancelled) return
        setState(json.state ?? null)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function tick(): Promise<{ done: boolean; state: SyncStateView } | null> {
    const res = await fetch("/api/integrations/woocommerce/sync", { method: "POST" })
    const json = await res.json()
    if (!res.ok && res.status !== 500) {
      toast.error(json.error ?? "Falha na sincronização")
      return null
    }
    return json
  }

  async function startSync() {
    if (!canSync || running) return
    setRunning(true)
    try {
      // Hard cap on serial page fetches per click. At 50 rows/page this
      // covers ~250k orders + customers in one run — enough for years of
      // history. Each iteration is awaited (one in-flight request at a
      // time), so a high cap doesn't fan out load. If a huge store still
      // hits it, the sync is resumable: click again to continue.
      let safety = 5000
      while (safety-- > 0) {
        const result = await tick()
        if (!result) break
        setState(result.state)
        if (result.state.status === "error") {
          toast.error(`Erro: ${result.state.error}`)
          break
        }
        if (result.done) {
          toast.success(
            `Sincronização concluída — ${result.state.orders.synced_count} pedidos, ${result.state.customers.synced_count} clientes`,
          )
          break
        }
      }
    } finally {
      setRunning(false)
    }
  }

  async function cancelSync() {
    const res = await fetch("/api/integrations/woocommerce/sync", { method: "DELETE" })
    const json = await res.json()
    if (res.ok) {
      setState(json.state)
      toast.success("Sincronização cancelada")
    }
  }

  const totalSynced =
    (state?.orders.synced_count ?? 0) + (state?.customers.synced_count ?? 0)

  // Progress: each phase contributes 50%. Estimate inside-phase using
  // current_page / total_pages when known.
  let progressPct = 0
  if (state) {
    const ordersPct =
      state.orders.total_pages && state.orders.total_pages > 0
        ? Math.min(state.orders.current_page / state.orders.total_pages, 1) * 50
        : state.phase === "orders"
          ? 0
          : 50
    const customersPct =
      state.customers.total_pages && state.customers.total_pages > 0
        ? Math.min(state.customers.current_page / state.customers.total_pages, 1) * 50
        : state.status === "completed"
          ? 50
          : 0
    progressPct = Math.round(ordersPct + customersPct)
  }

  return (
    <Card className="border-slate-800 bg-slate-900">
      <CardHeader>
        <CardTitle className="text-white">Sincronização inicial</CardTitle>
        <CardDescription>
          Importa pedidos e clientes existentes pela REST API. Depois do
          primeiro sync, o webhook mantém tudo atualizado em tempo real.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Carregando...
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2">
                <SyncStatusBadge status={state?.status ?? "idle"} />
                {state?.completed_at && (
                  <span className="text-xs text-slate-500">
                    Última: {new Date(state.completed_at).toLocaleString("pt-BR")}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                {running || state?.status === "running" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={cancelSync}
                    className="border-slate-700 bg-slate-800"
                  >
                    <StopCircle className="mr-2 h-4 w-4" />
                    Cancelar
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={startSync}
                    disabled={!canSync}
                    className="bg-primary text-white"
                    title={
                      canSync
                        ? "Iniciar sincronização"
                        : "Conecte a loja com credenciais REST antes de sincronizar"
                    }
                  >
                    <DownloadCloud className="mr-2 h-4 w-4" />
                    Sincronizar agora
                  </Button>
                )}
              </div>
            </div>

            {(state?.status === "running" || running) && (
              <div className="space-y-1">
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-slate-500">
                  <span>
                    {state?.phase === "orders" ? "Pedidos" : "Clientes"} ·{" "}
                    {totalSynced} importados
                  </span>
                  <span>{progressPct}%</span>
                </div>
              </div>
            )}

            {state?.status === "completed" && (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
                {state.orders.synced_count} pedidos ·{" "}
                {state.customers.synced_count} clientes sincronizados
              </div>
            )}

            {state?.status === "error" && state.error && (
              <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                {state.error}
              </div>
            )}

            {!canSync && (
              <p className="text-xs text-slate-500">
                Ative a integração e preencha Consumer Key + Secret antes de
                sincronizar.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function SyncStatusBadge({ status }: { status: SyncStateView["status"] }) {
  const styles: Record<SyncStateView["status"], string> = {
    idle: "bg-slate-700 text-slate-300",
    running: "bg-blue-500/20 text-blue-300",
    completed: "bg-emerald-500/20 text-emerald-300",
    error: "bg-rose-500/20 text-rose-300",
  }
  const labels: Record<SyncStateView["status"], string> = {
    idle: "Pronto",
    running: "Sincronizando",
    completed: "Concluído",
    error: "Erro",
  }
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}
