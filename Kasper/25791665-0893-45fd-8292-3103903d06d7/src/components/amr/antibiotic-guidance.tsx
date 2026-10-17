import { ANTIBIOTICS } from "@/lib/amr/reference";
import { antibioticApplicability, commonAntibiotics, GUIDELINE_URL } from "@/lib/amr/applicability";

export function AntibioticGuidance({ organisms, uncomplicatedUTI }: { organisms: string[]; uncomplicatedUTI: boolean }) {
  const common = commonAntibiotics(organisms, uncomplicatedUTI);
  return <section className="space-y-2 border-t pt-3 text-xs">
    <h2 className="font-semibold">Common guideline-supported agents</h2>
    <p>{common.length ? common.map((a) => a.name).join(" · ") : "No common agent in the supported subset for this selection."}</p>
    <p className="text-muted-foreground"><a href={GUIDELINE_URL} target="_blank" rel="noreferrer" className="text-primary underline">EUCAST 2026 tables (v16.0; current revision v16.1)</a> · Conservative subset, not a treatment recommendation. A breakpoint does not establish susceptibility or efficacy. Infection site, dosing/exposure, valid AST and local clinical guidance must be reviewed. Urine specimens alone do not confirm uncomplicated UTI. Historical S/R results are not reinterpreted.</p>
    <details><summary className="cursor-pointer text-primary">Agent coverage by organism</summary>
      <ul className="mt-2 space-y-2">{organisms.map((o) => <li key={o}><span className="italic">{o}</span>: {commonAntibiotics([o], uncomplicatedUTI).map((a) => a.code).join(", ") || "None in subset"}.
        <span className="text-muted-foreground"> Review-only: {ANTIBIOTICS.filter((a) => antibioticApplicability(o, a.code).status === "review").map((a) => a.code).join(", ") || "none"}.</span>
      </li>)}</ul>
    </details>
    {!common.length && <p className="text-muted-foreground">A safe combined regimen cannot be inferred from these surveillance records; clinical review is required.</p>}
  </section>;
}