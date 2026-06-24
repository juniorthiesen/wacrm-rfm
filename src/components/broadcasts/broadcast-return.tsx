'use client';

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Loader2, TrendingUp } from 'lucide-react';

// Retorno da campanha: conversão atribuída (pedidos pagos por quem
// recebeu, dentro da janela) + custo (custo/msg × enviadas) → ROAS e
// lucro. Lê broadcast_performance (migração 042) e persiste o custo por
// mensagem em broadcasts.msg_cost.

interface Performance {
  window_days: number;
  total: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  buyers: number;
  paid_orders: number;
  revenue: number;
  buyers_all: number;
  orders_all: number;
  revenue_all: number;
}

const brl = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);

export function BroadcastReturn({
  broadcastId,
  initialMsgCost,
}: {
  broadcastId: string;
  initialMsgCost: number | null;
}) {
  const [perf, setPerf] = useState<Performance | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState(7);
  const [msgCost, setMsgCost] = useState(
    initialMsgCost != null ? String(initialMsgCost) : '0.30',
  );
  const [savingCost, setSavingCost] = useState(false);

  // setState only happens after the await (async), so this is safe to
  // call from an effect without tripping react-hooks/set-state-in-effect.
  // The spinner for a window change is toggled in the select handler.
  const load = useCallback(
    async (days: number) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('broadcast_performance', {
        p_broadcast_id: broadcastId,
        p_window_days: days,
      });
      if (error) {
        console.error('[broadcast-return] perf failed:', error);
      } else {
        setPerf(data as Performance);
      }
      setLoading(false);
    },
    [broadcastId],
  );

  useEffect(() => {
    void load(windowDays);
  }, [load, windowDays]);

  async function saveMsgCost() {
    const v = Number(msgCost);
    if (!Number.isFinite(v) || v < 0) {
      toast.error('Custo por mensagem inválido');
      return;
    }
    setSavingCost(true);
    const supabase = createClient();
    const { error } = await supabase
      .from('broadcasts')
      .update({ msg_cost: v })
      .eq('id', broadcastId);
    setSavingCost(false);
    if (error) toast.error('Falha ao salvar o custo');
    else toast.success('Custo salvo');
  }

  const cost = perf ? perf.sent * (Number(msgCost) || 0) : 0;
  const revenue = perf?.revenue ?? 0;
  const roas = cost > 0 ? revenue / cost : null;
  const profit = revenue - cost;
  const convRate = perf && perf.sent > 0 ? (perf.buyers / perf.sent) * 100 : 0;
  const costPerBuyer = perf && perf.buyers > 0 ? cost / perf.buyers : null;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-white">Retorno</h3>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Janela de atribuição</span>
          <select
            className="rounded-lg border border-slate-700 bg-slate-950/50 px-2 py-1 text-white"
            value={windowDays}
            onChange={(e) => {
              setLoading(true);
              setWindowDays(Number(e.target.value));
            }}
          >
            <option value={7}>7 dias</option>
            <option value={14}>14 dias</option>
            <option value={30}>30 dias</option>
          </select>
        </div>
      </div>

      {loading || !perf ? (
        <div className="flex h-28 items-center justify-center text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* Conversão + retorno */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Compradores" value={perf.buyers.toLocaleString('pt-BR')}
              sub={`${convRate.toFixed(1)}% das enviadas`} />
            <Metric label="Receita atribuída" value={brl(revenue)}
              sub={`${perf.paid_orders} pedido(s) pago(s)`} highlight />
            <Metric label="Custo estimado" value={brl(cost)}
              sub={`${perf.sent.toLocaleString('pt-BR')} msgs enviadas`} />
            <Metric
              label="ROAS"
              value={roas != null ? `${roas.toFixed(1)}x` : '—'}
              sub={`Lucro ${brl(profit)}`}
              highlight={roas != null && roas >= 1}
            />
          </div>

          {/* Custo por mensagem (persistido) */}
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-slate-800 pt-4">
            <div>
              <label className="mb-1 block text-xs text-slate-400">
                Custo por mensagem (R$)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={msgCost}
                onChange={(e) => setMsgCost(e.target.value)}
                className="w-32 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-white focus:border-primary focus:outline-none"
              />
            </div>
            <button
              onClick={saveMsgCost}
              disabled={savingCost}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              {savingCost ? 'Salvando…' : 'Salvar custo'}
            </button>
            {costPerBuyer != null && (
              <p className="ml-auto text-xs text-slate-500">
                Custo por comprador:{' '}
                <span className="font-medium text-slate-300">{brl(costPerBuyer)}</span>
              </p>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
            Atribuição: pedidos pagos feitos por quem recebeu, em até{' '}
            {perf.window_days} dias após o envio. Recompra de reativação leva dias —
            o número cresce ao longo da janela.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <p className="text-[11px] uppercase tracking-wider text-slate-500">{label}</p>
      <p
        className={`mt-1 text-lg font-bold tabular-nums ${
          highlight ? 'text-primary' : 'text-white'
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p>
    </div>
  );
}
