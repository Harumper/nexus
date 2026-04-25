import { type ComponentType, type ReactNode } from "react";
import { cn } from "../../lib/utils";

interface PageHeaderProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ icon: Icon, title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4 mb-6", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          {Icon && <Icon className="w-6 h-6 shrink-0" />}
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
