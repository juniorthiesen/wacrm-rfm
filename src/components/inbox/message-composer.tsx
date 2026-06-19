"use client";

import { useState, useRef, useCallback, KeyboardEvent } from "react";
import {
  Send,
  LayoutTemplate,
  Paperclip,
  ImageIcon,
  FileText,
  Music,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ReplyQuote } from "./reply-quote";
import { AiSuggestButton } from "./ai-suggest-button";
import { useTranslation } from "@/hooks/use-translation";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type WaMediaType = "image" | "audio" | "video" | "document";

interface PendingMedia {
  file: File;
  objectUrl: string;
  mediaType: WaMediaType;
}

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface MessageComposerProps {
  conversationId: string;
  sessionExpired: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia: (file: File, caption?: string) => Promise<void>;
  onOpenTemplates: () => void;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  lastInboundText?: string | null;
  contactId?: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mimeToWaMediaType(mime: string): WaMediaType {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

export function MessageComposer({
  conversationId: _conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  onOpenTemplates,
  replyTo,
  onClearReply,
  lastInboundText,
  contactId,
}: MessageComposerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<PendingMedia | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const clearPendingMedia = useCallback(() => {
    setPendingMedia((prev) => {
      if (prev) URL.revokeObjectURL(prev.objectUrl);
      return null;
    });
  }, []);

  const handleFileSelected = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const objectUrl = URL.createObjectURL(file);
      const mediaType = mimeToWaMediaType(file.type);
      setPendingMedia({ file, objectUrl, mediaType });
      setAttachOpen(false);
      e.target.value = "";
      // Focus caption input after selection
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [],
  );

  const handleSend = useCallback(async () => {
    if (sending || sessionExpired) return;

    if (pendingMedia) {
      setSending(true);
      try {
        await onSendMedia(pendingMedia.file, text.trim() || undefined);
        clearPendingMedia();
        setText("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      } finally {
        setSending(false);
      }
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      onSend(trimmed, replyTo?.id);
      setText("");
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } finally {
      setSending(false);
    }
  }, [
    text,
    sending,
    sessionExpired,
    pendingMedia,
    onSend,
    onSendMedia,
    clearPendingMedia,
    replyTo?.id,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight],
  );

  const canSend = !sessionExpired && !sending && (pendingMedia !== null || text.trim().length > 0);

  return (
    <div className="border-t border-slate-800 bg-slate-900 p-3">
      {replyTo && (
        <div className="mb-2">
          <ReplyQuote
            authorLabel={replyTo.authorLabel}
            preview={replyTo.preview}
            onDismiss={onClearReply}
          />
        </div>
      )}

      {/* Media preview strip */}
      {pendingMedia && (
        <div className="mb-2 flex items-center gap-3 rounded-xl border border-slate-700 bg-slate-800 p-2">
          {pendingMedia.mediaType === "image" ? (
            <img
              src={pendingMedia.objectUrl}
              alt="preview"
              className="h-12 w-12 rounded-lg object-cover"
            />
          ) : pendingMedia.mediaType === "video" ? (
            <video
              src={pendingMedia.objectUrl}
              className="h-12 w-12 rounded-lg object-cover"
            />
          ) : pendingMedia.mediaType === "audio" ? (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-700">
              <Music className="h-5 w-5 text-primary" />
            </div>
          ) : (
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-slate-700">
              <FileText className="h-5 w-5 text-blue-400" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-slate-200">
              {pendingMedia.file.name}
            </p>
            <p className="text-[10px] text-slate-500">
              {formatBytes(pendingMedia.file.size)}
            </p>
          </div>
          <button
            type="button"
            onClick={clearPendingMedia}
            className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-slate-700 hover:text-white"
            title="Remover"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {sessionExpired && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-amber-500/10 px-3 py-2">
          <p className="text-xs text-amber-400">
            {t("inbox.sessionExpiredWarning")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-amber-400 hover:text-amber-300"
            onClick={onOpenTemplates}
          >
            <LayoutTemplate className="mr-1 h-3 w-3" />
            {t("inbox.templatesButton")}
          </Button>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Template button */}
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-9 shrink-0 p-0 text-slate-400 hover:text-white"
          onClick={onOpenTemplates}
          title={t("inbox.sendTemplateTooltip")}
        >
          <LayoutTemplate className="h-4 w-4" />
        </Button>

        {/* Attach button */}
        <Popover open={attachOpen} onOpenChange={setAttachOpen}>
          <PopoverTrigger
            className={cn(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-50",
              pendingMedia && "text-primary",
            )}
            title="Anexar arquivo"
            disabled={sessionExpired}
          >
            <Paperclip className="h-4 w-4" />
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="w-44 border-slate-700 bg-slate-800 p-1"
          >
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
              onClick={() => imageInputRef.current?.click()}
            >
              <ImageIcon className="h-4 w-4 text-emerald-400" />
              Imagem / Vídeo
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
              onClick={() => documentInputRef.current?.click()}
            >
              <FileText className="h-4 w-4 text-blue-400" />
              Documento
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-700"
              onClick={() => audioInputRef.current?.click()}
            >
              <Music className="h-4 w-4 text-purple-400" />
              Áudio
            </button>
          </PopoverContent>
        </Popover>

        {/* Hidden file inputs */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp"
          className="hidden"
          onChange={handleFileSelected}
        />
        <input
          ref={documentInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain"
          className="hidden"
          onChange={handleFileSelected}
        />
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/aac,audio/mp4,audio/mpeg,audio/amr,audio/ogg,.ogg,.mp3,.m4a,.aac,.amr"
          className="hidden"
          onChange={handleFileSelected}
        />

        <AiSuggestButton
          lastInboundText={lastInboundText ?? null}
          contactId={contactId ?? null}
          disabled={sessionExpired}
          onAccept={(suggestion) => {
            setText(suggestion);
            requestAnimationFrame(adjustHeight);
            textareaRef.current?.focus();
          }}
          onAppend={(suggestion) => {
            setText((prev) => (prev ? `${prev}\n${suggestion}` : suggestion));
            requestAnimationFrame(adjustHeight);
            textareaRef.current?.focus();
          }}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            sessionExpired
              ? t("inbox.sessionExpiredPlaceholder")
              : pendingMedia
                ? "Adicionar legenda (opcional)…"
                : t("inbox.typeMessagePlaceholder")
          }
          disabled={sessionExpired}
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-colors focus:border-primary/50",
            sessionExpired && "cursor-not-allowed opacity-50",
          )}
        />

        <Button
          size="sm"
          className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
          disabled={!canSend}
          onClick={handleSend}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      <p className="mt-1 pl-[4.5rem] text-[10px] text-slate-600">
        {t("inbox.quickRepliesHint")}
      </p>
    </div>
  );
}
