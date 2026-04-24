import { useState, useEffect } from "react";
import { HardDrive, Layers, Database, Loader2, RefreshCw } from "lucide-react";
import { api } from "../services/api";

interface Props {
  machineId: string;
}

function formatBytes(n: number | string): string {
  const b = typeof n === "string" ? parseInt(n, 10) : n;
  if (!b || b <= 0) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  return `${(b / 1024 ** 4).toFixed(2)} TB`;
}

export default function StorageTab({ machineId }: Props) {
  const [lvm, setLvm] = useState<{ pvs: any[]; vgs: any[]; lvs: any[]; available: boolean } | null>(null);
  const [blocks, setBlocks] = useState<any[]>([]);
  const [fsList, setFsList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [lvmRes, blkRes, fsRes] = await Promise.all([
        api.storageLvmList(machineId).catch(() => null),
        api.storageBlockDevices(machineId).catch(() => null),
        api.storageFilesystemUsage(machineId).catch(() => null),
      ]);
      setLvm(lvmRes?.data || null);
      setBlocks(blkRes?.data?.devices || []);
      setFsList(fsRes?.data?.filesystems || []);
    } catch (err: any) {
      setError(err?.message || "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [machineId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Rafraîchir
        </button>
      </div>

      {error && (
        <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          {error}
        </div>
      )}

      {/* Filesystem usage */}
      <Section icon={Database} title="Systèmes de fichiers">
        {fsList.length === 0 ? (
          <Empty label="Aucun système de fichiers monté" />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
            <table className="w-full text-xs">
              <thead style={{ background: "var(--nx-bg-elevated)" }}>
                <tr className="text-left" style={{ color: "var(--nx-text-weak)" }}>
                  <Th>Point de montage</Th>
                  <Th>Device</Th>
                  <Th>Type</Th>
                  <Th>Taille</Th>
                  <Th>Utilisé</Th>
                  <Th>Libre</Th>
                  <Th>%</Th>
                </tr>
              </thead>
              <tbody>
                {fsList.map((fs, i) => {
                  const pct = parseInt(fs.percent, 10) || 0;
                  const color = pct > 90 ? "var(--nx-danger)" : pct > 75 ? "var(--nx-warning)" : "var(--nx-success)";
                  return (
                    <tr key={i} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                      <Td className="font-mono">{fs.mountpoint}</Td>
                      <Td className="font-mono" style={{ color: "var(--nx-text-weak)" }}>{fs.device}</Td>
                      <Td>{fs.fstype}</Td>
                      <Td>{formatBytes(fs.size)}</Td>
                      <Td>{formatBytes(fs.used)}</Td>
                      <Td>{formatBytes(fs.available)}</Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold tabular-nums" style={{ color }}>{pct}%</span>
                          <div className="flex-1 h-1.5 rounded-full overflow-hidden max-w-24" style={{ background: "var(--nx-bg-base)" }}>
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                          </div>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Block devices */}
      <Section icon={HardDrive} title="Périphériques de bloc">
        {blocks.length === 0 ? (
          <Empty label="Aucun device détecté (lsblk indisponible)" />
        ) : (
          <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
            <BlockTree devices={blocks} />
          </div>
        )}
      </Section>

      {/* LVM */}
      <Section icon={Layers} title="LVM">
        {!lvm || !lvm.available ? (
          <Empty label="LVM non utilisé sur cette machine" />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <LvmCard title="Physical Volumes" count={lvm.pvs.length}>
              {lvm.pvs.map((p, i) => (
                <div key={i} className="flex justify-between gap-2 py-1 text-xs border-b last:border-0" style={{ borderColor: "var(--nx-border)" }}>
                  <span className="font-mono truncate">{p.pv_name}</span>
                  <span style={{ color: "var(--nx-text-weak)" }}>{formatBytes(p.pv_size)}</span>
                </div>
              ))}
            </LvmCard>
            <LvmCard title="Volume Groups" count={lvm.vgs.length}>
              {lvm.vgs.map((v, i) => (
                <div key={i} className="flex justify-between gap-2 py-1 text-xs border-b last:border-0" style={{ borderColor: "var(--nx-border)" }}>
                  <span className="font-mono truncate">{v.vg_name}</span>
                  <span style={{ color: "var(--nx-text-weak)" }}>{formatBytes(v.vg_size)} ({v.lv_count} LV)</span>
                </div>
              ))}
            </LvmCard>
            <LvmCard title="Logical Volumes" count={lvm.lvs.length}>
              {lvm.lvs.map((l, i) => (
                <div key={i} className="flex justify-between gap-2 py-1 text-xs border-b last:border-0" style={{ borderColor: "var(--nx-border)" }}>
                  <span className="font-mono truncate" title={l.lv_path}>{l.vg_name}/{l.lv_name}</span>
                  <span style={{ color: "var(--nx-text-weak)" }}>{formatBytes(l.lv_size)}</span>
                </div>
              ))}
            </LvmCard>
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4" style={{ color: "var(--nx-text-weak)" }} />
        <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--nx-text-weak)" }}>{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-border p-5 text-center text-xs" style={{ background: "var(--nx-bg-surface)", color: "var(--nx-text-weak)" }}>
      {label}
    </div>
  );
}

function LvmCard({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border p-4" style={{ background: "var(--nx-bg-surface)" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium">{title}</span>
        <span className="text-xs font-semibold tabular-nums" style={{ color: "var(--nx-text-weak)" }}>{count}</span>
      </div>
      <div className="space-y-0">{children}</div>
    </div>
  );
}

function BlockTree({ devices, depth = 0 }: { devices: any[]; depth?: number }) {
  return (
    <div>
      {devices.map((d, i) => (
        <div key={`${d.name}-${i}`}>
          <div
            className="flex items-center gap-3 px-4 py-2 border-t first:border-t-0 text-xs"
            style={{ borderColor: "var(--nx-border)", paddingLeft: `${16 + depth * 20}px` }}
          >
            <span className="font-mono font-medium">{d.name}</span>
            {d.type && <Badge>{d.type}</Badge>}
            {d.fstype && <Badge>{d.fstype}</Badge>}
            <span className="ml-auto font-mono tabular-nums" style={{ color: "var(--nx-text-weak)" }}>
              {formatBytes(d.size)}
            </span>
            {d.mountpoint && (
              <span className="font-mono" style={{ color: "var(--nx-info)" }}>
                → {d.mountpoint}
              </span>
            )}
          </div>
          {Array.isArray(d.children) && d.children.length > 0 && (
            <BlockTree devices={d.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded uppercase"
      style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}
    >
      {children}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium text-xs">{children}</th>;
}

function Td({ children, className = "", ...rest }: any) {
  return <td className={`px-3 py-2 ${className}`} {...rest}>{children}</td>;
}
