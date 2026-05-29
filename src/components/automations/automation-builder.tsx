"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  AutomationStepType,
  AutomationTriggerType,
  KeywordMatchTriggerConfig,
} from "@/types"
import { cn } from "@/lib/utils"
import { useTranslation } from "@/hooks/use-translation"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
}

// ------------------------------------------------------------
// Step metadata — dynamic source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  label: string
  icon: typeof Zap
  /** Left-border accent color per spec. */
  border: string
}

function getStepMeta(type: AutomationStepType, t: (key: string) => string): StepMeta {
  const meta: Record<AutomationStepType, StepMeta> = {
    send_message: { label: t("automations.stepMessage"), icon: MessageSquare, border: "border-l-primary" },
    send_template: { label: t("automations.stepMeta.send_template"), icon: FileText, border: "border-l-primary" },
    add_tag: { label: t("automations.stepMeta.add_tag"), icon: Tag, border: "border-l-primary" },
    remove_tag: { label: t("automations.stepMeta.remove_tag"), icon: TagIcon, border: "border-l-primary" },
    assign_conversation: { label: t("automations.stepMeta.assign_conversation"), icon: UserCheck, border: "border-l-primary" },
    update_contact_field: { label: t("automations.stepMeta.update_contact_field"), icon: PencilLine, border: "border-l-primary" },
    create_deal: { label: t("automations.stepMeta.create_deal"), icon: Briefcase, border: "border-l-primary" },
    wait: { label: t("automations.stepMeta.wait"), icon: Hourglass, border: "border-l-slate-500" },
    condition: { label: t("automations.stepMeta.condition"), icon: GitBranch, border: "border-l-amber-500" },
    send_webhook: { label: t("automations.stepMeta.send_webhook"), icon: Webhook, border: "border-l-primary" },
    close_conversation: { label: t("automations.stepMeta.close_conversation"), icon: CircleSlash, border: "border-l-primary" },
  }
  return meta[type]
}

const ADDABLE_STEPS: AutomationStepType[] = [
  "send_message",
  "send_template",
  "add_tag",
  "remove_tag",
  "assign_conversation",
  "update_contact_field",
  "create_deal",
  "wait",
  "condition",
  "send_webhook",
  "close_conversation",
]

function getTriggerOptions(t: (key: string) => string) {
  return [
    { value: "new_message_received" as AutomationTriggerType, label: t("automations.triggerOptions.new_message_received"), hint: t("automations.triggerHints.new_message_received") },
    {
      value: "first_inbound_message" as AutomationTriggerType,
      label: t("automations.triggerOptions.first_inbound_message"),
      hint: t("automations.triggerHints.first_inbound_message"),
    },
    { value: "keyword_match" as AutomationTriggerType, label: t("automations.triggerOptions.keyword_match"), hint: t("automations.triggerHints.keyword_match") },
    { value: "new_contact_created" as AutomationTriggerType, label: t("automations.triggerOptions.new_contact_created"), hint: t("automations.triggerHints.new_contact_created") },
    { value: "conversation_assigned" as AutomationTriggerType, label: t("automations.triggerOptions.conversation_assigned"), hint: t("automations.triggerHints.conversation_assigned") },
    { value: "tag_added" as AutomationTriggerType, label: t("automations.triggerOptions.tag_added"), hint: t("automations.triggerHints.tag_added") },
    { value: "time_based" as AutomationTriggerType, label: t("automations.triggerOptions.time_based"), hint: t("automations.triggerHints.time_based") },
    // E-commerce order lifecycle triggers — fired by the WooCommerce
    // webhook on a real status transition. See docs/woocommerce-
    // integration.md and src/app/api/integrations/woocommerce/webhook.
    { value: "order_received" as AutomationTriggerType, label: t("automations.triggerOptions.order_received"), hint: t("automations.triggerHints.order_received") },
    { value: "order_paid" as AutomationTriggerType, label: t("automations.triggerOptions.order_paid"), hint: t("automations.triggerHints.order_paid") },
    { value: "order_shipped" as AutomationTriggerType, label: t("automations.triggerOptions.order_shipped"), hint: t("automations.triggerHints.order_shipped") },
    { value: "order_cancelled" as AutomationTriggerType, label: t("automations.triggerOptions.order_cancelled"), hint: t("automations.triggerHints.order_cancelled") },
    { value: "order_refunded" as AutomationTriggerType, label: t("automations.triggerOptions.order_refunded"), hint: t("automations.triggerHints.order_refunded") },
    { value: "order_failed" as AutomationTriggerType, label: t("automations.triggerOptions.order_failed"), hint: t("automations.triggerHints.order_failed") },
  ]
}

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_template":
      return { template_name: "", language: "en_US" }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const { t } = useTranslation()
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === "condition" ? { yes: [], no: [] } : undefined,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: state.name || t("automations.builder.untitled"),
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? t("automations.failedToSave"))
        }
        return
      }
      toast.success(t("automations.automationSaved"))
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-950">
      {/* Top bar */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
          aria-label={t("automations.builder.backToAutomations")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder={t("automations.builder.untitled")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-white placeholder:text-slate-500 focus:bg-slate-800 focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="hidden sm:inline">{t("automations.builder.active")}</span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label={t("automations.builder.active")}
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? t("automations.builder.save") : t("automations.builder.saveDraft")}
        </Button>
      </header>

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle,#1e293b_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-0 px-4 py-10">
          <TriggerCard
            type={state.trigger_type}
            config={state.trigger_config}
            onTypeChange={(tVal) => patchTop("trigger_type", tVal)}
            onConfigChange={(cVal) => patchTop("trigger_config", cVal)}
          />
          <StepList
            steps={state.steps}
            parentPath={[]}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            updateStep={updateStep}
            addStepAt={addStepAt}
            deleteStepAt={deleteStepAt}
            moveStepAt={moveStepAt}
          />
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  onTypeChange,
  onConfigChange,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
}) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const TRIGGER_OPTIONS = getTriggerOptions(t)
  return (
    <div className="z-10 w-full max-w-[320px] sm:w-80">
      <div className="rounded-lg border border-slate-800 border-l-4 border-l-blue-500 bg-slate-900 shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-blue-300">{t("automations.builder.trigger")}</div>
            <div className="truncate text-sm font-medium text-white">
              {TRIGGER_OPTIONS.find((o) => o.value === type)?.label ?? type}
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 text-slate-400 transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-slate-800 px-4 py-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">
                {t("automations.builder.triggerType")}
              </label>
              <select
                value={type}
                onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
                className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white focus:border-primary focus:outline-none"
              >
                {TRIGGER_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                {TRIGGER_OPTIONS.find((o) => o.value === type)?.hint}
              </p>
            </div>
            {type === "keyword_match" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
              />
            )}
            {type === "tag_added" && (
              <Input
                placeholder={t("automations.builder.tagIdPlaceholder")}
                value={(config.tag_id as string) ?? ""}
                onChange={(e) =>
                  onConfigChange({ ...config, tag_id: e.target.value })
                }
                className="bg-slate-800 text-white"
              />
            )}
            {type === "time_based" && (
              <Input
                placeholder={t("automations.builder.cronPlaceholder")}
                value={(config.schedule as string) ?? ""}
                onChange={(e) =>
                  onConfigChange({ ...config, schedule: e.target.value })
                }
                className="bg-slate-800 text-white"
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const keywords = config?.keywords ?? []
  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">
          {t("automations.builder.keywordsLabel")}
        </label>
        <Input
          value={keywords.join(", ")}
          onChange={(e) =>
            onChange({
              ...config,
              keywords: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          className="bg-slate-800 text-white"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-400">
          {t("automations.builder.matchTypeLabel")}
        </label>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) => onChange({ ...config, match_type: e.target.value as "exact" | "contains" })}
          className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white focus:outline-none"
        >
          <option value="contains">{t("automations.builder.containsOption")}</option>
          <option value="exact">{t("automations.builder.exactOption")}</option>
        </select>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

type ParentScope =
  | { kind: "root" }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no" }

type StepPath = (
  | { kind: "root"; index: number }
  | { kind: "branch"; parentCid: string; branch: "yes" | "no"; index: number }
)[]

interface StepListProps {
  steps: BuilderStep[]
  parentPath: StepPath
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  addStepAt: (parent: ParentScope, index: number, type: AutomationStepType) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
}

function StepList(props: StepListProps) {
  const { steps, parentPath, ...rest } = props
  const parentScope: ParentScope =
    parentPath.length === 0
      ? { kind: "root" }
      : (() => {
          const last = parentPath[parentPath.length - 1]
          if (last.kind !== "branch") return { kind: "root" } as const
          return { kind: "branch", parentCid: last.parentCid, branch: last.branch } as const
        })()

  return (
    <div className="flex flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(parentScope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          parentScope={parentScope}
          parentPath={parentPath}
          {...rest}
        />
      ))}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  parentScope,
  parentPath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  parentScope: ParentScope
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const { t } = useTranslation()
  const path: StepPath = [
    ...parentPath,
    parentScope.kind === "root"
      ? { kind: "root", index }
      : { kind: "branch", parentCid: parentScope.parentCid, branch: parentScope.branch, index },
  ]
  const meta = getStepMeta(step.step_type, t)
  const Icon = meta.icon
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  // Card widths on mobile fill the full canvas column (max-w-2xl px-4
  // still keeps them reasonable). On sm+ the original fixed widths
  // come back so the flow visual stays recognisable.
  const width = isCondition
    ? "w-full max-w-[400px] sm:w-[400px]"
    : "w-full max-w-[320px] sm:w-80"

  return (
    <>
      <div className={cn("z-10 flex flex-col", width)}>
        <div
          className={cn(
            "rounded-lg border border-slate-800 border-l-4 bg-slate-900 shadow-lg",
            meta.border,
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical className="h-4 w-4 flex-shrink-0 text-slate-600" aria-hidden />
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-800 text-slate-300">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-slate-400">
                {isCondition
                  ? t("automations.stepCondition")
                  : step.step_type === "wait"
                  ? t("automations.stepWait")
                  : t("automations.stepAction")}
              </div>
              <div className="truncate text-sm font-medium text-white">{meta.label}</div>
              <div className="truncate text-[11px] text-slate-500">{previewFor(step, t)}</div>
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-slate-400 transition-transform", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <div className="border-t border-slate-800 px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-800 pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label={t("common.moveUp")}
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    aria-label={t("common.moveDown")}
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("automations.builder.deleteButton")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} parentPath={path} {...props} />
        )}
      </div>

      <AddButton
        onPick={(tVal) => props.addStepAt(parentScope, index + 1, tVal)}
      />
    </>
  )
}

function ConditionBranches({
  step,
  parentPath,
  ...props
}: {
  step: BuilderStep
  parentPath: StepPath
} & Omit<StepListProps, "steps" | "parentPath">) {
  const { t } = useTranslation()
  const yes = step.branches?.yes ?? []
  const no = step.branches?.no ?? []
  // Build the child scope by appending a branch marker. The scope the
  // StepList uses is driven by the LAST element of parentPath, so the
  // tail's `index` doesn't matter — it's replaced per child during walks.
  const yesPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "yes", index: 0 },
  ]
  const noPath: StepPath = [
    ...parentPath,
    { kind: "branch", parentCid: step.cid, branch: "no", index: 0 },
  ]
  return (
    // Stack Yes/No vertically on mobile — two columns at 375px would
    // cram each branch to ~170px which is too narrow for the nested
    // cards. Two-column grid returns on sm+.
    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <BranchColumn label={t("automations.builder.yesLabel")} color="text-primary">
        <StepList {...props} steps={yes} parentPath={yesPath} />
      </BranchColumn>
      <BranchColumn label={t("automations.builder.noLabel")} color="text-rose-400">
        <StepList {...props} steps={no} parentPath={noPath} />
      </BranchColumn>
    </div>
  )
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center">
      <div className={cn("mb-2 text-[11px] font-semibold uppercase", color)}>{label}</div>
      {children}
    </div>
  )
}

function AddButton({ onPick }: { onPick: (t: AutomationStepType) => void }) {
  const { t } = useTranslation()
  const meta = (stepType: AutomationStepType) => getStepMeta(stepType, t)
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-[2px] bg-slate-700" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-slate-700 bg-slate-950 text-slate-400 transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary"
          aria-label={t("automations.builder.addStepLabel")}
        >
          <Plus className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 min-w-56 overflow-y-auto border-slate-700 bg-slate-900"
        >
          {ADDABLE_STEPS.map((tType) => {
            const stepMeta = meta(tType)
            const Icon = stepMeta.icon
            return (
              <DropdownMenuItem key={tType} onClick={() => onPick(tType)}>
                <Icon className="h-4 w-4" />
                {stepMeta.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-[2px] bg-slate-700" aria-hidden />
    </div>
  )
}

// ------------------------------------------------------------
// Send Template step — fetches approved templates from the user's
// catalog (synced from Meta via /api/whatsapp/templates/sync),
// parses the body's {{1}}..{{N}} placeholders, and renders an
// input per variable. Each input accepts plain text OR the dynamic
// placeholders the engine knows how to resolve (see the `interpolate`
// function in lib/automations/engine.ts).
// ------------------------------------------------------------

interface ApprovedTemplate {
  id: string
  name: string
  language: string
  body_text: string | null
  category: string | null
}

// Parses "{{1}}, {{2}}, {{10}}" out of the body and returns the unique
// placeholder indexes in ascending numeric order. We deduplicate
// because Meta allows the same placeholder to repeat in the body
// (e.g. "Olá {{1}}, seu pedido {{2}} chegou, {{1}}!") and we only
// want one input per number.
function extractPlaceholders(body: string): string[] {
  const seen = new Set<string>()
  for (const m of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    seen.add(m[1])
  }
  return Array.from(seen).sort((a, b) => Number(a) - Number(b))
}

function SendTemplateConfig({
  cfg,
  set,
}: {
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const [templates, setTemplates] = useState<ApprovedTemplate[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()
    supabase
      .from("message_templates")
      .select("id, name, language, body_text, category")
      .eq("status", "Approved")
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          // Don't toast — the field still works as a free input.
          // Just surface in console for debugging.
          console.error("[builder] failed to load templates", error)
        }
        setTemplates((data as ApprovedTemplate[] | null) ?? [])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const currentName = (cfg.template_name as string) ?? ""
  const currentLang = (cfg.language as string) ?? ""
  const variables = (cfg.variables as Record<string, string> | undefined) ?? {}

  // Find the currently-selected template (match by name+language) so we
  // can read its body and surface the placeholder count. Falls back to
  // matching name only when language is empty, which happens on legacy
  // automations that pre-date this UI.
  const selected = useMemo(() => {
    if (!currentName) return null
    return (
      templates.find(
        (t) => t.name === currentName && (!currentLang || t.language === currentLang),
      ) ?? null
    )
  }, [templates, currentName, currentLang])

  const placeholders = useMemo(
    () => extractPlaceholders(selected?.body_text ?? ""),
    [selected],
  )

  // When the user picks a template, prefill the language and trim any
  // saved variables whose key no longer matches a placeholder in the
  // newly-selected template (avoids stale `cfg.variables` keys piling
  // up across template changes).
  function handleSelect(value: string) {
    if (!value) {
      set({ template_name: "", language: "", variables: {} })
      return
    }
    const [name, lang] = value.split("|||")
    const t = templates.find((x) => x.name === name && x.language === lang)
    if (!t) return
    const newPlaceholders = extractPlaceholders(t.body_text ?? "")
    const trimmedVars: Record<string, string> = {}
    for (const k of newPlaceholders) {
      if (variables[k] != null) trimmedVars[k] = variables[k]
    }
    set({
      template_name: t.name,
      language: t.language,
      variables: trimmedVars,
    })
  }

  const selectValue = selected ? `${selected.name}|||${selected.language}` : ""

  return (
    <>
      <FieldBlock label={t("automations.builder.templateSelectLabel")}>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            ...
          </div>
        ) : templates.length === 0 ? (
          <p className="text-xs text-amber-400">
            {t("automations.builder.templateNoneApproved")}
          </p>
        ) : (
          <select
            value={selectValue}
            onChange={(e) => handleSelect(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
          >
            <option value="">{t("automations.builder.templateSelectPlaceholder")}</option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={`${tpl.name}|||${tpl.language}`}>
                {tpl.name} ({tpl.language})
              </option>
            ))}
          </select>
        )}
      </FieldBlock>

      {/* Always allow manual entry as a fallback — useful when the
          template wasn't synced yet or when authoring an automation
          before approval. */}
      <FieldBlock label={t("automations.builder.templateManualLabel")}>
        <div className="grid grid-cols-3 gap-2">
          <Input
            value={currentName}
            onChange={(e) => set({ template_name: e.target.value })}
            placeholder="template_name"
            className="col-span-2 bg-slate-800 text-white"
          />
          <Input
            value={currentLang}
            onChange={(e) => set({ language: e.target.value })}
            placeholder="pt_BR"
            className="bg-slate-800 text-white"
          />
        </div>
      </FieldBlock>

      {selected && (
        <FieldBlock label={t("automations.builder.templateVariablesLabel")}>
          {placeholders.length === 0 ? (
            <p className="text-xs text-slate-400">
              {t("automations.builder.templateNoVariables")}
            </p>
          ) : (
            <div className="space-y-2">
              {placeholders.map((idx) => (
                <div key={idx} className="grid grid-cols-[3rem_1fr] items-center gap-2">
                  <span className="text-center font-mono text-xs text-slate-400">
                    {`{{${idx}}}`}
                  </span>
                  <Input
                    value={variables[idx] ?? ""}
                    onChange={(e) =>
                      set({
                        variables: { ...variables, [idx]: e.target.value },
                      })
                    }
                    placeholder="{{customer.name}}"
                    className="bg-slate-800 text-white"
                  />
                </div>
              ))}
              <p className="text-xs text-slate-500">
                {t("automations.builder.templateVariableHelp")}
              </p>
            </div>
          )}
        </FieldBlock>
      )}
    </>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const { t } = useTranslation()
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <FieldBlock label={t("automations.builder.messageTextLabel")}>
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t("automations.builder.messagePlaceholder")}
            className="min-h-24 bg-slate-800 text-white"
          />
        </FieldBlock>
      )
    case "send_template":
      return <SendTemplateConfig cfg={cfg} set={set} />
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("automations.builder.tagIdLabel")}>
          <Input
            value={(cfg.tag_id as string) ?? ""}
            onChange={(e) => set({ tag_id: e.target.value })}
            className="bg-slate-800 text-white"
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("automations.builder.modeLabel")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
            >
              <option value="round_robin">{t("automations.builder.roundRobinOption")}</option>
              <option value="specific">{t("automations.builder.specificAgentOption")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("automations.builder.agentIdLabel")}>
              <Input
                value={(cfg.agent_id as string) ?? ""}
                onChange={(e) => set({ agent_id: e.target.value })}
                className="bg-slate-800 text-white"
              />
            </FieldBlock>
          )}
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("automations.builder.fieldLabel")}>
            <select
              value={(cfg.field as string) ?? "name"}
              onChange={(e) => set({ field: e.target.value })}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
            >
              <option value="name">{t("automations.builder.nameOption")}</option>
              <option value="email">{t("automations.builder.emailOption")}</option>
              <option value="company">{t("automations.builder.companyOption")}</option>
            </select>
          </FieldBlock>
          <FieldBlock label={t("automations.builder.valueLabel")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <FieldBlock label={t("automations.builder.pipelineIdLabel")}>
            <Input
              value={(cfg.pipeline_id as string) ?? ""}
              onChange={(e) => set({ pipeline_id: e.target.value })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
          <FieldBlock label={t("automations.builder.stageIdLabel")}>
            <Input
              value={(cfg.stage_id as string) ?? ""}
              onChange={(e) => set({ stage_id: e.target.value })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
          <FieldBlock label={t("automations.builder.titleLabel")}>
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
          <FieldBlock label={t("automations.builder.valueLabel")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("automations.builder.amountLabel")}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
          <FieldBlock label={t("automations.builder.unitLabel")}>
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
            >
              <option value="minutes">{t("automations.builder.minutesOption")}</option>
              <option value="hours">{t("automations.builder.hoursOption")}</option>
              <option value="days">{t("automations.builder.daysOption")}</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return (
        <>
          <FieldBlock label={t("automations.builder.subjectLabel")}>
            <select
              value={(cfg.subject as string) ?? "tag_presence"}
              onChange={(e) => set({ subject: e.target.value })}
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-white"
            >
              <option value="tag_presence">{t("automations.builder.tagPresenceOption")}</option>
              <option value="contact_field">{t("automations.builder.contactFieldOption")}</option>
              <option value="message_content">{t("automations.builder.messageContentOption")}</option>
              <option value="time_of_day">{t("automations.builder.timeOfDayOption")}</option>
            </select>
          </FieldBlock>
          <FieldBlock label={t("automations.builder.operandLabel")}>
            <Input
              placeholder={
                cfg.subject === "time_of_day"
                  ? t("automations.builder.timeRangePlaceholder")
                  : cfg.subject === "contact_field"
                  ? t("automations.builder.contactFieldsPlaceholder")
                  : cfg.subject === "tag_presence"
                  ? t("automations.builder.tagIdPlaceholderInput")
                  : ""
              }
              value={(cfg.operand as string) ?? ""}
              onChange={(e) => set({ operand: e.target.value })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
          {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
            <FieldBlock label={t("automations.builder.valueLabel")}>
              <Input
                value={(cfg.value as string) ?? ""}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-slate-800 text-white"
              />
            </FieldBlock>
          )}
        </>
      )
    case "send_webhook":
      return (
        <>
          <FieldBlock label={t("automations.builder.urlLabel")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-slate-800 text-white"
            />
          </FieldBlock>
          <FieldBlock label={t("automations.builder.bodyTemplateLabel")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-slate-800 font-mono text-xs text-white"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-slate-400">
          {t("automations.builder.closeConvHelp")}
        </p>
      )
    default:
      return null
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-slate-400">{label}</label>
      {children}
    </div>
  )
}

function previewFor(step: BuilderStep, t: (key: string) => string): string {
  switch (step.step_type) {
    case "send_message":
      return (step.step_config.text as string) || t("automations.builder.noText")
    case "send_template":
      return (step.step_config.template_name as string) || t("automations.builder.pickTemplate")
    case "wait":
      return `${step.step_config.amount ?? "?"} ${step.step_config.unit ?? ""}`
    case "condition":
      return t("automations.builder.whenSubject").replace("{subject}", (step.step_config.subject as string) || "?")
    case "send_webhook":
      return (step.step_config.url as string) || t("automations.builder.noUrl")
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Tree mutation helpers
// ------------------------------------------------------------

function insertAt(
  steps: BuilderStep[],
  parent: ParentScope,
  index: number,
  node: BuilderStep,
): BuilderStep[] {
  if (parent.kind === "root") {
    const copy = [...steps]
    copy.splice(index, 0, node)
    return copy
  }
  return steps.map((s) => {
    if (s.cid !== parent.parentCid || !s.branches) return s
    const list = [...s.branches[parent.branch]]
    list.splice(index, 0, node)
    return { ...s, branches: { ...s.branches, [parent.branch]: list } }
  })
}

function mapAtPath(
  steps: BuilderStep[],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)

  if (head.kind === "root") {
    return steps.map((s, i) => {
      if (i !== head.index) return s
      return rest.length === 0
        ? updater(s)
        : { ...s, branches: walkBranches(s.branches, rest, updater) }
    })
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const updated = bucket.map((child, i) => {
      if (i !== head.index) return child
      return rest.length === 0
        ? updater(child)
        : { ...child, branches: walkBranches(child.branches, rest, updater) }
    })
    return { ...s, branches: { ...s.branches, [head.branch]: updated } }
  })
}

function walkBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  updater: (s: BuilderStep) => BuilderStep,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const bucket = branches[head.branch]
  const rest = path.slice(1)
  const updated = bucket.map((child, i) => {
    if (i !== head.index) return child
    return rest.length === 0
      ? updater(child)
      : { ...child, branches: walkBranches(child.branches, rest, updater) }
  })
  return { ...branches, [head.branch]: updated }
}

function removeAt(steps: BuilderStep[], path: StepPath): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  if (head.kind === "root") {
    if (rest.length === 0) return steps.filter((_, i) => i !== head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: removeFromBranches(s.branches, rest) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next =
      rest.length === 0
        ? bucket.filter((_, i) => i !== head.index)
        : bucket.map((child, i) =>
            i !== head.index
              ? child
              : { ...child, branches: removeFromBranches(child.branches, rest) },
          )
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function removeFromBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const next =
    rest.length === 0
      ? bucket.filter((_, i) => i !== head.index)
      : bucket.map((child, i) =>
          i !== head.index
            ? child
            : { ...child, branches: removeFromBranches(child.branches, rest) },
        )
  return { ...branches, [head.branch]: next }
}

function moveAt(
  steps: BuilderStep[],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep[] {
  if (path.length === 0) return steps
  const head = path[0]
  const rest = path.slice(1)
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  if (head.kind === "root") {
    if (rest.length === 0) return swap(steps, head.index)
    return steps.map((s, i) =>
      i !== head.index ? s : { ...s, branches: moveInBranches(s.branches, rest, direction) },
    )
  }
  return steps.map((s) => {
    if (s.cid !== head.parentCid || !s.branches) return s
    const bucket = s.branches[head.branch]
    const next = rest.length === 0 ? swap(bucket, head.index) : bucket
    return { ...s, branches: { ...s.branches, [head.branch]: next } }
  })
}

function moveInBranches(
  branches: BuilderStep["branches"],
  path: StepPath,
  direction: -1 | 1,
): BuilderStep["branches"] {
  if (!branches) return branches
  const head = path[0]
  if (head.kind !== "branch") return branches
  const rest = path.slice(1)
  const bucket = branches[head.branch]
  const swap = <T,>(arr: T[], i: number) => {
    const j = i + direction
    if (j < 0 || j >= arr.length) return arr
    const copy = [...arr]
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
    return copy
  }
  const next = rest.length === 0 ? swap(bucket, head.index) : bucket
  return { ...branches, [head.branch]: next }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}
