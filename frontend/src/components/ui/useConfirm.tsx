import { useState, useCallback, useRef, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "primary";
  /** Mot a taper pour confirmer (ex: REBOOT). Force la friction. */
  confirmWord?: string;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: (ok: boolean) => void;
}

/**
 * Hook pour remplacer window.confirm() natif par une UI Nexus coherente.
 *
 * Usage :
 *   const { confirm, ConfirmDialogElement } = useConfirm();
 *   const handleDelete = async () => {
 *     if (!(await confirm({ title: "Supprimer ?", variant: "danger" }))) return;
 *     // ... action ...
 *   };
 *   return <>...<ConfirmDialogElement /></>;
 */
export function useConfirm() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setState({ ...opts, open: true, resolve });
    });
  }, []);

  const close = (ok: boolean) => {
    if (resolverRef.current) {
      resolverRef.current(ok);
      resolverRef.current = null;
    }
    setState(null);
  };

  const ConfirmDialogElement = (
    <ConfirmDialog
      open={!!state?.open}
      onClose={() => close(false)}
      onConfirm={() => close(true)}
      title={state?.title || ""}
      description={state?.description}
      confirmLabel={state?.confirmLabel}
      cancelLabel={state?.cancelLabel}
      confirmWord={state?.confirmWord}
      variant={state?.variant}
    />
  );

  return { confirm, ConfirmDialogElement };
}
