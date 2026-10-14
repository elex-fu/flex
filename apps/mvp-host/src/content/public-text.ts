/** Streaming equivalent of replacing every complete private root with '.'. */
export function publicTextPart(text: string, roots: readonly string[], final: boolean): { text: string; pending: string } {
  const ordered = [...new Set(roots.filter((root) => root.length > 0))].sort((a, b) => b.length - a.length);
  const pieces: string[] = [];
  let position = 0;
  let runStart = 0;
  while (position < text.length) {
    const match = ordered.find((root) => text.startsWith(root, position));
    if (match) {
      pieces.push(text.slice(runStart, position), ".");
      position += match.length;
      runStart = position;
      continue;
    }
    const remaining = text.length - position;
    const unresolved = !final && ordered.some((root) => remaining < root.length && root.startsWith(text.slice(position)));
    const highSurrogate = !final && remaining === 1 && text.charCodeAt(position) >= 0xd800 && text.charCodeAt(position) <= 0xdbff;
    if (unresolved || highSurrogate) break;
    position += 1;
  }
  pieces.push(text.slice(runStart, position));
  return { text: pieces.join(""), pending: text.slice(position) };
}

/** Only the possible root prefix / Unicode tail is retained between appends. */
export class PublicTextStream {
  private pending = "";
  constructor(private readonly roots: readonly string[]) {}
  append(text: string, final = false): string {
    const part = publicTextPart(this.pending + text, this.roots, final);
    this.pending = part.pending;
    return part.text;
  }
}
