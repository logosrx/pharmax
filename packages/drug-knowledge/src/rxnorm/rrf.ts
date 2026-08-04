// Parsing the RxNorm "Current Prescribable Content" RRF files into the
// two maps screening needs: NDC → product concept, and product concept
// → active ingredients.
//
// CLEAN ROOM. The file FORMAT and the relationship vocabulary are
// public NLM documentation (RxNorm Technical Documentation,
// https://www.nlm.nih.gov/research/umls/rxnorm/docs/techdoc.html); the
// Prescribable Content subset is a public U.S. government artifact
// explicitly free of the UMLS source-vocabulary restrictions that
// encumber the full release. What comes out of this module is
// NOMENCLATURE — what a product is made of — never interaction facts,
// cross-sensitivity groupings or dose ranges, which are licensed
// editorial content this repository must not hold.
//
// PURE. This module never touches the filesystem or the database: it
// consumes lines and returns a value, so the whole mapping chain is
// unit-testable against small synthetic fixtures (fake RXCUIs, fake
// NDCs) without a 500MB release on disk.
//
// ---------------------------------------------------------------------
// The mapping chain, and how direction ambiguity is avoided
// ---------------------------------------------------------------------
//
// The chain the adapter needs is NDC → product RXCUI → ingredient
// RXCUIs (TTY `IN`, plus `PIN` where the release asserts a precise
// ingredient). In the RxNorm graph that runs:
//
//   NDC        —(RXNSAT, ATN=NDC)—        SCD | SBD | GPCK | BPCK
//   SCD        —(consists_of family)—     SCDC
//   SCDC       —(has_ingredient family)—  IN
//   SCDC       —(has_precise_ingredient)— PIN
//   SBD        —(tradename_of family)—    SCD
//   GPCK/BPCK  —(contains family)—        SCD | SBD
//
// RXNREL rows carry a direction (which end is RXCUI1 vs RXCUI2), and
// the UMLS convention for which way REL/RELA reads is famously easy to
// invert. This module does not depend on it: RxNorm publishes every
// relationship in BOTH directions with inverse RELA names, so each row
// is treated as an UNDIRECTED edge and the ends are oriented by their
// term type (TTY) from RXNCONSO — an edge in the ingredient family
// with an SCDC on one end and an IN on the other can only mean one
// thing, whichever column each sat in.

/** Term types that carry an NDC and decompose into ingredients. */
export const RXNORM_PRODUCT_TTYS = Object.freeze(["SCD", "SBD", "GPCK", "BPCK"] as const);

/** Term types the adapter emits as ingredient codes. */
export const RXNORM_INGREDIENT_TTYS = Object.freeze(["IN", "PIN"] as const);

export interface RxnormIngredient {
  readonly rxcui: string;
  /** "IN" or "PIN". */
  readonly tty: string;
  readonly name: string;
}

export interface RxnormReleaseModel {
  /** Normalized-as-published 11-digit NDC → product RXCUI. */
  readonly ndcToProduct: ReadonlyMap<string, string>;
  /** Product RXCUI → its active ingredients (deduplicated, sorted). */
  readonly productIngredients: ReadonlyMap<string, ReadonlyArray<RxnormIngredient>>;
  /**
   * NDCs dropped because their product resolved to ZERO ingredients.
   * Loading them would let `describeDrug` answer "this drug has no
   * ingredients", which screens clear — the one lie the knowledge
   * seam's contract explicitly forbids. Counted so the ingestion
   * summary can say how much of the release was unusable rather than
   * silently shrinking it.
   */
  readonly ndcsWithoutIngredients: number;
}

// RRF column positions, per the public RxNorm Technical Documentation.
// RRF is pipe-delimited with a trailing pipe; positions are 0-based.
const CONSO_RXCUI = 0;
const CONSO_SAB = 11;
const CONSO_TTY = 12;
const CONSO_STR = 14;
const CONSO_SUPPRESS = 16;

const REL_RXCUI1 = 0;
const REL_RXCUI2 = 4;
const REL_RELA = 7;
const REL_SAB = 10;

const SAT_RXCUI = 0;
const SAT_ATN = 8;
const SAT_SAB = 9;
const SAT_ATV = 10;

/**
 * The relationship families, undirected. Each set names both RELA
 * spellings NLM publishes for the pair, so the builder accepts a row
 * in either direction without interpreting UMLS direction semantics.
 */
const COMPONENT_RELAS = new Set(["consists_of", "constitutes"]);
const INGREDIENT_RELAS = new Set(["has_ingredient", "ingredient_of"]);
const PRECISE_INGREDIENT_RELAS = new Set(["has_precise_ingredient", "precise_ingredient_of"]);
const TRADENAME_RELAS = new Set(["tradename_of", "has_tradename"]);
const CONTAINS_RELAS = new Set(["contains", "contained_in"]);

interface RelEdge {
  readonly a: string;
  readonly b: string;
  readonly family: "COMPONENT" | "INGREDIENT" | "PRECISE_INGREDIENT" | "TRADENAME" | "CONTAINS";
}

function familyOf(rela: string): RelEdge["family"] | null {
  if (COMPONENT_RELAS.has(rela)) return "COMPONENT";
  if (INGREDIENT_RELAS.has(rela)) return "INGREDIENT";
  if (PRECISE_INGREDIENT_RELAS.has(rela)) return "PRECISE_INGREDIENT";
  if (TRADENAME_RELAS.has(rela)) return "TRADENAME";
  if (CONTAINS_RELAS.has(rela)) return "CONTAINS";
  return null;
}

function splitRrfLine(line: string): ReadonlyArray<string> {
  return line.split("|");
}

function addToMultiMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, new Set([value]));
  } else {
    existing.add(value);
  }
}

/**
 * Incremental builder, so the caller can stream each file line by line
 * (a full release does not need to be in memory as text — only the
 * index maps do).
 *
 * Feed every RXNCONSO line BEFORE calling `build()`; the order the
 * three files are fed in does not otherwise matter, because edges are
 * oriented by TTY only at build time.
 */
export class RxnormReleaseModelBuilder {
  private readonly ttyByRxcui = new Map<string, string>();
  private readonly nameByRxcui = new Map<string, string>();
  private readonly edges: RelEdge[] = [];
  private readonly ndcToProduct = new Map<string, string>();

  addConsoLine(line: string): void {
    if (line.length === 0) return;
    const f = splitRrfLine(line);
    const sab = f[CONSO_SAB];
    if (sab !== "RXNORM") return;
    if (f[CONSO_SUPPRESS] === "Y") return;
    const rxcui = f[CONSO_RXCUI];
    const tty = f[CONSO_TTY];
    const name = f[CONSO_STR];
    if (rxcui === undefined || rxcui.length === 0 || tty === undefined) return;
    this.ttyByRxcui.set(rxcui, tty);
    if (name !== undefined && !this.nameByRxcui.has(rxcui)) {
      this.nameByRxcui.set(rxcui, name);
    }
  }

  addRelLine(line: string): void {
    if (line.length === 0) return;
    const f = splitRrfLine(line);
    if (f[REL_SAB] !== "RXNORM") return;
    const rela = f[REL_RELA];
    if (rela === undefined) return;
    const family = familyOf(rela);
    if (family === null) return;
    const a = f[REL_RXCUI1];
    const b = f[REL_RXCUI2];
    if (a === undefined || b === undefined || a.length === 0 || b.length === 0) return;
    this.edges.push({ a, b, family });
  }

  addSatLine(line: string): void {
    if (line.length === 0) return;
    const f = splitRrfLine(line);
    if (f[SAT_ATN] !== "NDC" || f[SAT_SAB] !== "RXNORM") return;
    const rxcui = f[SAT_RXCUI];
    const ndc = f[SAT_ATV];
    if (rxcui === undefined || ndc === undefined || ndc.length === 0) return;
    this.ndcToProduct.set(ndc, rxcui);
  }

  build(): RxnormReleaseModel {
    const tty = (rxcui: string): string | undefined => this.ttyByRxcui.get(rxcui);
    const isProduct = (rxcui: string): boolean =>
      (RXNORM_PRODUCT_TTYS as ReadonlyArray<string>).includes(tty(rxcui) ?? "");

    // Orient every edge by the TTY of its ends. An edge whose ends do
    // not match its family's expected shape is skipped — a release
    // asserting something this chain does not model is not a reason to
    // guess.
    const componentsOfDrug = new Map<string, Set<string>>(); // SCD/SBD → SCDC/SBDC
    const ingredientsOfComponent = new Map<string, Set<string>>(); // SCDC/SBDC → IN
    const preciseIngredientsOfComponent = new Map<string, Set<string>>(); // SCDC/SBDC → PIN
    const genericOfBrand = new Map<string, Set<string>>(); // SBD → SCD
    const packContents = new Map<string, Set<string>>(); // GPCK/BPCK → SCD/SBD

    for (const edge of this.edges) {
      const ttyA = tty(edge.a);
      const ttyB = tty(edge.b);
      if (ttyA === undefined || ttyB === undefined) continue;

      switch (edge.family) {
        case "COMPONENT": {
          const drug =
            ttyA === "SCD" || ttyA === "SBD"
              ? edge.a
              : ttyB === "SCD" || ttyB === "SBD"
                ? edge.b
                : null;
          const component =
            ttyA === "SCDC" || ttyA === "SBDC"
              ? edge.a
              : ttyB === "SCDC" || ttyB === "SBDC"
                ? edge.b
                : null;
          if (drug !== null && component !== null) addToMultiMap(componentsOfDrug, drug, component);
          break;
        }
        case "INGREDIENT": {
          const component =
            ttyA === "SCDC" || ttyA === "SBDC"
              ? edge.a
              : ttyB === "SCDC" || ttyB === "SBDC"
                ? edge.b
                : null;
          const ingredient = ttyA === "IN" ? edge.a : ttyB === "IN" ? edge.b : null;
          if (component !== null && ingredient !== null) {
            addToMultiMap(ingredientsOfComponent, component, ingredient);
          }
          break;
        }
        case "PRECISE_INGREDIENT": {
          const component =
            ttyA === "SCDC" || ttyA === "SBDC"
              ? edge.a
              : ttyB === "SCDC" || ttyB === "SBDC"
                ? edge.b
                : null;
          const precise = ttyA === "PIN" ? edge.a : ttyB === "PIN" ? edge.b : null;
          if (component !== null && precise !== null) {
            addToMultiMap(preciseIngredientsOfComponent, component, precise);
          }
          break;
        }
        case "TRADENAME": {
          const brand = ttyA === "SBD" ? edge.a : ttyB === "SBD" ? edge.b : null;
          const generic = ttyA === "SCD" ? edge.a : ttyB === "SCD" ? edge.b : null;
          if (brand !== null && generic !== null) addToMultiMap(genericOfBrand, brand, generic);
          break;
        }
        case "CONTAINS": {
          const pack =
            ttyA === "GPCK" || ttyA === "BPCK"
              ? edge.a
              : ttyB === "GPCK" || ttyB === "BPCK"
                ? edge.b
                : null;
          const contained =
            ttyA === "SCD" || ttyA === "SBD"
              ? edge.a
              : ttyB === "SCD" || ttyB === "SBD"
                ? edge.b
                : null;
          if (pack !== null && contained !== null) addToMultiMap(packContents, pack, contained);
          break;
        }
        default: {
          const exhaustive: never = edge.family;
          return exhaustive;
        }
      }
    }

    const ingredientsOfDrug = (drug: string): Map<string, RxnormIngredient> => {
      const out = new Map<string, RxnormIngredient>();
      for (const component of componentsOfDrug.get(drug) ?? []) {
        for (const set of [
          ingredientsOfComponent.get(component),
          preciseIngredientsOfComponent.get(component),
        ]) {
          for (const rxcui of set ?? []) {
            out.set(rxcui, {
              rxcui,
              tty: tty(rxcui) ?? "IN",
              name: this.nameByRxcui.get(rxcui) ?? "",
            });
          }
        }
      }
      return out;
    };

    const resolveProduct = (rxcui: string): Map<string, RxnormIngredient> => {
      const productTty = tty(rxcui);
      switch (productTty) {
        case "SCD":
          return ingredientsOfDrug(rxcui);
        case "SBD": {
          // A brand drug's own SBDC edges name the brand; the
          // pharmacology lives on the generic clinical drug it is a
          // tradename of.
          const direct = ingredientsOfDrug(rxcui);
          if (direct.size > 0) return direct;
          const merged = new Map<string, RxnormIngredient>();
          for (const generic of genericOfBrand.get(rxcui) ?? []) {
            for (const [key, value] of ingredientsOfDrug(generic)) merged.set(key, value);
          }
          return merged;
        }
        case "GPCK":
        case "BPCK": {
          const merged = new Map<string, RxnormIngredient>();
          for (const contained of packContents.get(rxcui) ?? []) {
            for (const [key, value] of resolveProduct(contained)) merged.set(key, value);
          }
          return merged;
        }
        default:
          return new Map();
      }
    };

    const productIngredients = new Map<string, ReadonlyArray<RxnormIngredient>>();
    const ndcToProduct = new Map<string, string>();
    let ndcsWithoutIngredients = 0;

    for (const [ndc, productRxcui] of this.ndcToProduct) {
      if (!isProduct(productRxcui)) {
        ndcsWithoutIngredients += 1;
        continue;
      }
      if (!productIngredients.has(productRxcui)) {
        const resolved = [...resolveProduct(productRxcui).values()].sort((x, y) =>
          x.rxcui.localeCompare(y.rxcui)
        );
        if (resolved.length === 0) {
          ndcsWithoutIngredients += 1;
          continue;
        }
        productIngredients.set(productRxcui, resolved);
      }
      ndcToProduct.set(ndc, productRxcui);
    }

    // Drop ingredient lists no surviving NDC points at, so the row
    // count in the summary describes what screening can reach.
    const reachable = new Set(ndcToProduct.values());
    for (const key of [...productIngredients.keys()]) {
      if (!reachable.has(key)) productIngredients.delete(key);
    }

    return { ndcToProduct, productIngredients, ndcsWithoutIngredients };
  }
}
