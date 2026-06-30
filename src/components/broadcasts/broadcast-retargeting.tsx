'use client';

import { useRouter } from 'next/navigation';
import { Broadcast, BroadcastRecipient } from '@/types';
import { Users, ArrowRight, RefreshCw } from 'lucide-react';

interface Segment {
  key: string;
  label: string;
  description: string;
  color: string;
  contacts: { phone: string; name?: string }[];
}

interface Props {
  broadcast: Broadcast;
  recipients: BroadcastRecipient[];
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  replied: 4,
  failed: -1,
};

function toContact(r: BroadcastRecipient) {
  return { phone: r.contact?.phone ?? '', name: r.contact?.name };
}

export function BroadcastRetargeting({ broadcast, recipients }: Props) {
  const router = useRouter();

  const notDelivered = recipients.filter(
    (r) => r.status === 'sent' || r.status === 'failed',
  );
  const notRead = recipients.filter((r) => r.status === 'delivered');
  const notReplied = recipients.filter((r) => r.status === 'read');
  const replied = recipients.filter((r) => r.status === 'replied');

  const segments: Segment[] = [
    {
      key: 'not_delivered',
      label: 'Não entregues',
      description: 'Enviados mas sem confirmação de entrega',
      color: 'border-red-500/20 bg-red-500/5 text-red-400',
      contacts: notDelivered.map(toContact),
    },
    {
      key: 'not_read',
      label: 'Não leram',
      description: 'Entregues mas sem leitura confirmada',
      color: 'border-yellow-500/20 bg-yellow-500/5 text-yellow-400',
      contacts: notRead.map(toContact),
    },
    {
      key: 'not_replied',
      label: 'Não responderam',
      description: 'Leram mas não responderam',
      color: 'border-blue-500/20 bg-blue-500/5 text-blue-400',
      contacts: notReplied.map(toContact),
    },
    {
      key: 'replied',
      label: 'Engajaram',
      description: 'Responderam — público quente para follow-up',
      color: 'border-primary/20 bg-primary/5 text-primary',
      contacts: replied.map(toContact),
    },
  ].filter((s) => s.contacts.length > 0);

  // "Próximo lote" is only meaningful when the broadcast used a dynamic
  // filter (tags / all / custom_field) — a CSV audience has no filter
  // to re-run, and there's nothing to "add" to a closed list.
  const audienceFilter = broadcast.audience_filter as
    | { type?: string }
    | null
    | undefined;
  const canNextBatch =
    audienceFilter?.type === 'all' ||
    audienceFilter?.type === 'tags' ||
    audienceFilter?.type === 'custom_field';

  const hasAnything = segments.length > 0 || canNextBatch;
  if (!hasAnything) return null;

  function handleRetarget(segment: Segment) {
    const key = `retarget_${Date.now()}`;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        contacts: segment.contacts.filter((c) => c.phone),
        label: `${segment.label} — ${broadcast.name}`,
      }),
    );
    router.push(`/broadcasts/new?retarget=${key}`);
  }

  function handleNextBatch() {
    const key = `retarget_${Date.now()}`;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        type: 'next_batch',
        audience_filter: broadcast.audience_filter,
        exclude_broadcast_id: broadcast.id,
        label: `Próximo lote — ${broadcast.name}`,
      }),
    );
    router.push(`/broadcasts/new?retarget=${key}`);
  }

  return (
    <div className="space-y-3">
      {/* Next-batch card — re-runs the original filter and excludes
          anyone already in this broadcast, so only new contacts land. */}
      {canNextBatch && (
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-primary" />
              <div>
                <p className="text-sm font-semibold text-white">Próximo lote</p>
                <p className="text-xs text-slate-400">
                  Mesma audiência desta campanha, excluindo os{' '}
                  {recipients.length.toLocaleString('pt-BR')} contatos já enviados.
                  Atinge apenas quem entrou no filtro depois do último envio.
                </p>
              </div>
            </div>
            <button
              onClick={handleNextBatch}
              className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 transition-colors"
            >
              Criar campanha
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Per-status segments */}
      {segments.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Users className="h-4 w-4 text-slate-400" />
            <h3 className="text-sm font-semibold text-white">
              Segmentos por status
            </h3>
            <span className="text-xs text-slate-500">
              — nova campanha para um grupo específico desta lista
            </span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {segments.map((seg) => (
              <div
                key={seg.key}
                className={`rounded-lg border p-3 ${seg.color}`}
              >
                <p className="text-sm font-medium">{seg.label}</p>
                <p className="mt-0.5 text-xs opacity-70">{seg.description}</p>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-lg font-bold tabular-nums">
                    {seg.contacts.length.toLocaleString('pt-BR')}
                  </span>
                  <button
                    onClick={() => handleRetarget(seg)}
                    className="flex items-center gap-1 rounded-md border border-current/20 bg-current/5 px-2 py-1 text-xs font-medium opacity-80 hover:opacity-100 transition-opacity"
                  >
                    Nova campanha
                    <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
