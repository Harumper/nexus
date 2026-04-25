import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";

type Size = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<Size, string> = {
  sm: "w-4 h-4",
  md: "w-6 h-6",
  lg: "w-8 h-8",
};

export function Spinner({ size = "md", className }: { size?: Size; className?: string }) {
  return (
    <Loader2
      className={cn("animate-spin text-muted-foreground", SIZE_CLASSES[size], className)}
      aria-label="Chargement"
    />
  );
}

export function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Spinner size="lg" className="text-primary" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded bg-muted motion-reduce:animate-none",
        className
      )}
    />
  );
}
