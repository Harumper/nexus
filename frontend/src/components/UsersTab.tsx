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
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { getErrorMessage } from "../services/errors";
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
  // Gestion des accès persistants (clés SSH / sudo). Désactivé par défaut côté
  // backend et réservé ADMIN. Le backend reste l'autorité — ceci masque juste
  // les contrôles qui échoueraient.
  canManagePrivileges: boolean;
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

export default function UsersTab({
  machineId,
  canManagePrivileges,
}: Props) {
  const { t } = useTranslation(["users", "common"]);
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
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.loadError")));
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
      toast.success(t("toasts.deleted", { user: username }));
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.deleteError")));
    } finally {
      setActing(null);
    }
  };

  const handleToggleSudo = async (username: string, currentSudo: boolean) => {
    setActing(username);
    try {
      await api.updateUserSudo(machineId, username, !currentSudo);
      toast.success(
        currentSudo ? t("toasts.sudoRemoved", { user: username }) : t("toasts.sudoAdded", { user: username })
      );
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {t("count", { count: users.length })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCreate(true)}
            icon={<UserPlus />}
            className="!border-success !text-success hover:!bg-success-subtle"
          >
            {t("createButton")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            loading={loading}
            icon={<RefreshCw />}
          >
            {t("common:actions.refresh")}
          </Button>
        </div>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={Users} title={t("empty")} />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden bg-card">
          <table className="w-full text-xs">
            <thead className="bg-elevated">
              <tr className="text-left text-muted-foreground">
                <Th>{t("headers.username")}</Th>
                <Th>{t("headers.uid")}</Th>
                <Th>{t("headers.fullName")}</Th>
                <Th>{t("headers.shell")}</Th>
                <Th>{t("headers.groups")}</Th>
                <Th>{t("headers.sudo")}</Th>
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
                        title={t("viewKeys")}
                      >
                        {t("keysButton")}
                      </Button>
                      {canManagePrivileges && u.username !== "root" && (
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
                      )}
                      {u.username !== "root" && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setPendingDelete(u.username)}
                          disabled={acting === u.username}
                          icon={<Trash2 />}
                          aria-label={t("deleteAria", { user: u.username })}
                          className="!border-destructive !text-destructive hover:!bg-danger-subtle"
                        />
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
          canMutate={canManagePrivileges}
          onClose={() => setSelected(null)}
        />
      )}

      {showCreate && (
        <CreateUserDialog
          machineId={machineId}
          canManagePrivileges={canManagePrivileges}
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
        title={t("confirmDeleteTitle")}
        description={
          pendingDelete && (
            <Trans
              i18nKey="confirmDeleteDesc"
              t={t}
              values={{ name: pendingDelete }}
              components={[<strong key="0" />, <code key="1" />]}
            />
          )
        }
        confirmLabel={t("common:actions.delete")}
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
  const { t } = useTranslation(["users", "common"]);
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
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
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
      toast.success(t("toasts.keyAdded"));
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.addError")));
    } finally {
      setActing(null);
    }
  };

  const performRemove = async (fingerprint: string) => {
    setActing(fingerprint);
    try {
      await api.removeSshKey(machineId, user.username, fingerprint);
      toast.success(t("toasts.keyRemoved"));
      await load();
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.deleteError")));
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
            <Key className="w-4 h-4 text-info" /> {t("keysDrawer.title", { user: user.username })}
          </span>
        }
        description={`${user.home}/.ssh/authorized_keys`}
      >
        <div className="p-6 space-y-4">
          {canMutate && (
            <div className="space-y-2">
              <label className="block text-xs font-medium">{t("keysDrawer.addLabel")}</label>
              <Textarea
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={t("keysDrawer.keyPlaceholder")}
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
                {t("common:actions.add")}
              </Button>
            </div>
          )}

          {loading ? (
            <div className="text-center py-8">
              <Spinner size="sm" />
            </div>
          ) : keys.length === 0 ? (
            <EmptyState icon={Key} title={t("keysDrawer.noKeys", { user: user.username })} />
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
                        aria-label={t("keysDrawer.removeKeyAria")}
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
        title={t("confirmRemoveKeyTitle")}
        description={t("confirmRemoveKeyDesc")}
        confirmLabel={t("common:actions.delete")}
        variant="danger"
      />
    </>
  );
}

function CreateUserDialog({
  machineId,
  canManagePrivileges,
  onClose,
  onCreated,
}: {
  machineId: string;
  canManagePrivileges: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation(["users", "common"]);
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
      toast.success(t("toasts.created", { user: username.trim() }));
      onCreated();
    } catch (err) {
      toast.error(getErrorMessage(err, t("toasts.createError")));
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
          <Users className="w-4 h-4 text-success" /> {t("create.title")}
        </span>
      }
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="success"
            size="sm"
            onClick={submit}
            disabled={!username.trim()}
            loading={submitting}
          >
            {t("common:actions.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">{t("create.usernameLabel")}</label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("create.usernamePlaceholder")}
            className="font-mono"
            autoFocus
          />
          <p className="text-[10px] mt-1 text-muted-foreground">
            {t("create.usernameHint")}
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">{t("create.fullNameLabel")}</label>
          <Input
            value={gecos}
            onChange={(e) => setGecos(e.target.value)}
            placeholder={t("create.fullNamePlaceholder")}
          />
        </div>
        {canManagePrivileges && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sudo}
              onChange={(e) => setSudo(e.target.checked)}
              className="accent-primary"
            />
            <span className="text-xs">{t("create.addToSudo")}</span>
          </label>
        )}
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
