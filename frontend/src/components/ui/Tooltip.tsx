import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}

/**
 * Accessible tooltip based on Radix (already in deps).
 * Usage: <Tooltip content="Delete"><button>…</button></Tooltip>
 * The child is the trigger (asChild) → keeps a native accessible <button>.
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
