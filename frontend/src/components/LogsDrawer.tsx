import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { formatTime } from "../lib/format";
import { RefreshCw, Search, Copy, WrapText, ArrowDownToLine, Check } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { Drawer, Button, Spinner } from "./ui";
import { getErrorMessage } from "../services/errors";

interface LogsDrawerProps {
  machineId: string;
  service: string;
  onClose: () => void;
}

/* ─────────────────────────────────────────────────────────────
   Parsing journal — format syslog/journald :
   "2026-04-01T00:51:42+02:00 hostname proc[pid]: message"
   et marqueurs "-- Boot <uuid> --".
   ───────────────────────────────────────────────────────────── */

type Severity = "danger" | "warning" | "info" | "default";

interface ParsedLine {
  kind: "log" | "boot" | "raw";
  ts?: Date;
  timeStr?: string;
  dateStr?: string;
  host?: string;
  proc?: string;
  pid?: string;
  message: string;
  severity: Severity;
  raw: string;
}

const BOOT_RE = /^--\s*Boot\s+([0-9a-fA-F-]+)\s*--$/;
const LINE_RE = /^(\S+)\s+(\S+)\s+([^:[]+?)(?:\[(\d+)\])?:\s*(.*)$/;
const DANGER_RE = /(fatal|FAILURE|Failed|failure|error|panic|abort|critical|emergency|segfault|denied|refused)/i;
const WARN_RE = /\b(warn(?:ing)?|deprecat(?:ed|ion)|timeout)\b/i;
const INFO_RE = /\b(Started|Starting|Stopped|Stopping|Listening|Reloaded|Reloading|Activating)\b/;

function detectSeverity(msg: string): Severity {
  if (DANGER_RE.test(msg)) return "danger";
  if (WARN_RE.test(msg)) return "warning";
  if (INFO_RE.test(msg)) return "info";
  return "default";
}

function parseLine(line: string): ParsedLine {
  const trimmed = line.replace(/\r$/, "");
  const bm = trimmed.match(BOOT_RE);
  if (bm) {
    return { kind: "boot", message: bm[1], severity: "default", raw: line };
  }
  const m = trimmed.match(LINE_RE);
  if (!m) {
    return { kind: "raw", message: trimmed, severity: detectSeverity(trimmed), raw: line };
  }
  const [, tsRaw, host, procRaw, pidRaw, msgRaw] = m;
  const ts = new Date(tsRaw);
  const valid = !isNaN(ts.getTime());
  return {
    kind: "log",
    ts: valid ? ts : undefined,
    timeStr: valid ? formatTime(ts, { hour12: false }) : tsRaw,
    dateStr: valid ? ts.toISOString().slice(0, 10) : undefined,
    host,
    proc: procRaw.trim(),
    pid: pidRaw,
    message: msgRaw,
    severity: detectSeverity(msgRaw),
    raw: line,
  };
}

/* Palette stable par process — pour distinguer "systemd" de "configure-instance.sh"
   etc. d'un coup d'œil. systemd[1] est très commun → on le passe en muted. */
const PROC_PALETTE = [
  "var(--nx-info)",
  "var(--nx-success)",
  "#a78bfa",
  "#f472b6",
  "#fb923c",
  "#22d3ee",
];
function procColor(name?: string): string {
  if (!name) return "var(--nx-text-weak)";
  if (name === "systemd") return "var(--nx-text-weak)";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PROC_PALETTE[Math.abs(h) % PROC_PALETTE.length];
}

function severityColor(sev: Severity): string {
  switch (sev) {
    case "danger": return "var(--nx-danger)";
    case "warning": return "var(--nx-warning)";
    case "info": return "var(--nx-text)";
    default: return "var(--nx-text)";
  }
}

/* Mise en évidence du mot-clé déclencheur dans le message — utile pour scanner
   visuellement la cause d'un échec sans relire ligne par ligne. */
function highlightKeyword(msg: string, sev: Severity): React.ReactNode {
  const re = sev === "danger" ? DANGER_RE : sev === "warning" ? WARN_RE : null;
  if (!re) return msg;
  const m = msg.match(re);
  if (!m || m.index === undefined) return msg;
  const before = msg.slice(0, m.index);
  const hit = msg.slice(m.index, m.index + m[0].length);
  const after = msg.slice(m.index + m[0].length);
  const bg = sev === "danger" ? "rgba(239,68,68,0.18)" : "rgba(245,158,11,0.18)";
  return (
    <>
      {before}
      <span style={{ background: bg, padding: "0 2px", borderRadius: 2, fontWeight: 600 }}>{hit}</span>
      {after}
    </>
  );
}

export default function LogsDrawer({ machineId, service, onClose }: LogsDrawerProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lineCount, setLineCount] = useState(100);
  const [since, setSince] = useState<string>("");
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation(["logsDrawer", "common"]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.getServiceLogs(machineId, service, lineCount, since || undefined);
      setLines(res?.data?.lines || []);
      setTruncated(res?.data?.truncated || false);
    } catch (err) {
      setError(getErrorMessage(err, t("loadError")));
    } finally {
      setLoading(false);
    }
  }, [machineId, service, lineCount, since]);

  useEffect(() => { load(); }, [load]);

  // Auto-scroll en bas après chargement — comportement attendu pour des logs :
  // on veut voir le plus récent, pas le plus ancien.
  useEffect(() => {
    if (!loading && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [loading, lines]);

  const parsed = useMemo(() => lines.map(parseLine), [lines]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return parsed.filter((p) => {
      if (onlyErrors && p.severity !== "danger" && p.severity !== "warning" && p.kind !== "boot") return false;
      if (q && !p.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [parsed, query, onlyErrors]);

  const counts = useMemo(() => {
    let errors = 0, warnings = 0;
    for (const p of parsed) {
      if (p.severity === "danger") errors++;
      else if (p.severity === "warning") warnings++;
    }
    return { errors, warnings };
  }, [parsed]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(filtered.map((p) => p.raw).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t("copyError"));
    }
  };

  const scrollToBottom = () => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  };

  return (
    <Drawer
      open
      onClose={onClose}
      className="!max-w-5xl"
      title={
        <span>
          <Trans i18nKey="title" t={t} values={{ service }} components={[<span key="0" className="font-mono text-xs" />]} />
        </span>
      }
      description={
        <span>
          {t("lineCount", { count: parsed.length, filtered: filtered.length, total: parsed.length })}
          {truncated && t("truncatedSuffix")}
          {counts.errors > 0 && (
            <span className="ml-2" style={{ color: "var(--nx-danger)" }}>{t("errorsSuffix", { count: counts.errors })}</span>
          )}
          {counts.warnings > 0 && (
            <span className="ml-2" style={{ color: "var(--nx-warning)" }}>{t("warningsSuffix", { count: counts.warnings })}</span>
          )}
        </span>
      }
    >
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <div className="flex items-center gap-2 p-3 border-b border-border bg-card flex-wrap">
          <select
            value={lineCount}
            onChange={(e) => setLineCount(Number(e.target.value))}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value={100}>{t("linesOption", { count: 100 })}</option>
            <option value={500}>{t("linesOption", { count: 500 })}</option>
            <option value={1000}>{t("linesOption", { count: 1000 })}</option>
          </select>
          <select
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">{t("since.all")}</option>
            <option value="5m">{t("since.5m")}</option>
            <option value="1h">{t("since.1h")}</option>
            <option value="1d">{t("since.1d")}</option>
            <option value="today">{t("since.today")}</option>
          </select>

          <div className="relative flex-1 min-w-[180px]">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: "var(--nx-text-weak)" }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("filterPlaceholder")}
              className="w-full rounded-md border border-input bg-background pl-7 pr-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <button
            onClick={() => setOnlyErrors((v) => !v)}
            className="text-[11px] px-2 py-1 rounded-md border transition-colors"
            style={{
              borderColor: onlyErrors ? "var(--nx-danger)" : "var(--nx-border)",
              background: onlyErrors ? "var(--nx-danger-subtle)" : "transparent",
              color: onlyErrors ? "var(--nx-danger)" : "var(--nx-text-weak)",
            }}
            title={t("onlyErrorsTitle")}
          >
            {t("onlyErrors")}
          </button>

          <button
            onClick={() => setWrap((w) => !w)}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            style={{ color: wrap ? "var(--nx-info)" : "var(--nx-text-weak)" }}
            title={wrap ? t("wrapOff") : t("wrapOn")}
            aria-label={t("wrapAria")}
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={copyAll}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            style={{ color: copied ? "var(--nx-success)" : "var(--nx-text-weak)" }}
            title={t("copyTitle")}
            aria-label={t("common:actions.copy")}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={scrollToBottom}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            style={{ color: "var(--nx-text-weak)" }}
            title={t("scrollBottom")}
            aria-label={t("scrollAria")}
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={load}
            loading={loading}
            icon={<RefreshCw />}
            aria-label={t("common:actions.refresh")}
          />
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          className="flex-1 overflow-auto font-mono text-[11px] leading-[1.55]"
          style={{ background: "var(--nx-bg-elevated)" }}
        >
          {error ? (
            <div className="p-4 text-destructive">{error}</div>
          ) : loading ? (
            <div className="p-4 flex items-center gap-2" style={{ color: "var(--nx-text-weak)" }}>
              <Spinner size="sm" /> {t("loading")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-4" style={{ color: "var(--nx-text-weak)" }}>
              {parsed.length === 0 ? t("noLogs") : t("noMatch")}
            </div>
          ) : (
            <div className="py-1">
              {filtered.map((p, i) => (
                <LogRow key={i} line={p} prev={i > 0 ? filtered[i - 1] : undefined} wrap={wrap} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

function LogRow({ line, prev, wrap }: { line: ParsedLine; prev?: ParsedLine; wrap: boolean }) {
  if (line.kind === "boot") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 my-1" style={{ borderTop: "1px dashed var(--nx-border)", borderBottom: "1px dashed var(--nx-border)" }}>
        <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--nx-text-weak)" }}>
          ── Reboot ──
        </span>
        <span className="font-mono text-[10px] truncate" style={{ color: "var(--nx-text-weak)" }}>
          {line.message}
        </span>
      </div>
    );
  }

  // Indicateur visuel : barre de couleur en marge gauche (uniquement si non default).
  // Plus discret qu'un fond complet, mais permet de scanner la colonne d'un œil.
  const accentColor =
    line.severity === "danger" ? "var(--nx-danger)" :
    line.severity === "warning" ? "var(--nx-warning)" :
    "transparent";

  // Séparateur de date — affiché quand on passe à un nouveau jour, sinon le HH:mm:ss
  // suffit. Évite de répéter la date sur 1000 lignes du même jour.
  const newDay = line.dateStr && (!prev || prev.dateStr !== line.dateStr);

  return (
    <>
      {newDay && (
        <div className="px-3 py-1 text-[10px] font-semibold tracking-wider" style={{ color: "var(--nx-text-weak)", background: "var(--nx-bg-surface)" }}>
          {line.dateStr}
        </div>
      )}
      <div
        className="grid gap-x-3 px-3 py-0.5 hover:bg-muted/30"
        style={{
          gridTemplateColumns: "auto 180px 1fr",
          borderLeft: `2px solid ${accentColor}`,
          paddingLeft: "calc(0.75rem - 2px)",
        }}
        title={line.ts ? line.ts.toISOString() : undefined}
      >
        <span className="tabular-nums" style={{ color: "var(--nx-text-weak)" }}>
          {line.timeStr ?? ""}
        </span>
        <span className="truncate" style={{ color: procColor(line.proc) }}>
          {line.proc ?? ""}{line.pid ? `[${line.pid}]` : ""}
        </span>
        <span
          style={{
            color: severityColor(line.severity),
            whiteSpace: wrap ? "pre-wrap" : "pre",
            overflow: wrap ? "visible" : "hidden",
            textOverflow: wrap ? "clip" : "ellipsis",
            wordBreak: wrap ? "break-word" : "normal",
          }}
        >
          {highlightKeyword(line.message, line.severity)}
        </span>
      </div>
    </>
  );
}
