import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}

/**
 * Tooltip accessible basé sur Radix (déjà dans les deps).
 * Usage : <Tooltip content="Supprimer"><button>…</button></Tooltip>
 * Le child est le trigger (asChild) → garde un <button> natif accessible.
 */
export function Tooltip({ content, children, side = "bottom" }: TooltipProps) {
  if (content == null || content === "") return <>{children}</>;
  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className="z-[60] rounded-md px-2.5 py-1.5 text-xs shadow-lg select-none data-[state=delayed-open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:fade-in-0 motion-reduce:animate-none"
            style={{
              background: "var(--nx-bg-elevated)",
              color: "var(--nx-text)",
              border: "1px solid var(--nx-border)",
              maxWidth: 280,
            }}
          >
            {content}
            <TooltipPrimitive.Arrow style={{ fill: "var(--nx-bg-elevated)" }} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
