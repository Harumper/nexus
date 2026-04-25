import { useState } from "react";
import { Plus, Trash2, MessageSquare, Hash, Send, Mail, Webhook as WebhookIcon } from "lucide-react";

export type ChannelType = "DISCORD" | "SLACK" | "TEAMS" | "EMAIL" | "WEBHOOK";

export interface NotificationChannel {
  type: ChannelType;
  config: Record<string, any>;
}

interface Props {
  value: NotificationChannel[];
  onChange: (channels: NotificationChannel[]) => void;
}

const CHANNEL_META: Record<ChannelType, { label: string; icon: typeof MessageSquare; color: string }> = {
  DISCORD: { label: "Discord", icon: MessageSquare, color: "#5865F2" },
  SLACK: { label: "Slack", icon: Hash, color: "#4A154B" },
  TEAMS: { label: "Microsoft Teams", icon: Send, color: "#6264A7" },
  EMAIL: { label: "Email", icon: Mail, color: "var(--nx-info)" },
  WEBHOOK: { label: "Webhook custom", icon: WebhookIcon, color: "var(--nx-text-weak)" },
};

export default function AlertChannelEditor({ value, onChange }: Props) {
  const [adding, setAdding] = useState(false);

  const addChannel = (type: ChannelType) => {
    const newChannel: NotificationChannel = {
      type,
      config: type === "EMAIL" ? { recipients: [] } : {},
    };
    onChange([...value, newChannel]);
    setAdding(false);
  };

  const updateChannel = (idx: number, config: Record<string, any>) => {
    const next = [...value];
    next[idx] = { ...next[idx], config };
    onChange(next);
  };

  const removeChannel = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <div className="rounded-lg p-3 text-xs text-center" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}>
          Aucun canal configuré. Ajoutez Discord, Slack, Teams, Email ou Webhook.
        </div>
      )}

      {value.map((channel, idx) => (
        <ChannelRow
          key={idx}
          channel={channel}
          onChange={(config) => updateChannel(idx, config)}
          onRemove={() => removeChannel(idx)}
        />
      ))}

      {adding ? (
        <div className="rounded-lg border border-dashed border-border p-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
          {(Object.keys(CHANNEL_META) as ChannelType[]).map((type) => {
            const meta = CHANNEL_META[type];
            const Icon = meta.icon;
            return (
              <button
                key={type}
                type="button"
                onClick={() => addChannel(type)}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
                style={{ border: `1px solid ${meta.color}`, color: meta.color }}
              >
                <Icon className="w-3.5 h-3.5" />
                {meta.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="inline-flex items-center justify-center rounded-lg px-3 py-2 text-xs font-medium col-span-2 sm:col-span-5"
            style={{ color: "var(--nx-text-weak)" }}
          >
            Annuler
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium border border-dashed border-border hover:bg-muted transition-colors"
          style={{ color: "var(--nx-text-weak)" }}
        >
          <Plus className="w-3.5 h-3.5" /> Ajouter un canal
        </button>
      )}
    </div>
  );
}

function ChannelRow({
  channel,
  onChange,
  onRemove,
}: {
  channel: NotificationChannel;
  onChange: (config: Record<string, any>) => void;
  onRemove: () => void;
}) {
  const meta = CHANNEL_META[channel.type];
  const Icon = meta.icon;

  return (
    <div className="rounded-lg border border-border p-3" style={{ background: "var(--nx-bg-elevated)" }}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: meta.color }}>
          <Icon className="w-3.5 h-3.5" />
          {meta.label}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="p-1 rounded hover:bg-muted"
          title="Supprimer ce canal"
        >
          <Trash2 className="w-3 h-3" style={{ color: "var(--nx-danger)" }} />
        </button>
      </div>

      {(channel.type === "DISCORD" || channel.type === "SLACK" || channel.type === "TEAMS") && (
        <input
          type="text"
          value={channel.config.webhookUrl || ""}
          onChange={(e) => onChange({ ...channel.config, webhookUrl: e.target.value })}
          placeholder={
            channel.type === "DISCORD"
              ? "https://discord.com/api/webhooks/..."
              : channel.type === "SLACK"
              ? "https://hooks.slack.com/services/..."
              : "https://outlook.office.com/webhook/..."
          }
          className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs font-mono"
        />
      )}

      {channel.type === "EMAIL" && (
        <EmailRecipients
          value={channel.config.recipients || []}
          onChange={(recipients) => onChange({ ...channel.config, recipients })}
        />
      )}

      {channel.type === "WEBHOOK" && (
        <div className="space-y-2">
          <input
            type="text"
            value={channel.config.url || ""}
            onChange={(e) => onChange({ ...channel.config, url: e.target.value })}
            placeholder="https://example.com/webhook"
            className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs font-mono"
          />
          <input
            type="password"
            value={channel.config.hmacSecret || ""}
            onChange={(e) => onChange({ ...channel.config, hmacSecret: e.target.value })}
            placeholder="HMAC secret (optionnel — utilise le secret global si vide)"
            className="w-full rounded border border-input bg-background px-2 py-1.5 text-xs font-mono"
          />
          <p className="text-[10px]" style={{ color: "var(--nx-text-weak)" }}>
            Header <code>X-Nexus-Signature: sha256=...</code> calculé sur le body JSON.
          </p>
        </div>
      )}
    </div>
  );
}

function EmailRecipients({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");

  const add = () => {
    const email = input.trim();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (value.includes(email)) {
      setInput("");
      return;
    }
    onChange([...value, email]);
    setInput("");
  };

  const remove = (e: string) => onChange(value.filter((x) => x !== e));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]"
            style={{ background: "var(--nx-info-subtle)", color: "var(--nx-info)" }}
          >
            {email}
            <button type="button" onClick={() => remove(email)} className="hover:opacity-70">
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="email"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="ops@example.com"
          className="flex-1 rounded border border-input bg-background px-2 py-1.5 text-xs"
        />
        <button
          type="button"
          onClick={add}
          className="rounded px-3 py-1 text-xs font-medium"
          style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
        >
          Ajouter
        </button>
      </div>
    </div>
  );
}
