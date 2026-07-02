import { useState, useEffect, useCallback } from "react";
import {
  ScrollText, Loader2, RefreshCw, Download, Send, Eye, Power,
  CheckCircle2, XCircle, X, ArrowLeft, ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
import { useAuth } from "../hooks/useAuth";
import { useConfirm, Button, Input } from "./ui";
import type { LogShippingStatus } from "../types";

interface LogShippingTabProps {
  machineId: string;
}

// Small status pill: green check / red cross depending on `ok`.
function StatePill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? (
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
      ) : (
        <XCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      )}
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </div>
  );
}

export default function LogShippingTab({ machineId }: LogShippingTabProps) {
  const { t } = useTranslation(["logShipping", "common"]);
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const canDisable = user?.role === "ADMIN" || user?.role === "OPERATOR";
  const { confirm, ConfirmDialogElement } = useConfirm();

  const [status, setStatus] = useState<LogShippingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "install" | "configure" | "disable">(null);

  // Config form.
  const [host, setHost] = useState("");
  const [port, setPort] = useState("3100");
  const [tenant, setTenant] = useState("");
  const [tls, setTls] = useState(false);

  // Dry-run preview overlay.
  const [preview, setPreview] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.logShippingStatus(machineId);
      setStatus(res.data);
    } catch (err) {
      toast.error(getErrorMessage(err, t("errors.status")));
    } finally {
      setLoading(false);
    }
  }, [machineId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doInstall = async () => {
    setBusy("install");
    try {
      const res = await api.installLogShipper(machineId);
      if (res.data.already_installed) toast.info(t("install.already"));
      else toast.success(t("install.done"));
      await refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, t("errors.install")));
    } finally {
      setBusy(null);
    }
  };

  const validForm = () => {
    if (!host.trim()) {
      toast.error(t("errors.hostRequired"));
      return false;
    }
    if (!port.trim()) {
      toast.error(t("errors.portRequired"));
      return false;
    }
    return true;
  };

  const formParams = () => ({
    loki_host: host.trim(),
    loki_port: port.trim(),
    tls,
    tenant: tenant.trim() || undefined,
  });

  const doPreview = async () => {
    if (!validForm()) return;
    setBusy("configure");
    try {
      const res = await api.configureLogShipping(machineId, formParams(), true);
      setPreview(res.data.content || "");
    } catch (err) {
      toast.error(getErrorMessage(err, t("errors.preview")));
    } finally {
      setBusy(null);
    }
  };

  const doConfigure = async () => {
    if (!validForm()) return;
    if (
      !(await confirm({
        title: t("configure.confirmTitle"),
        description: t("configure.confirmDesc", { target: `${host.trim()}:${port.trim()}` }),
        confirmLabel: t("configure.apply"),
        variant: "danger",
      }))
    )
      return;
    setBusy("configure");
    try {
      const res = await api.configureLogShipping(machineId, formParams(), false);
      setPreview(null);
      toast.success(t("configure.done", { target: res.data.loki || `${host.trim()}:${port.trim()}` }));
      await refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, t("errors.configure")));
    } finally {
      setBusy(null);
    }
  };

  const doDisable = async () => {
    if (
      !(await confirm({
        title: t("disable.confirmTitle"),
        description: t("disable.confirmDesc"),
        confirmLabel: t("disable.button"),
        variant: "danger",
      }))
    )
      return;
    setBusy("disable");
    try {
      await api.disableLogShipping(machineId);
      toast.success(t("disable.done"));
      await refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, t("errors.disable")));
    } finally {
      setBusy(null);
    }
  };

  const installed = status?.installed ?? false;

  return (
    <div className="space-y-5">
      {ConfirmDialogElement}

      {/* Intro */}
      <div className="flex items-start gap-2">
        <ScrollText className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" />
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{t("subtitle")}</p>
        </div>
      </div>

      {/* Status card */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-semibold text-foreground">{t("status.title")}</h4>
          <Button variant="ghost" size="sm" onClick={refresh} loading={loading} icon={<RefreshCw />}>
            {t("status.refresh")}
          </Button>
        </div>
        {loading && !status ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t("common:status.loading")}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <StatePill ok={installed} label={installed ? t("status.installed") : t("status.notInstalled")} />
            <StatePill ok={status?.config_present ?? false} label={t("status.configPresent")} />
            <StatePill
              ok={status?.service_active ?? false}
              label={status?.service_active ? t("status.serviceActive") : t("status.serviceInactive")}
            />
            <StatePill
              ok={status?.health_ok ?? false}
              label={status?.health_ok ? t("status.healthOk") : t("status.healthKo")}
            />
          </div>
        )}
      </div>

      {/* ADMIN-only egress config. READONLY/OPERATOR see the notice instead. */}
      {!isAdmin ? (
        <div className="rounded-lg border border-border bg-elevated px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="w-4 h-4 shrink-0" /> {t("adminOnly")}
        </div>
      ) : (
        <>
          {/* Step 1 — install */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h4 className="text-xs font-semibold text-foreground mb-1">{t("install.title")}</h4>
            <p className="text-xs text-muted-foreground mb-3">{t("install.desc")}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={doInstall}
              loading={busy === "install"}
              disabled={installed || busy !== null}
              icon={<Download />}
            >
              {installed ? t("install.already") : t("install.button")}
            </Button>
          </div>

          {/* Step 2 — configure */}
          <div className="rounded-lg border border-border bg-card p-4">
            <h4 className="text-xs font-semibold text-foreground mb-3">{t("configure.title")}</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-muted-foreground mb-1">{t("configure.host")}</label>
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={t("configure.hostPlaceholder")}
                  className="font-mono"
                />
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground mb-1">{t("configure.port")}</label>
                <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="3100" className="font-mono" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <div className="sm:col-span-2">
                <label className="block text-[11px] text-muted-foreground mb-1">
                  {t("configure.tenant")}{" "}
                  <span className="text-muted-foreground/70">— {t("configure.tenantOptional")}</span>
                </label>
                <Input
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  placeholder=""
                  className="font-mono"
                />
              </div>
              <label className="flex items-center gap-2 text-xs text-foreground self-end pb-2 cursor-pointer">
                <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
                {t("configure.tls")}
              </label>
            </div>
            {!installed && <p className="text-[11px] text-amber-500 mb-2">{t("configure.needInstall")}</p>}
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={doPreview}
                loading={busy === "configure" && preview === null}
                disabled={busy !== null}
                icon={<Eye />}
              >
                {t("configure.preview")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={doConfigure}
                loading={busy === "configure"}
                disabled={!installed || busy !== null}
                icon={<Send />}
              >
                {t("configure.apply")}
              </Button>
            </div>
          </div>

          {/* Disable */}
          {canDisable && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h4 className="text-xs font-semibold text-foreground mb-1">{t("disable.title")}</h4>
              <p className="text-xs text-muted-foreground mb-3">{t("disable.desc")}</p>
              <Button
                variant="danger"
                size="sm"
                onClick={doDisable}
                loading={busy === "disable"}
                disabled={busy !== null}
                icon={<Power />}
              >
                {t("disable.button")}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Dry-run preview overlay (right drawer). */}
      {preview !== null && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setPreview(null)} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-y-0 right-0 z-50 w-full max-w-xl flex flex-col bg-card border-l border-border shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border shrink-0 bg-elevated">
              <h3 className="text-sm font-semibold text-foreground truncate">{t("preview.title")}</h3>
              <button
                onClick={() => setPreview(null)}
                aria-label={t("common:a11y.close")}
                className="inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-muted text-muted-foreground transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <p className="text-xs text-muted-foreground">{t("preview.desc")}</p>
              <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words rounded bg-black/90 text-emerald-200 p-2">
                {preview}
              </pre>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0 bg-elevated">
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)} icon={<ArrowLeft />}>
                {t("preview.close")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={doConfigure}
                loading={busy === "configure"}
                disabled={!installed || busy !== null}
                icon={<Send />}
              >
                {t("configure.apply")}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
