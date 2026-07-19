import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merges conditional Tailwind class names using shadcn's standard utility pattern. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
