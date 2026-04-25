import { useState, useEffect } from "react";
import {
  Users,
  UserPlus,
  Key,
  Trash2,
  Shield,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../services/api";
import {
  Button,
  Dialog,
  Drawer,
  ConfirmDialog,
  EmptyState,
  Input,
  Textarea,
  Spinner,
  Badge,
} from "./ui";

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
  const [acting, setActing] = useState<string | null>(null);
  const [selected, setSelected] = useState<LinuxUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.listUsers(machineId);
      setUsers(res?.data?.users || []);
    } catch (err: any) {
      toast.error(err?.message || "Erreur de chargement");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    /* eslint-disable-next-line */
  }, [machineId]);

  const performDelete = async (username: string) => {
    setActing(username);
    try {
      await api.deleteUser(machineId, username);
      toast.success(`Utilisateur "${username}" supprimé`);
      await load();
    } catch (err: any) {
      toast.error(err?.message || "Suppression échouée");
    } finally {
      setActing(null);
    }
  };

  const handleToggleSudo = async (username: string, currentSudo: boolean) => {
    setActing(username);
    try {
      await api.updateUserSudo(machineId, username, !currentSudo);
      toast.success(
        currentSudo ? `Sudo retiré à ${username}` : `Sudo ajouté à ${username}`
      );
      await load();
    } catch (err: any) {
      toast.error(err?.message || "Erreur");
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {users.length} utilisateur{users.length > 1 ? "s" : ""}
        </div>
        <div className="flex items-center gap-2">
          {canMutate && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCreate(true)}
              icon={<UserPlus />}
              className="!border-success !text-success hover:!bg-success-subtle"
            >
              Créer utilisateur
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            loading={loading}
            icon={<RefreshCw />}
          >
            Rafraîchir
          </Button>
        </div>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={Users} title="Aucun utilisateur détecté" />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden bg-card">
          <table className="w-full text-xs">
            <thead className="bg-elevated">
              <tr className="text-left text-muted-foreground">
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
                <tr key={u.username} className="border-t border-border">
                  <Td className="font-mono font-semibold">{u.username}</Td>
                  <Td className="text-muted-foreground">{u.uid}</Td>
                  <Td className="truncate max-w-xs">{u.gecos || "—"}</Td>
                  <Td className="font-mono text-muted-foreground">{u.shell}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {(u.groups || []).slice(0, 5).map((g) => (
                        <span
                          key={g}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-elevated text-muted-foreground"
                        >
                          {g}
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td>
                    {u.sudo ? (
                      <Badge tone="warning" uppercase>
                        <ShieldCheck className="w-3 h-3" /> sudo
                      </Badge>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex gap-1">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setSelected(u)}
                        icon={<Key />}
                        title="Voir les clés SSH"
                      >
                        Clés
                      </Button>
                      {canMutate && u.username !== "root" && (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => handleToggleSudo(u.username, u.sudo)}
                            loading={acting === u.username}
                            icon={<Shield />}
                            className="!border-warning !text-warning hover:!bg-warning-subtle"
                          >
                            {u.sudo ? "-sudo" : "+sudo"}
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setPendingDelete(u.username)}
                            disabled={acting === u.username}
                            icon={<Trash2 />}
                            aria-label={`Supprimer ${u.username}`}
                            className="!border-destructive !text-destructive hover:!bg-danger-subtle"
                          />
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
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await performDelete(pendingDelete);
        }}
        title="Supprimer cet utilisateur ?"
        description={
          pendingDelete && (
            <>
              L'utilisateur <strong>{pendingDelete}</strong> sera supprimé avec son home
              directory (<code>userdel -r</code>). Cette action est irréversible.
            </>
          )
        }
        confirmLabel="Supprimer"
        variant="danger"
      />
    </div>
  );
}

function SshKeysDrawer({
  machineId,
  user,
  canMutate,
  onClose,
}: {
  machineId: string;
  user: LinuxUser;
  canMutate: boolean;
  onClose: () => void;
}) {
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [acting, setActing] = useState<string | null>(null);
  const [pendingFp, setPendingFp] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.listSshKeys(machineId, user.username);
      setKeys(res?.data?.keys || []);
    } catch (err: any) {
      toast.error(err?.message || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    /* eslint-disable-next-line */
  }, [user.username]);

  const add = async () => {
    const k = newKey.trim();
    if (!k) return;
    setActing("add");
    try {
      await api.addSshKey(machineId, user.username, k);
      setNewKey("");
      toast.success("Clé SSH ajoutée");
      await load();
    } catch (err: any) {
      toast.error(err?.message || "Ajout échoué");
    } finally {
      setActing(null);
    }
  };

  const performRemove = async (fingerprint: string) => {
    setActing(fingerprint);
    try {
      await api.removeSshKey(machineId, user.username, fingerprint);
      toast.success("Clé SSH supprimée");
      await load();
    } catch (err: any) {
      toast.error(err?.message || "Suppression échouée");
    } finally {
      setActing(null);
    }
  };

  return (
    <>
      <Drawer
        open
        onClose={onClose}
        title={
          <span className="flex items-center gap-2">
            <Key className="w-4 h-4 text-info" /> Clés SSH — {user.username}
          </span>
        }
        description={`${user.home}/.ssh/authorized_keys`}
      >
        <div className="p-6 space-y-4">
          {canMutate && (
            <div className="space-y-2">
              <label className="block text-xs font-medium">Ajouter une clé publique</label>
              <Textarea
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="ssh-ed25519 AAAAC3... user@host"
                rows={3}
                className="text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={add}
                disabled={!newKey.trim()}
                loading={acting === "add"}
                icon={<UserPlus />}
                className="!border-success !text-success hover:!bg-success-subtle"
              >
                Ajouter
              </Button>
            </div>
          )}

          {loading ? (
            <div className="text-center py-8">
              <Spinner size="sm" />
            </div>
          ) : keys.length === 0 ? (
            <EmptyState icon={Key} title={`Aucune clé SSH pour ${user.username}`} />
          ) : (
            <div className="space-y-2">
              {keys.map((k) => (
                <div
                  key={k.fingerprint}
                  className="rounded-lg border border-border p-3 bg-elevated"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-card">
                          {k.type}
                        </span>
                        {k.comment && (
                          <span className="text-xs font-mono truncate text-muted-foreground">
                            {k.comment}
                          </span>
                        )}
                      </div>
                      <code className="text-[10px] font-mono break-all text-muted-foreground">
                        {k.fingerprint}
                      </code>
                    </div>
                    {canMutate && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setPendingFp(k.fingerprint)}
                        loading={acting === k.fingerprint}
                        icon={<Trash2 />}
                        aria-label="Supprimer la clé"
                        className="!border-destructive !text-destructive hover:!bg-danger-subtle"
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Drawer>

      <ConfirmDialog
        open={!!pendingFp}
        onClose={() => setPendingFp(null)}
        onConfirm={async () => {
          if (pendingFp) await performRemove(pendingFp);
        }}
        title="Supprimer cette clé SSH ?"
        description="L'utilisateur ne pourra plus se connecter avec cette clé."
        confirmLabel="Supprimer"
        variant="danger"
      />
    </>
  );
}

function CreateUserDialog({
  machineId,
  onClose,
  onCreated,
}: {
  machineId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState("");
  const [gecos, setGecos] = useState("");
  const [sudo, setSudo] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      await api.createUser(machineId, username.trim(), {
        gecos: gecos.trim() || undefined,
        sudo,
      });
      toast.success(`Utilisateur "${username.trim()}" créé`);
      onCreated();
    } catch (err: any) {
      toast.error(err?.message || "Création échouée");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Users className="w-4 h-4 text-success" /> Créer un utilisateur
        </span>
      }
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Annuler
          </Button>
          <Button
            variant="success"
            size="sm"
            onClick={submit}
            disabled={!username.trim()}
            loading={submitting}
          >
            Créer
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">Username</label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="jdupont"
            className="font-mono"
            autoFocus
          />
          <p className="text-[10px] mt-1 text-muted-foreground">
            Lettres minuscules, chiffres, _ et - (POSIX).
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Nom complet (optionnel)</label>
          <Input
            value={gecos}
            onChange={(e) => setGecos(e.target.value)}
            placeholder="Jean Dupont"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={sudo}
            onChange={(e) => setSudo(e.target.checked)}
            className="accent-primary"
          />
          <span className="text-xs">Ajouter au groupe sudo</span>
        </label>
      </div>
    </Dialog>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium text-xs">{children}</th>;
}

function Td({ children, className = "", ...rest }: any) {
  return (
    <td className={`px-3 py-2 ${className}`} {...rest}>
      {children}
    </td>
  );
}
