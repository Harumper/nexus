import { useState, useEffect, useCallback } from "react";
import { Tag as TagIcon, Plus, Trash2, Edit2 } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../services/api";
import { useAuth } from "../hooks/useAuth";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  Dialog,
  EmptyState,
  Input,
  Spinner,
  useConfirm,
} from "./ui";
import type { Tag } from "../types";
import { getErrorMessage } from "../services/errors";

const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#6b7280",
  "#14b8a6",
];

export default function TagsManagementCard() {
  const { t } = useTranslation(["settings", "common"]);
  const { user } = useAuth();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const { confirm, ConfirmDialogElement } = useConfirm();

  const fetchTags = useCallback(async () => {
    try {
      const data = await api.getTags();
      setTags(data);
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  const handleDelete = async (id: string) => {
    if (
      !(await confirm({
        title: t("tags.confirmDelete"),
        confirmLabel: t("common:actions.delete"),
        variant: "danger",
      }))
    )
      return;
    try {
      await api.deleteTag(id);
      toast.success(t("tags.toast.deleted"));
      fetchTags();
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
    }
  };

  return (
    <Card>
      <CardHeader>
        <TagIcon className="w-4 h-4 text-primary" />
        <CardTitle className="normal-case tracking-normal text-sm">
          {t("tags.count", { count: tags.length })}
        </CardTitle>
        {user?.role === "ADMIN" && (
          <div className="ml-auto">
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setShowCreate(true)}>
              {t("tags.create")}
            </Button>
          </div>
        )}
      </CardHeader>

      <p className="text-xs text-muted-foreground mb-4">
        <Trans i18nKey="tags.description" t={t} components={{ code: <code /> }} />
      </p>

      {loading ? (
        <div className="py-8 flex justify-center">
          <Spinner />
        </div>
      ) : tags.length === 0 ? (
        <EmptyState icon={TagIcon} title={t("tags.empty.title")} description={t("tags.empty.description")} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="rounded-lg border border-border bg-elevated p-3 flex items-center justify-between"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground truncate">
                    {tag.name}
                  </span>
                  <p className="text-[10px] text-muted-foreground">
                    {t("tags.machineCount", { count: tag._count?.machines ?? 0 })}
                  </p>
                </div>
              </div>
              {user?.role === "ADMIN" && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<Edit2 />}
                    onClick={() => setEditingTag(tag)}
                    aria-label={t("common:actions.edit")}
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<Trash2 />}
                    onClick={() => handleDelete(tag.id)}
                    aria-label={t("common:actions.delete")}
                    className="!text-muted-foreground hover:!text-destructive"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <TagDialog
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            fetchTags();
          }}
        />
      )}

      {editingTag && (
        <TagDialog
          tag={editingTag}
          onClose={() => setEditingTag(null)}
          onSaved={() => {
            setEditingTag(null);
            fetchTags();
          }}
        />
      )}
      {ConfirmDialogElement}
    </Card>
  );
}

function TagDialog({
  tag,
  onClose,
  onSaved,
}: {
  tag?: Tag;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color ?? PRESET_COLORS[0]);
  const [loading, setLoading] = useState(false);
  const isEdit = !!tag;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isEdit) {
        await api.updateTag(tag.id, { name, color });
        toast.success(t("tags.toast.updated"));
      } else {
        await api.createTag(name, color);
        toast.success(t("tags.toast.created"));
      }
      onSaved();
    } catch (err) {
      toast.error(getErrorMessage(err, t("common:errors.generic")));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={isEdit ? t("tags.editTitle") : t("tags.create")}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={loading}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!name}
            loading={loading}
          >
            {isEdit ? t("common:actions.edit") : t("common:actions.create")}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">{t("tags.nameLabel")}</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("tags.namePlaceholder")}
            required
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">{t("tags.colorLabel")}</label>
          <div className="flex gap-2 flex-wrap">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={t("tags.colorAria", { color: c })}
                className={`w-8 h-8 rounded-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  color === c
                    ? "ring-2 ring-primary ring-offset-2 ring-offset-card scale-110"
                    : "hover:scale-105"
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">{t("tags.previewLabel")}</label>
          <div
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
            style={{ backgroundColor: `${color}20`, color }}
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            {name || t("tags.previewPlaceholder")}
          </div>
        </div>
      </form>
    </Dialog>
  );
}
