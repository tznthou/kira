/** Join class-name fragments, dropping falsy values. */
export function cn(...args: (string | false | null | undefined)[]): string {
  return args.filter(Boolean).join(" ");
}
