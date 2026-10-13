import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-accent hover:bg-accent-hover text-accent-fg disabled:opacity-40",
  secondary:
    "bg-surface-2 hover:bg-surface-3 text-app-fg disabled:bg-surface-1",
  ghost:
    "bg-transparent hover:bg-surface-2 text-text-secondary hover:text-text-primary disabled:text-text-muted",
  danger:
    "bg-danger-bg text-danger-fg hover:opacity-80 disabled:opacity-50",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", size = "md", className, ...props },
    ref,
  ) {
    const classes = cn(
      "rounded disabled:cursor-not-allowed transition-colors",
      variantClasses[variant],
      sizeClasses[size],
      className,
    );

    return <button ref={ref} type="button" className={classes} {...props} />;
  },
);
