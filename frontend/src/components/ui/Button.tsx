import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

type Variant = "primary" | "secondary" | "danger" | "warning" | "success" | "info" | "ghost" | "outline";
type Size = "xs" | "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50",
  secondary: "bg-secondary text-secondary-foreground hover:bg-accent disabled:opacity-50",
  danger: "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50",
  warning: "bg-warning text-background hover:bg-warning/90 disabled:opacity-50",
  success: "bg-success text-background hover:bg-success/90 disabled:opacity-50",
  info: "bg-info text-background hover:bg-info/90 disabled:opacity-50",
  ghost: "bg-transparent text-foreground hover:bg-muted disabled:opacity-50",
  outline:
    "bg-transparent text-foreground border border-border hover:bg-muted disabled:opacity-50",
};

const SIZE_CLASSES: Record<Size, string> = {
  xs: "text-[10px] px-2 py-1 gap-1 rounded",
  sm: "text-xs px-3 py-1.5 gap-1.5 rounded-md",
  md: "text-sm px-4 py-2 gap-2 rounded-lg",
  lg: "text-sm px-5 py-2.5 gap-2 rounded-lg",
};

const ICON_SIZE: Record<Size, string> = {
  xs: "w-3 h-3",
  sm: "w-3.5 h-3.5",
  md: "w-4 h-4",
  lg: "w-4 h-4",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading,
      icon,
      iconRight,
      fullWidth,
      className,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const iconCls = ICON_SIZE[size];
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed",
          VARIANT_CLASSES[variant],
          SIZE_CLASSES[size],
          fullWidth && "w-full",
          className
        )}
        {...props}
      >
        {loading ? (
          <Loader2 className={cn(iconCls, "animate-spin")} />
        ) : icon ? (
          <span className={iconCls}>{icon}</span>
        ) : null}
        {children}
        {iconRight && !loading && <span className={iconCls}>{iconRight}</span>}
      </button>
    );
  }
);
Button.displayName = "Button";
