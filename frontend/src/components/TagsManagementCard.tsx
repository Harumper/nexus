import { useState, useEffect, useCallback } from "react";
import { Tag as TagIcon, Plus, Trash2, Edit2 } from "lucide-react";
import { toast } from "sonner";
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
    } catch (err: any) {
      toast.error(err?.message || "Erreur");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  const handleDelete = async (id: string) => {
    if (
      !(await confirm({
        title: "Supprimer ce tag ?",
        confirmLabel: "Supprimer",
        variant: "danger",
      }))
    )
      return;
    try {
      await api.deleteTag(id);
      toast.success("Tag supprimé");
      fetchTags();
    } catch (err: any) {
      toast.error(err?.message || "Erreur");
    }
  };

  return (
    <Card>
      <CardHeader>
        <TagIcon className="w-4 h-4 text-primary" />
        <CardTitle className="normal-case tracking-normal text-sm">
          Tags ({tags.length})
        </CardTitle>
        {user?.role === "ADMIN" && (
          <div className="ml-auto">
            <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setShowCreate(true)}>
              Créer un tag
            </Button>
          </div>
        )}
      </CardHeader>

      <p className="text-xs text-muted-foreground mb-4">
        Étiquettes colorisées pour catégoriser vos machines (ex: <code>production</code>,{" "}
        <code>web</code>, <code>db</code>). Visibles sur les cartes de machines, utilisables
        comme filtres dans les groupes dynamiques.
      </p>

      {loading ? (
        <div className="py-8 flex justify-center">
          <Spinner />
        </div>
      ) : tags.length === 0 ? (
        <EmptyState icon={TagIcon} title="Aucun tag créé" description="Créez votre premier tag pour catégoriser vos machines." />
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
                    {tag._count?.machines ?? 0} machine{(tag._count?.machines ?? 0) > 1 ? "s" : ""}
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
                    aria-label="Modifier"
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    icon={<Trash2 />}
                    onClick={() => handleDelete(tag.id)}
                    aria-label="Supprimer"
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
        toast.success("Tag modifié");
      } else {
        await api.createTag(name, color);
        toast.success("Tag créé");
      }
      onSaved();
    } catch (err: any) {
      toast.error(err?.message || "Erreur");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={isEdit ? "Modifier le tag" : "Créer un tag"}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={loading}>
            Annuler
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!name}
            loading={loading}
          >
            {isEdit ? "Modifier" : "Créer"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Nom</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="production, staging…"
            required
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Couleur</label>
          <div className="flex gap-2 flex-wrap">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Couleur ${c}`}
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
          <label className="block text-sm font-medium text-foreground mb-1.5">Aperçu</label>
          <div
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
            style={{ backgroundColor: `${color}20`, color }}
          >
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
            {name || "tag"}
          </div>
        </div>
      </form>
    </Dialog>
  );
}
