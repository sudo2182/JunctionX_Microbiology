export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      news_items: {
        Row: {
          alert_date: string
          id: string
          organism: string | null
          posted_at: string
          region: string | null
          severity: string
          source: string
          summary: string
          title: string
          url: string | null
        }
        Insert: {
          alert_date?: string
          id?: string
          organism?: string | null
          posted_at?: string
          region?: string | null
          severity?: string
          source?: string
          summary?: string
          title: string
          url?: string | null
        }
        Update: {
          alert_date?: string
          id?: string
          organism?: string | null
          posted_at?: string
          region?: string | null
          severity?: string
          source?: string
          summary?: string
          title?: string
          url?: string | null
        }
        Relationships: []
      }
      record_submissions: {
        Row: {
          admission_date: string | null
          age_years: number
          batch_id: string | null
          id: string
          markers: number
          note: string | null
          organism: string
          patient_id: string
          processed_at: string | null
          sample_date: string
          sex: string
          source: string
          specimen: string
          status: string
          submitted_at: string
          susceptibility: string
          ward_code: string
        }
        Insert: {
          admission_date?: string | null
          age_years: number
          batch_id?: string | null
          id?: string
          markers?: number
          note?: string | null
          organism: string
          patient_id: string
          processed_at?: string | null
          sample_date: string
          sex: string
          source?: string
          specimen: string
          status?: string
          submitted_at?: string
          susceptibility?: string
          ward_code: string
        }
        Update: {
          admission_date?: string | null
          age_years?: number
          batch_id?: string | null
          id?: string
          markers?: number
          note?: string | null
          organism?: string
          patient_id?: string
          processed_at?: string | null
          sample_date?: string
          sex?: string
          source?: string
          specimen?: string
          status?: string
          submitted_at?: string
          susceptibility?: string
          ward_code?: string
        }
        Relationships: []
      }
    }
    Views: {
      records: {
        Row: {
          admission_date: string | null
          age: number | null
          age_band: string | null
          cpe: boolean | null
          culture_result: string | null
          esbl: boolean | null
          gram: string | null
          id: string | null
          institution: string | null
          intrinsic: string | null
          markers: number | null
          mrsa: boolean | null
          onset: string | null
          org_group: string | null
          organism: string | null
          organism_short: string | null
          patient_id: string | null
          quantity: string | null
          sample_date: string | null
          setting: string | null
          sex: string | null
          specimen: string | null
          susceptibility: string | null
          vre: boolean | null
          ward: string | null
          ward_en: string | null
          ward_fi: string | null
          ward_type: string | null
          week_idx: number | null
        }
        Relationships: []
      }
      ward_stays: {
        Row: {
          admission_date: string | null
          id: string | null
          institution: string | null
          n_isolates: number | null
          onset: string | null
          patient_id: string | null
          result: string | null
          sample_date: string | null
          setting: string | null
          specimen: string | null
          ward: string | null
          ward_type: string | null
          week_idx: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  // Read-only reference views from supabase/migrations/20261017000005_api_views.sql (repo root).
  api: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      ref_wards: {
        Row: {
          institution: string | null
          ward_code: string | null
          ward_en: string | null
          ward_fi: string | null
          ward_type: string | null
        }
        Relationships: []
      }
      ref_antibiotics: {
        Row: {
          antibiotic: string | null
          antibiotic_code: string | null
          antibiotic_fi: string | null
          class: string | null
          reported_for: string | null
        }
        Relationships: []
      }
      ref_organisms: {
        Row: {
          gram: string | null
          name: string | null
          org_group: string | null
          short_name: string | null
          whonet_code: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
