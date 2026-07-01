import { useState, useCallback, useRef, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning" | "primary";
  /** Word to type to confirm (e.g. REBOOT). Adds friction. */
  confirmWord?: string;
}

interface ConfirmState extends ConfirmOptions {
  open: boolean;
  resolve: (ok: boolean) => void;
}

/**
 * Hook to replace the native window.confirm() with a coherent Nexus UI.
 *
 * Usage:
 *   const { confirm, ConfirmDialogElement } = useConfirm();
 *   const handleDelete = async () => {
 *     if (!(await confirm({ title: "Delete?", variant: "danger" }))) return;
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
