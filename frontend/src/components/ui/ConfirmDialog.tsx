import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: ReactNode;
  /**
   * Mot a taper pour confirmer une action critique (ex: "REBOOT", "DELETE").
   * Si fourni, l'utilisateur doit taper exactement ce mot pour activer le bouton.
   */
  confirmWord?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "primary";
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmWord,
  confirmLabel,
  cancelLabel,
  variant = "danger",
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canConfirm = confirmWord ? input === confirmWord : true;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      await onConfirm();
      setInput("");
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    if (submitting) return;
    setInput("");
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          {variant !== "primary" && (
            <AlertTriangle
              className={
                variant === "danger" ? "w-4 h-4 text-destructive" : "w-4 h-4 text-warning"
              }
            />
          )}
          {title}
        </span>
      }
      footer={
        <>
          <Button variant="outline" size="sm" onClick={handleClose} disabled={submitting}>
            {cancelLabel ?? t("actions.cancel")}
          </Button>
          <Button
            variant={variant}
            size="sm"
            onClick={handleConfirm}
            disabled={!canConfirm || submitting}
            loading={submitting}
          >
            {confirmLabel ?? t("actions.confirm")}
          </Button>
        </>
      }
    >
      {description && <div className="text-sm text-foreground mb-3">{description}</div>}
      {confirmWord && (
        <div className="mt-2">
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            <Trans
              i18nKey="confirmDialog.typeToConfirm"
              values={{ word: confirmWord }}
              components={{ code: <code className="font-mono text-foreground" /> }}
            />
          </label>
          <Input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
            className="font-mono"
          />
        </div>
      )}
    </Dialog>
  );
}
