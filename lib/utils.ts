import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind 类合并（避免冲突） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
