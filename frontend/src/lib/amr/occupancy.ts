import { MARKERS, WARDS, daysBetween } from "./reference";
import { firstIsolates, MIN_ISOLATES } from "./stats";
import type { IsolateRecord, StayRecord } from "./store";

export type StayEpisode = { patient: string; ward: string; start: string; end: string };

export function stayEnd(start: string, ward: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (ward === "PHC-N" || ward === "PHC-S") {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 6);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  } else {
    d.setUTCDate(d.getUTCDate() + (ward === "ED" || ward === "SURG" ? 3 : 14));
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Who is estimated to be in each ward: every culture counts, so a patient whose
 * sample grew nothing is still a patient. Repeated tests do not extend a stay;
 * a new ward test transfers the patient.
 */
export function estimatedOccupancy(stays: StayRecord[], asOf: string): StayEpisode[] {
  const latest = new Map<string, StayEpisode>();
  for (const s of [...stays].filter((s) => s.date <= asOf).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const prior = latest.get(s.patient);
    if (prior && prior.ward === s.ward && s.date < prior.end) continue;
    latest.set(s.patient, { patient: s.patient, ward: s.ward, start: s.date, end: stayEnd(s.date, s.ward) });
  }
  return [...latest.values()].filter((e) => e.start <= asOf && asOf < e.end);
}

export function markerRates(records: IsolateRecord[]) {
  const isolates = firstIsolates(records);
  return MARKERS.map((m) => {
    const positive = isolates.filter((r) => (r.flags & m.bit) !== 0).length;
    return { ...m, positive, n: isolates.length, pct: isolates.length >= MIN_ISOLATES ? positive / isolates.length * 100 : null };
  });
}

export function wardOverview(stays: StayRecord[], records: IsolateRecord[], asOf: string) {
  const active = estimatedOccupancy(stays, asOf);
  const positives = records.filter((r) => r.flags !== 0);
  const byPatient = new Map<string, IsolateRecord[]>();
  for (const p of positives) {
    const list = byPatient.get(p.patient);
    if (list) list.push(p);
    else byPatient.set(p.patient, [p]);
  }
  const inStay = (e: StayEpisode) => (byPatient.get(e.patient) ?? []).filter((p) => p.ward === e.ward && p.date >= e.start && p.date < e.end);
  const recent = records.filter((r) => r.date <= asOf && daysBetween(r.date, asOf) < 28);
  return WARDS.map((ward) => {
    const episodes = active.filter((e) => e.ward === ward.code);
    const positive = episodes.filter((e) => inStay(e).length > 0);
    const baseline = recent.filter((r) => r.ward === ward.code);
    const organisms = [...new Set(positive.flatMap((e) => inStay(e).map((r) => r.organism)))].sort();
    return {
      ...ward,
      occupancy: episodes.length,
      patients: positive.length,
      markers: MARKERS.map((m) => ({ ...m, patients: positive.filter((e) => inStay(e).some((r) => (r.flags & m.bit) !== 0)).length })),
      rates: markerRates(baseline),
      organisms: organisms.map((organism) => ({
        organism,
        patients: positive.filter((e) => inStay(e).some((r) => r.organism === organism)).length,
        markers: MARKERS.filter((m) => positive.some((e) => inStay(e).some((r) => r.organism === organism && (r.flags & m.bit) !== 0))),
        rates: markerRates(baseline.filter((r) => r.organism === organism)),
      })),
    };
  }).sort((a, b) => (a.institution === b.institution ? b.patients - a.patients : a.institution === "hospital" ? -1 : 1));
}

/** Weekly point-in-time estimates; every snapshot applies the same transfer/stay rules. */
export function wardHistory(stays: StayRecord[], records: IsolateRecord[], ward: string, asOf: string) {
  return Array.from({ length: 13 }, (_, index) => {
    const date = new Date(`${asOf}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (12 - index) * 7);
    const day = date.toISOString().slice(0, 10);
    const episodes = estimatedOccupancy(stays, day).filter((e) => e.ward === ward);
    const rates = markerRates(records.filter((r) => r.ward === ward && r.date <= day && daysBetween(r.date, day) < 28));
    const positives = records.filter((r) => r.ward === ward && r.flags !== 0);
    return {
      date: day,
      occupancy: episodes.length,
      positive: episodes.filter((e) => positives.some((p) => p.patient === e.patient && p.date >= e.start && p.date < e.end)).length,
      esbl: rates.find((m) => m.key === "esbl")?.pct ?? null,
      mrsa: rates.find((m) => m.key === "mrsa")?.pct ?? null,
      vre: rates.find((m) => m.key === "vre")?.pct ?? null,
      cpe: rates.find((m) => m.key === "cpe")?.pct ?? null };
  });
}
