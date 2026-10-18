import "server-only";

import { mockSource } from "./mock";
import { supabaseSource } from "./supabase";
import type { DataSource } from "./types";

/**
 * The dashboard reads Supabase when NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set,
 * and the local mock otherwise. DATA_SOURCE=mock forces the mock even when keys are present.
 */
export function getData(): DataSource {
  const hasKeys = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return hasKeys && process.env.DATA_SOURCE !== "mock" ? supabaseSource : mockSource;
}

export type * from "./types";
