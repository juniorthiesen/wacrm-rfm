"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShoppingBag,
  Package,
  ExternalLink,
  Link2,
  Loader2,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/hooks/use-translation";
import { format } from "date-fns";
import { ptBR, enUS } from "date-fns/locale";

// Color palette for RFM segments. Hex pairs match how `tags` are styled
// elsewhere in the sidebar — a translucent background plus the color as
// text. Keep these in sync with /lib/rfm/engine.ts segment names.
const SEGMENT_COLORS: Record<string, string> = {
  champion: "#facc15", // amber
  loyal: "#3b82f6", // blue
  new_customer: "#10b981", // emerald
  about_to_sleep: "#eab308", // yellow
  in_risk: "#f97316", // orange
  hibernating: "#a855f7", // purple
  lost: "#94a3b8", // slate
  new_lead: "#06b6d4", // cyan
};

interface CommerceData {
  rfm: {
    segment: string | null;
    recency_days: number | null;
    frequency_count: number | null;
    monetary_value: number | null;
    rfm_score: string | null;
  } | null;
  stats: {
    order_count: number;
    total_spent: number;
    currency: string;
    last_ordered_at: string | null;
    days_since_last: number | null;
  };
  last_order: {
    id: string;
    external_order_id: string;
    number: string;
    platform: string;
    status: string;
    total: number;
    currency: string;
    ordered_at: string;
    items: Array<{ name: string; quantity: number; total: number | null }>;
    admin_url: string | null;
  } | null;
  products_purchased: Array<{ name: string; quantity: number; total: number }>;
}

interface Suggestion {
  id: string;
  external_order_id: string;
  order_number: string | null;
  platform: string;
  status: string;
  total_amount: number | string;
  currency: string;
  customer_phone: string | null;
  customer_email: string | null;
  ordered_at: string;
  matched_on: "phone" | "email" | null;
}

interface CommerceSectionProps {
  contactId: string;
}

function formatMoney(value: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "BRL",
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function CommerceSection({ contactId }: CommerceSectionProps) {
  const { t, locale } = useTranslation();
  const dateLocale = locale === "pt-BR" ? ptBR : enUS;
  const [data, setData] = useState<CommerceData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/commerce`, {
        cache: "no-store",
      });
      if (res.ok) {
        setData(await res.json());
      } else {
        setData(null);
      }
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="px-1 text-xs text-slate-600">
        {t("inbox.commerce.loading")}
      </div>
    );
  }

  const hasAnyData =
    !!data && (data.stats.order_count > 0 || data.rfm?.segment);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-1 text-xs font-medium uppercase tracking-wider text-slate-500">
        <span className="flex items-center gap-2">
          <ShoppingBag className="h-3 w-3" />
          {t("inbox.commerce.title")}
        </span>
        <LinkOrderDialog contactId={contactId} onLinked={fetchData} />
      </div>

      {!hasAnyData ? (
        <p className="mt-2 px-1 text-xs text-slate-600">
          {t("inbox.commerce.noData")}
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          {data?.rfm?.segment && (
            <div className="px-1">
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: `${SEGMENT_COLORS[data.rfm.segment] ?? "#94a3b8"}20`,
                  color: SEGMENT_COLORS[data.rfm.segment] ?? "#94a3b8",
                }}
              >
                {t(`inbox.commerce.segments.${data.rfm.segment}`)}
                {data.rfm.rfm_score ? ` · ${data.rfm.rfm_score}` : ""}
              </span>
            </div>
          )}

          {data && data.stats.order_count > 0 && (
            <div className="grid grid-cols-3 gap-2 px-1">
              <Stat
                label={t("inbox.commerce.orderCount")}
                value={String(data.stats.order_count)}
              />
              <Stat
                label={t("inbox.commerce.totalSpent")}
                value={formatMoney(
                  data.stats.total_spent,
                  data.stats.currency,
                  locale,
                )}
              />
              <Stat
                label={t("inbox.commerce.daysSinceLast")}
                value={
                  data.stats.days_since_last != null
                    ? `${data.stats.days_since_last}d`
                    : "—"
                }
              />
            </div>
          )}

          {data?.last_order && (
            <div className="rounded-lg bg-slate-800 px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-slate-500">
                    {t("inbox.commerce.lastOrder")}
                  </p>
                  <p className="truncate text-sm font-medium text-white">
                    #{data.last_order.number}
                  </p>
                </div>
                {data.last_order.admin_url && (
                  <a
                    href={data.last_order.admin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t("inbox.commerce.viewInStore")}
                    className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-700 hover:text-white"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                <span>
                  {formatMoney(
                    data.last_order.total,
                    data.last_order.currency,
                    locale,
                  )}
                </span>
                <span className="rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px]">
                  {data.last_order.status}
                </span>
              </div>
              <p className="mt-1 text-[10px] text-slate-600">
                {format(
                  new Date(data.last_order.ordered_at),
                  locale === "pt-BR" ? "dd/MM/yyyy" : "MMM d, yyyy",
                  { locale: dateLocale },
                )}
              </p>
            </div>
          )}

          {data && data.products_purchased.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-1 text-[10px] uppercase tracking-wider text-slate-500">
                <Package className="h-3 w-3" />
                {t("inbox.commerce.productsPurchased")}
              </div>
              <ul className="mt-1 space-y-1 px-1">
                {data.products_purchased.map((p) => (
                  <li
                    key={p.name}
                    className="flex items-center justify-between text-xs text-slate-300"
                  >
                    <span className="truncate">{p.name}</span>
                    <span className="ml-2 shrink-0 text-slate-500">
                      ×{p.quantity}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-800 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="truncate text-xs font-semibold text-white">{value}</p>
    </div>
  );
}

interface LinkOrderDialogProps {
  contactId: string;
  onLinked: () => void;
}

function LinkOrderDialog({ contactId, onLinked }: LinkOrderDialogProps) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState(false);

  const loadSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/link-order`, {
        cache: "no-store",
      });
      if (res.ok) {
        const json = await res.json();
        setSuggestions(json.suggestions ?? []);
      }
    } catch {
      setSuggestions([]);
    }
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    if (open) {
      // setSelected runs synchronously to clear selections; loadSuggestions
      // schedules its own setState inside an async callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(new Set());
      loadSuggestions();
    }
  }, [open, loadSuggestions]);

  const handleToggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLink = async () => {
    if (selected.size === 0) return;
    setLinking(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/link-order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_ids: Array.from(selected) }),
      });
      if (res.ok) {
        setOpen(false);
        onLinked();
      }
    } catch {
      // surface a toast in a follow-up; silent failure for now
    }
    setLinking(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-normal text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
      >
        <Link2 className="h-3 w-3" />
        {t("inbox.commerce.linkOrder")}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("inbox.commerce.linkOrderTitle")}</DialogTitle>
            <DialogDescription>
              {t("inbox.commerce.linkOrderDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-sm text-slate-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("inbox.commerce.loading")}
              </div>
            ) : suggestions.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-500">
                {t("inbox.commerce.noSuggestions")}
              </p>
            ) : (
              <ul className="space-y-1">
                {suggestions.map((s) => {
                  const isSelected = selected.has(s.id);
                  const amt =
                    typeof s.total_amount === "number"
                      ? s.total_amount
                      : parseFloat(s.total_amount) || 0;
                  return (
                    <li key={s.id}>
                      <button
                        onClick={() => handleToggle(s.id)}
                        className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          isSelected
                            ? "border-primary/50 bg-primary/10"
                            : "border-slate-800 hover:bg-slate-800"
                        }`}
                      >
                        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-slate-600">
                          {isSelected && (
                            <Check className="h-3 w-3 text-primary" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              #{s.order_number ?? s.external_order_id}
                            </span>
                            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                              {s.platform}
                            </span>
                            {s.matched_on === "phone" && (
                              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-400">
                                {t("inbox.commerce.matchedByPhone")}
                              </span>
                            )}
                            {s.matched_on === "email" && (
                              <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-400">
                                {t("inbox.commerce.matchedByEmail")}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                            <span>
                              {formatMoney(amt, s.currency || "BRL", locale)}
                            </span>
                            <span>·</span>
                            <span>{s.status}</span>
                            <span>·</span>
                            <span>
                              {new Date(s.ordered_at).toLocaleDateString(
                                locale,
                              )}
                            </span>
                          </div>
                          {(s.customer_phone || s.customer_email) && (
                            <p className="mt-0.5 truncate text-[10px] text-slate-600">
                              {s.customer_phone}
                              {s.customer_phone && s.customer_email && " · "}
                              {s.customer_email}
                            </p>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={handleLink}
              disabled={selected.size === 0 || linking}
            >
              {linking ? (
                <>
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  {t("inbox.commerce.linking")}
                </>
              ) : (
                `${t("inbox.commerce.linkSelected")} (${selected.size})`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
