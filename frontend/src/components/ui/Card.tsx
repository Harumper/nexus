import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type Padding = "none" | "sm" | "md" | "lg";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: Padding;
  elevated?: boolean;
}

const PAD: Record<Padding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4",
  lg: "p-5",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ padding = "lg", elevated, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-border",
        elevated ? "bg-elevated" : "bg-card",
        PAD[padding],
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center gap-2 mb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "text-xs font-semibold uppercase tracking-wider text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}
