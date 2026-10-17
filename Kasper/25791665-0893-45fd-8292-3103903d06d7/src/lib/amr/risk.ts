import { abxResult, type IsolateRecord } from "./store";

/** Naive Bayes risk model: missing features are simply skipped, so it works with incomplete patient data. */
export type Features = Partial<{
  sex: string;
  ageBand: string;
  ward: string;
  specimen: string;
  organism: string;
  setting: string;
  onset: string;
}>;

export const FEATURE_LABELS: Record<keyof Features, string> = {
  sex: "Sex",
  ageBand: "Age group",
  ward: "Ward",
  specimen: "Specimen",
  organism: "Organism",
  setting: "Care setting",
  onset: "Onset",
};

export function ageBand(age: number) {
  if (age < 18) return "0-17";
  if (age < 45) return "18-44";
  if (age < 65) return "45-64";
  if (age < 80) return "65-79";
  return "80+";
}

export function featuresOf(r: IsolateRecord): Required<Features> {
  return {
    sex: r.sex,
    ageBand: ageBand(r.age),
    ward: r.ward,
    specimen: r.specimen,
    organism: r.organism,
    setting: r.setting,
    onset: r.onset,
  };
}

export type Target = { key: string; label: string; applies: (r: IsolateRecord) => boolean; positive: (r: IsolateRecord) => boolean };

export function makeTarget(key: string): Target {
  if (key === "any") return { key, label: "Any resistance marker (ESBL/MRSA/VRE/CPE)", applies: () => true, positive: (r) => r.flags > 0 };
  const bits: Record<string, [number, string]> = { esbl: [1, "ESBL"], mrsa: [2, "MRSA"], vre: [4, "VRE"], cpe: [8, "CPE"] };
  if (bits[key]) return { key, label: bits[key][1], applies: () => true, positive: (r) => (r.flags & bits[key][0]) > 0 };
  const code = key.replace("abx:", "");
  return {
    key,
    label: `Resistance to ${code}`,
    applies: (r) => abxResult(r, code) !== "-",
    positive: (r) => abxResult(r, code) === "R",
  };
}

export type Model = { n: [number, number]; counts: Record<string, Record<string, [number, number]>> };

export function train(records: IsolateRecord[], t: Target): Model {
  const n: [number, number] = [0, 0];
  const counts: Model["counts"] = {};
  for (const r of records) {
    if (!t.applies(r)) continue;
    const y = t.positive(r) ? 1 : 0;
    n[y]++;
    const f = featuresOf(r);
    for (const k in f) {
      const v = f[k as keyof Features];
      counts[k] ??= {};
      counts[k][v] ??= [0, 0];
      counts[k][v][y]++;
    }
  }
  return { n, counts };
}

export function predict(m: Model, f: Features) {
  const alpha = 1;
  const prior = Math.log((m.n[1] + alpha) / (m.n[0] + alpha));
  let logit = prior;
  const contributions: { feature: string; value: string; lr: number }[] = [];
  for (const k in f) {
    const v = f[k as keyof Features];
    if (!v || !m.counts[k]) continue;
    const levels = Object.keys(m.counts[k]).length;
    const c = m.counts[k][v] ?? [0, 0];
    const p1 = (c[1] + alpha) / (m.n[1] + alpha * levels);
    const p0 = (c[0] + alpha) / (m.n[0] + alpha * levels);
    const lr = Math.log(p1 / p0);
    logit += lr;
    contributions.push({ feature: k, value: v, lr });
  }
  const sig = (x: number) => 1 / (1 + Math.exp(-x));
  return { probability: sig(logit), baseline: sig(prior), contributions, trainedOn: m.n[0] + m.n[1] };
}
