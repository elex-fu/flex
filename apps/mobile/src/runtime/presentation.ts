export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const object = value as Record<string, unknown>;
  for (const key of ["text", "output", "message", "prompt", "summary", "reason", "title", "commandPreview"]) if (typeof object[key] === "string") return object[key] as string;
  return "";
}
