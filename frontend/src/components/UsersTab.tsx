import { useState, useEffect } from "react";
import { Users, UserPlus, Key, Trash2, Shield, Loader2, RefreshCw, X, ShieldCheck } from "lucide-react";
import { api } from "../services/api";

interface Props {
  machineId: string;
  canMutate: boolean;
}

interface LinuxUser {
  username: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  sudo: boolean;
  groups: string[];
}

export default function UsersTab({ machineId, canMutate }: Props) {
  const [users, setUsers] = useState<LinuxUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [selected, setSelected] = useState<LinuxUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listUsers(machineId);
      setUsers(res?.data?.users || []);
    } catch (err: any) {
      setError(err?.message || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [machineId]);

  const handleDelete = async (username: string) => {
    if (!confirm(`Supprimer l'utilisateur "${username}" ? Son home dir sera supprimé.`)) return;
    setActing(username);
    try {
      await api.deleteUser(machineId, username);
      await load();
    } catch (err: any) {
      alert("Erreur : " + (err?.message || "delete failed"));
    } finally {
      setActing(null);
    }
  };

  const handleToggleSudo = async (username: string, currentSudo: boolean) => {
    if (!confirm(`${currentSudo ? "Retirer" : "Ajouter"} les droits sudo à "${username}" ?`)) return;
    setActing(username);
    try {
      await api.updateUserSudo(machineId, username, !currentSudo);
      await load();
    } catch (err: any) {
      alert("Erreur : " + (err?.message || "update failed"));
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs" style={{ color: "var(--nx-text-weak)" }}>
          {users.length} utilisateur{users.length > 1 ? "s" : ""}
        </div>
        <div className="flex items-center gap-2">
          {canMutate && (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
              style={{ border: "1px solid var(--nx-success)", color: "var(--nx-success)" }}
            >
              <UserPlus className="w-3.5 h-3.5" />
              Créer utilisateur
            </button>
          )}
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
      </div>

      {error && (
        <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
          {error}
        </div>
      )}

      {users.length === 0 ? (
        <div className="rounded-xl border border-border p-8 text-center text-xs" style={{ background: "var(--nx-bg-surface)", color: "var(--nx-text-weak)" }}>
          Aucun utilisateur détecté
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden" style={{ background: "var(--nx-bg-surface)" }}>
          <table className="w-full text-xs">
            <thead style={{ background: "var(--nx-bg-elevated)" }}>
              <tr className="text-left" style={{ color: "var(--nx-text-weak)" }}>
                <Th>Username</Th>
                <Th>UID</Th>
                <Th>Nom complet</Th>
                <Th>Shell</Th>
                <Th>Groups</Th>
                <Th>Sudo</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username} className="border-t" style={{ borderColor: "var(--nx-border)" }}>
                  <Td className="font-mono font-semibold">{u.username}</Td>
                  <Td style={{ color: "var(--nx-text-weak)" }}>{u.uid}</Td>
                  <Td className="truncate max-w-xs">{u.gecos || "—"}</Td>
                  <Td className="font-mono" style={{ color: "var(--nx-text-weak)" }}>{u.shell}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {(u.groups || []).slice(0, 5).map((g) => (
                        <span key={g} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--nx-bg-elevated)", color: "var(--nx-text-weak)" }}>
                          {g}
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    {u.sudo ? (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded uppercase" style={{ background: "var(--nx-warning-subtle)", color: "var(--nx-warning)" }}>
                        <ShieldCheck className="w-3 h-3" /> sudo
                      </span>
                    ) : (
                      <span className="text-[10px]" style={{ color: "var(--nx-text-weak)" }}>—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setSelected(u)}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px]"
                        style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
                        title="Voir les clés SSH"
                      >
                        <Key className="w-3 h-3" /> Clés
                      </button>
                      {canMutate && u.username !== "root" && (
                        <>
                          <button
                            onClick={() => handleToggleSudo(u.username, u.sudo)}
                            disabled={acting === u.username}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px]"
                            style={{ border: `1px solid var(--nx-warning)`, color: "var(--nx-warning)" }}
                          >
                            {acting === u.username ? <Loader2 className="w-3 h-3 animate-spin" /> : <Shield className="w-3 h-3" />}
                            {u.sudo ? "-sudo" : "+sudo"}
                          </button>
                          <button
                            onClick={() => handleDelete(u.username)}
                            disabled={acting === u.username}
                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px]"
                            style={{ border: `1px solid var(--nx-danger)`, color: "var(--nx-danger)" }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <SshKeysDrawer
          machineId={machineId}
          user={selected}
          canMutate={canMutate}
          onClose={() => setSelected(null)}
        />
      )}

      {showCreate && canMutate && (
        <CreateUserDialog
          machineId={machineId}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </div>
  );
}

function SshKeysDrawer({ machineId, user, canMutate, onClose }: { machineId: string; user: LinuxUser; canMutate: boolean; onClose: () => void }) {
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.listSshKeys(machineId, user.username);
      setKeys(res?.data?.keys || []);
    } catch (err: any) {
      setError(err?.message || "");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [user.username]);

  const add = async () => {
    const k = newKey.trim();
    if (!k) return;
    setActing("add");
    setError("");
    try {
      await api.addSshKey(machineId, user.username, k);
      setNewKey("");
      await load();
    } catch (err: any) {
      setError(err?.message || "add failed");
    } finally {
      setActing(null);
    }
  };

  const remove = async (fingerprint: string) => {
    if (!confirm(`Supprimer la clé ${fingerprint} ?`)) return;
    setActing(fingerprint);
    try {
      await api.removeSshKey(machineId, user.username, fingerprint);
      await load();
    } catch (err: any) {
      alert("Erreur : " + (err?.message || "remove failed"));
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div className="w-full max-w-2xl h-full overflow-y-auto" style={{ background: "var(--nx-bg-surface)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--nx-border)" }}>
          <div>
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4" style={{ color: "var(--nx-info)" }} />
              <h2 className="text-sm font-semibold">Clés SSH — {user.username}</h2>
            </div>
            <p className="text-xs mt-1" style={{ color: "var(--nx-text-weak)" }}>
              {user.home}/.ssh/authorized_keys
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {canMutate && (
            <div className="space-y-2">
              <label className="block text-xs font-medium">Ajouter une clé publique</label>
              <textarea
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="ssh-ed25519 AAAAC3... user@host"
                rows={3}
                className="w-full rounded border border-input bg-background px-3 py-2 text-xs font-mono"
              />
              <button
                onClick={add}
                disabled={!newKey.trim() || acting === "add"}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
                style={{ border: "1px solid var(--nx-success)", color: "var(--nx-success)" }}
              >
                {acting === "add" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                Ajouter
              </button>
              {error && (
                <div className="text-xs" style={{ color: "var(--nx-danger)" }}>{error}</div>
              )}
            </div>
          )}

          {loading ? (
            <div className="text-center py-8 text-xs" style={{ color: "var(--nx-text-weak)" }}>
              <Loader2 className="w-4 h-4 animate-spin mx-auto" />
            </div>
          ) : keys.length === 0 ? (
            <div className="rounded-xl border border-border p-6 text-center text-xs" style={{ color: "var(--nx-text-weak)" }}>
              Aucune clé SSH pour {user.username}
            </div>
          ) : (
            <div className="space-y-2">
              {keys.map((k) => (
                <div
                  key={k.fingerprint}
                  className="rounded-lg border border-border p-3"
                  style={{ background: "var(--nx-bg-elevated)" }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded" style={{ background: "var(--nx-bg-surface)" }}>
                          {k.type}
                        </span>
                        {k.comment && (
                          <span className="text-xs font-mono truncate" style={{ color: "var(--nx-text-weak)" }}>
                            {k.comment}
                          </span>
                        )}
                      </div>
                      <code className="text-[10px] font-mono break-all" style={{ color: "var(--nx-text-weak)" }}>
                        {k.fingerprint}
                      </code>
                    </div>
                    {canMutate && (
                      <button
                        onClick={() => remove(k.fingerprint)}
                        disabled={acting === k.fingerprint}
                        className="shrink-0 p-1.5 rounded"
                        style={{ border: "1px solid var(--nx-danger)", color: "var(--nx-danger)" }}
                      >
                        {acting === k.fingerprint ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateUserDialog({ machineId, onClose, onCreated }: { machineId: string; onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [gecos, setGecos] = useState("");
  const [sudo, setSudo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      await api.createUser(machineId, username.trim(), { gecos: gecos.trim() || undefined, sudo });
      onCreated();
    } catch (err: any) {
      setError(err?.message || "create failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl" style={{ background: "var(--nx-bg-surface)", border: "1px solid var(--nx-border)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--nx-border)" }}>
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4" style={{ color: "var(--nx-success)" }} />
            <h2 className="text-sm font-semibold">Créer un utilisateur</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="jdupont"
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm font-mono"
              autoFocus
            />
            <p className="text-[10px] mt-1" style={{ color: "var(--nx-text-weak)" }}>
              Lettres minuscules, chiffres, _ et - (POSIX).
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Nom complet (optionnel)</label>
            <input
              value={gecos}
              onChange={(e) => setGecos(e.target.value)}
              placeholder="Jean Dupont"
              className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sudo}
              onChange={(e) => setSudo(e.target.checked)}
            />
            <span className="text-xs">Ajouter au groupe sudo</span>
          </label>
          {error && (
            <div className="rounded-lg px-3 py-2 text-xs" style={{ background: "var(--nx-danger-subtle)", color: "var(--nx-danger)" }}>
              {error}
            </div>
          )}
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-2" style={{ borderColor: "var(--nx-border)" }}>
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs font-medium"
            style={{ border: "1px solid var(--nx-border)", color: "var(--nx-text-weak)" }}
          >
            Annuler
          </button>
          <button
            onClick={submit}
            disabled={submitting || !username.trim()}
            className="rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            style={{ background: "var(--nx-success)", color: "var(--nx-bg-base)" }}
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" /> : null}
            Créer
          </button>
        </div>
      </div>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium text-xs">{children}</th>;
}

function Td({ children, className = "", ...rest }: any) {
  return <td className={`px-3 py-2 ${className}`} {...rest}>{children}</td>;
}
