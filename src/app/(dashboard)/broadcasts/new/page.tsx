'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { Check } from 'lucide-react';

const steps = [
  { label: 'Template', key: 'template' },
  { label: 'Audience', key: 'audience' },
  { label: 'Personalize', key: 'personalize' },
  { label: 'Send', key: 'send' },
] as const;

export default function NewBroadcastPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<{
    type: 'all' | 'tags' | 'custom_field' | 'csv';
    tagIds?: string[];
    customField?: {
      fieldId: string;
      operator: 'is' | 'is_not' | 'contains';
      value: string;
    };
    csvContacts?: { phone: string; name?: string }[];
    excludeTagIds?: string[];
  }>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [name, setName] = useState('');

  // Pre-fill audience from a retargeting redirect (broadcast detail page).
  // The retarget key is stored in sessionStorage by BroadcastRetargeting
  // and consumed exactly once here — removed immediately so a back-nav
  // doesn't re-apply the stale audience.
  //
  // Two shapes in sessionStorage:
  //   • { contacts, label }                         → CSV audience (per-status segments)
  //   • { type:'next_batch', audience_filter,        → resolve filter, subtract already-
  //       exclude_broadcast_id, label }                sent contacts, pass result as CSV
  useEffect(() => {
    const key = searchParams.get('retarget');
    if (!key) return;

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
      if (!raw) return;
      sessionStorage.removeItem(key);
    } catch {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (parsed.type === 'next_batch') {
      // Resolve the original audience filter minus already-sent contacts.
      void (async () => {
        try {
          const supabase = createClient();
          const filter = parsed.audience_filter as {
            type: 'all' | 'tags' | 'custom_field';
            tagIds?: string[];
            customField?: {
              fieldId: string;
              operator: 'is' | 'is_not' | 'contains';
              value: string;
            };
            excludeTagIds?: string[];
          } | null;
          const excludeBroadcastId = parsed.exclude_broadcast_id as string | undefined;

          if (!filter) return;

          // 1. Fetch contact_ids already in the source broadcast.
          const alreadySent = new Set<string>();
          if (excludeBroadcastId) {
            const { data: sent } = await supabase
              .from('broadcast_recipients')
              .select('contact_id')
              .eq('broadcast_id', excludeBroadcastId);
            for (const r of sent ?? []) {
              if (r.contact_id) alreadySent.add(r.contact_id);
            }
          }

          // 2. Resolve the filter to a contact list (mirrors resolveAudience
          //    in use-broadcast-sending.ts but only needs phone+name).
          let contactRows: { id: string; phone: string; name?: string | null }[] = [];
          if (filter.type === 'all') {
            const { data } = await supabase
              .from('contacts')
              .select('id, phone, name');
            contactRows = data ?? [];
          } else if (filter.type === 'tags' && filter.tagIds?.length) {
            const { data: ctRows } = await supabase
              .from('contact_tags')
              .select('contact_id')
              .in('tag_id', filter.tagIds);
            const ids = [...new Set((ctRows ?? []).map((r) => r.contact_id))];
            if (ids.length > 0) {
              const { data } = await supabase
                .from('contacts')
                .select('id, phone, name')
                .in('id', ids);
              contactRows = data ?? [];
            }
          } else if (filter.type === 'custom_field' && filter.customField) {
            const { fieldId, operator, value } = filter.customField;
            let q = supabase
              .from('contact_custom_values')
              .select('contact_id')
              .eq('custom_field_id', fieldId);
            if (operator === 'is') q = q.eq('value', value);
            else if (operator === 'is_not') q = q.neq('value', value);
            else q = q.ilike('value', `%${value}%`);
            const { data: matches } = await q;
            const ids = [...new Set((matches ?? []).map((m) => m.contact_id))];
            if (ids.length > 0) {
              const { data } = await supabase
                .from('contacts')
                .select('id, phone, name')
                .in('id', ids);
              contactRows = data ?? [];
            }
          }

          // 3. Apply excludeTagIds from the original filter.
          if (filter.excludeTagIds?.length) {
            const { data: excRows } = await supabase
              .from('contact_tags')
              .select('contact_id')
              .in('tag_id', filter.excludeTagIds);
            const excIds = new Set((excRows ?? []).map((r) => r.contact_id));
            contactRows = contactRows.filter((c) => !excIds.has(c.id));
          }

          // 4. Subtract already-sent contacts.
          const remaining = contactRows.filter((c) => !alreadySent.has(c.id));

          if (remaining.length === 0) {
            toast.info('Nenhum contato novo no filtro desde o último envio.');
            return;
          }

          setAudience({
            type: 'csv',
            csvContacts: remaining.map((c) => ({
              phone: c.phone,
              name: c.name ?? undefined,
            })),
          });
          setName((parsed.label as string | undefined) ?? '');
        } catch (err) {
          console.error('[retarget next_batch]', err);
          toast.error('Não foi possível carregar a audiência do lote anterior.');
        }
      })();
      return;
    }

    // Legacy shape: { contacts, label }
    try {
      const { contacts, label } = parsed as {
        contacts: { phone: string; name?: string }[];
        label: string;
      };
      if (Array.isArray(contacts) && contacts.length > 0) {
        setAudience({ type: 'csv', csvContacts: contacts });
        setName(label ?? '');
      }
    } catch {
      // Malformed — ignore.
    }
  }, [searchParams]);

  async function handleSend() {
    if (!template) return;

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts: audience.csvContacts,
          excludeTagIds: audience.excludeTagIds,
        },
        variables,
      });
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : 'Broadcast failed';
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error('Give the broadcast a name before saving a draft.');
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error('Not signed in.');
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(`Failed to save draft: ${error.message}`);
      return;
    }
    toast.success('Draft saved');
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">New Broadcast</h1>
        <p className="mt-1 text-sm text-slate-400">
          Create and send a broadcast message to your contacts.
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-slate-700 bg-slate-800 text-slate-500'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-white' : isCompleted ? 'text-primary' : 'text-slate-500'
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-slate-800'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={setTemplate}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              onSaveDraft={handleSaveDraft}
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
