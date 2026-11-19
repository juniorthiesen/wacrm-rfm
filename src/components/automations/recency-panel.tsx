'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FlaskConical, BarChart3, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Ensaio + relatório da régua de reativação (gatilho "Dias sem comprar").
 * Fica no editor da automação, só depois de salva. O ensaio NÃO inscreve nem
 * envia nada: mostra quem entraria hoje e se o resto da cadeia está pronto.
 */

interface DryRun {
  config: {
    min_days: number;
    max_days: number;
    daily_cap: number;
    control_percent: number;
  };
  effective_cap: number;
  ready: boolean;
  problems: string[];
  enrolled_today: number;
  budget_today: number;
  eligible_total: number;
  days_to_drain: number | null;
  would_enroll: { total: number; treatment: number; control: number };
  sample: Array<{
    email: string;
    first_name: string | null;
    recency_days: number;
    cohort: string;
  }>;
  warnings: string[];
}

interface CohortStat {
  enrolled: number;
  matured: number;
  converted: number;
  orders_count: number;
  revenue: number;
  conversion_rate: number;
  revenue_per_person: number;
}

interface Report {
  window_days: number;
  report: {
    treatment: CohortStat;
    control: CohortStat;
    uplift_points: number | null;
    incremental_conversions: number | null;
    incremental_revenue: number | null;
    warnings: string[];
  };
  emails: Record<string, number>;
  runs: Record<string, number>;
  coupons_issued: number;
}

const brl = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (n: number) => `${(n * 100).toFixed(2).replace('.', ',')}%`;

export function RecencyPanel({ automationId }: { automationId: string }) {
  const [loading, setLoading] = useState<'dry' | 'report' | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [days, setDays] = useState(7);

  async function runDry() {
    setLoading('dry');
    try {
      const res = await fetch(`/api/automations/${automationId}/dry-run`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok) return toast.error(json.error ?? 'Falha no ensaio');
      setDry(json as DryRun);
    } finally {
      setLoading(null);
    }
  }

  async function loadReport() {
    setLoading('report');
    try {
      const res = await fetch(
        `/api/automations/${automationId}/report?days=${days}`
      );
      const json = await res.json();
      if (!res.ok)
        return toast.error(json.error ?? 'Falha ao carregar o relatório');
      setReport(json as Report);
    } finally {
      setLoading(null);
    }
  }

  const cohortRow = (label: string, c: CohortStat) => (
    <tr className="border-t border-slate-700">
      <td className="py-1.5 pr-3 text-slate-300">{label}</td>
      <td className="py-1.5 pr-3 text-right text-white">{c.enrolled}</td>
      <td className="py-1.5 pr-3 text-right text-white">{c.converted}</td>
      <td className="py-1.5 pr-3 text-right text-white">
        {pct(c.conversion_rate)}
      </td>
      <td className="py-1.5 pr-3 text-right text-white">{brl(c.revenue)}</td>
      <td className="py-1.5 text-right text-white">
        {brl(c.revenue_per_person)}
      </td>
    </tr>
  );

  return (
    <div className="space-y-4 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div>
        <h3 className="text-sm font-semibold text-white">
          Ensaio e resultados da régua
        </h3>
        <p className="text-xs text-slate-400">
          O ensaio não inscreve nem envia nada. O relatório compara quem recebeu
          com o grupo de controle (inscrito, mas nunca contatado).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={runDry} disabled={loading !== null}>
          {loading === 'dry' ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <FlaskConical className="mr-2 size-4" />
          )}
          Rodar ensaio
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={loadReport}
            disabled={loading !== null}
          >
            {loading === 'report' ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <BarChart3 className="mr-2 size-4" />
            )}
            Ver relatório
          </Button>
          <label className="text-xs text-slate-400">
            janela
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="ml-1 rounded-md border border-slate-700 bg-slate-800 px-1.5 py-1 text-xs text-white"
            >
              {[3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} dias
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {dry && (
        <div className="space-y-3 text-sm">
          {dry.problems.length > 0 && (
            <div className="space-y-1 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
              <p className="font-semibold">
                Bloqueado: enquanto isto não for resolvido, a régua não inscreve
                ninguém (para não gastar a lista).
              </p>
              <ul className="space-y-1">
                {dry.problems.map((p) => (
                  <li key={p}>• {p}</li>
                ))}
              </ul>
            </div>
          )}
          {dry.warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              {dry.warnings.map((w) => (
                <li key={w}>• {w}</li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 text-slate-300 sm:grid-cols-2">
            <p>
              Elegíveis agora:{' '}
              <strong className="text-white">{dry.eligible_total}</strong>
            </p>
            <p>
              Teto diário:{' '}
              <strong className="text-white">{dry.effective_cap}</strong>
              {dry.effective_cap !== dry.config.daily_cap && (
                <> (configurado: {dry.config.daily_cap})</>
              )}{' '}
              · já entraram hoje: {dry.enrolled_today}
            </p>
            <p>
              Entrariam hoje:{' '}
              <strong className="text-white">{dry.would_enroll.total}</strong> (
              {dry.would_enroll.treatment} recebem, {dry.would_enroll.control}{' '}
              controle)
            </p>
            <p>
              Para esvaziar a fila:{' '}
              <strong className="text-white">{dry.days_to_drain ?? '—'}</strong>{' '}
              dias
            </p>
          </div>
          {dry.sample.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <th className="pb-1 text-left font-medium">Amostra</th>
                  <th className="pb-1 text-left font-medium">Nome</th>
                  <th className="pb-1 text-right font-medium">
                    Dias sem comprar
                  </th>
                  <th className="pb-1 text-right font-medium">Grupo</th>
                </tr>
              </thead>
              <tbody>
                {dry.sample.map((s) => (
                  <tr
                    key={s.email}
                    className="border-t border-slate-700 text-slate-300"
                  >
                    <td className="py-1">{s.email}</td>
                    <td className="py-1">{s.first_name ?? '—'}</td>
                    <td className="py-1 text-right">{s.recency_days}</td>
                    <td className="py-1 text-right">
                      {s.cohort === 'control' ? 'controle' : 'recebe'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {report && (
        <div className="space-y-3 text-sm">
          <table className="w-full text-xs">
            <thead className="text-slate-400">
              <tr>
                <th className="pb-1 text-left font-medium">
                  Grupo (janela {report.window_days} dias)
                </th>
                <th className="pb-1 text-right font-medium">Inscritos</th>
                <th className="pb-1 text-right font-medium">Compraram</th>
                <th className="pb-1 text-right font-medium">Conversão</th>
                <th className="pb-1 text-right font-medium">Receita</th>
                <th className="pb-1 text-right font-medium">Por pessoa</th>
              </tr>
            </thead>
            <tbody>
              {cohortRow('Recebeu a régua', report.report.treatment)}
              {cohortRow('Controle (não contatado)', report.report.control)}
            </tbody>
          </table>

          {report.report.uplift_points !== null && (
            <p className="text-slate-300">
              Efeito estimado da régua:{' '}
              <strong className="text-white">
                {report.report.uplift_points.toFixed(2).replace('.', ',')} p.p.
              </strong>{' '}
              de conversão ·{' '}
              <strong className="text-white">
                {Math.round(report.report.incremental_conversions ?? 0)}
              </strong>{' '}
              compras a mais ·{' '}
              <strong className="text-white">
                {brl(report.report.incremental_revenue ?? 0)}
              </strong>{' '}
              de receita a mais
            </p>
          )}
          {report.report.warnings.length > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              {report.report.warnings.map((w) => (
                <li key={w}>• {w}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-slate-400">
            E-mails:{' '}
            {Object.keys(report.emails).length === 0
              ? 'nenhum enviado ainda'
              : Object.entries(report.emails)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}{' '}
            · cupons emitidos: {report.coupons_issued}
          </p>
          <p
            className={
              (report.runs.failed ?? 0) > 0
                ? 'text-xs text-red-300'
                : 'text-xs text-slate-400'
            }
          >
            Execuções da sequência:{' '}
            {Object.keys(report.runs).length === 0
              ? 'nenhuma ainda'
              : Object.entries(report.runs)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(' · ')}
            {(report.runs.failed ?? 0) > 0 &&
              ' — há execuções com falha: veja o registro da automação (e-mail desligado? cupom sem permissão no Woo?)'}
          </p>
        </div>
      )}
    </div>
  );
}
