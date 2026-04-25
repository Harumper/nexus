import { type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type Tone = "default" | "primary" | "success" | "warning" | "danger" | "info";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  uppercase?: boolean;
}

const TONE_CLASSES: Record<Tone, string> = {
  default: "bg-elevated text-muted-foreground",
  primary: "bg-primary-subtle text-primary",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  info: "bg-info-subtle text-info",
};

export function Badge({ tone = "default", uppercase, className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold",
        uppercase && "uppercase tracking-wider",
        TONE_CLASSES[tone],
        className
      )}
      {...props}
    />
  );
}
