// cx — tiny classnames joiner.
//
// No dependency, no precedence magic: it filters falsy values and
// joins. Order matters (later wins via normal CSS cascade only when
// specificity is equal), so callers should place override classes
// last. Kept deliberately minimal — the design system leans on
// composing whole utility strings rather than conditional fragments.

export type ClassValue = string | false | null | undefined;

export function cx(...values: ReadonlyArray<ClassValue>): string {
  let out = "";
  for (const v of values) {
    if (!v) continue;
    out = out.length === 0 ? v : `${out} ${v}`;
  }
  return out;
}
