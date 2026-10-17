import { ANTIBIOTICS } from "./reference";

export const GUIDELINE_URL = "https://www.eucast.org/bacteria/clinical-breakpoints-and-interpretation/clinical-breakpoint-tables/";
export type Applicability = { status: "applicable" | "urinary" | "expected-resistant" | "screen" | "review" | "unsupported"; reason: string };
const ENTEROBACTERALES = ["Escherichia coli", "Klebsiella pneumoniae", "Klebsiella oxytoca", "Proteus mirabilis", "Citrobacter freundii"];
const STAPH = ["Staphylococcus aureus", "Staphylococcus saprophyticus"];

/** Conservative EUCAST 2026 table subset, not prescribing logic or reinterpretation of historical AST. */
export function antibioticApplicability(organism: string, code: string): Applicability {
  const result = (status: Applicability["status"], reason: string): Applicability => ({ status, reason });
  if (code === "FOX" && (ENTEROBACTERALES.includes(organism) || STAPH.includes(organism)))
    return result("screen", "Cefoxitin is a resistance screen, not a treatment option.");
  if (code === "AMP" && ["Klebsiella pneumoniae", "Klebsiella oxytoca", "Citrobacter freundii"].includes(organism))
    return result("expected-resistant", "Expected ampicillin resistance; contradictory susceptible results need laboratory review.");
  if (ENTEROBACTERALES.includes(organism)) {
    if (["AMP", "TZP", "CRO", "CAZ", "MEM", "CIP"].includes(code)) return result("applicable", "Organism-group clinical breakpoint; indication and exposure notes still apply.");
    if (code === "CXM" && organism !== "Citrobacter freundii") return result("applicable", "Species-supported cefuroxime IV breakpoint; oral use has uncomplicated-UTI restrictions.");
    if (code === "MEC") return result("urinary", "Pivmecillinam: uncomplicated lower UTI only.");
    if (code === "TMP" && ["Escherichia coli", "Klebsiella pneumoniae", "Klebsiella oxytoca"].includes(organism)) return result("urinary", "Trimethoprim: uncomplicated lower UTI only.");
    if (code === "TMP" && organism === "Proteus mirabilis") return result("review", "Insufficient clinical efficacy evidence; ECOFF is not a clinical treatment breakpoint.");
    if (code === "NIT" && organism === "Escherichia coli") return result("urinary", "Nitrofurantoin: E. coli uncomplicated lower UTI only.");
  }
  if (organism === "Pseudomonas aeruginosa" && ["TZP", "CAZ", "MEM", "CIP"].includes(code)) return result("applicable", "Pseudomonas clinical breakpoint; exposure and indication notes apply.");
  if (STAPH.includes(organism)) {
    if (["VAN", "CLI"].includes(code)) return result("applicable", code === "CLI" ? "Requires assessment of inducible clindamycin resistance." : "Vancomycin requires a valid MIC-based interpretation.");
    if (code === "TMP" || (code === "NIT" && organism === "Staphylococcus saprophyticus")) return result("urinary", "Uncomplicated lower UTI only.");
    if (code === "AMP" && organism === "Staphylococcus saprophyticus") return result("review", "Species-specific ampicillin and methicillin-resistance inference rules require laboratory review.");
    if (code === "CIP") return result("review", "Bracketed breakpoints; high-exposure combination use requires expert interpretation, not a standalone treatment option.");
    if (["TZP", "CXM", "CRO", "MEM"].includes(code)) return result("review", "Staphylococcal beta-lactam results require methicillin/penicillin inference and exposure review; not an independent treatment breakpoint.");
  }
  if (organism === "Enterococcus faecalis") {
    if (["AMP", "VAN"].includes(code)) return result("applicable", "Enterococcal clinical breakpoint; indication, method and exposure notes apply.");
    if (["CIP", "NIT"].includes(code)) return result("urinary", "E. faecalis uncomplicated lower UTI only.");
    if (code === "TMP") return result("review", "In-vitro trimethoprim activity cannot predict clinical efficacy in enterococci.");
  }
  return result("unsupported", "No supported clinical breakpoint in this conservative organism–agent subset; do not infer treatment activity.");
}

export function commonAntibiotics(organisms: string[], uncomplicatedUTI = false) {
  if (!organisms.length) return [];
  return ANTIBIOTICS.filter((a) => organisms.every((o) => {
    const { status } = antibioticApplicability(o, a.code);
    return status === "applicable" || (uncomplicatedUTI && status === "urinary");
  }));
}

export function applicableResult(organism: string, code: string, specimen: string, uncomplicatedUTI: boolean) {
  const { status } = antibioticApplicability(organism, code);
  return status === "applicable" || (status === "urinary" && uncomplicatedUTI && specimen === "urine");
}