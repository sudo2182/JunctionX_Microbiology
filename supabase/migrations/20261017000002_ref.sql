-- AMR Watch: reference data (BUILD_PLAN.md §3.2 R1, R2, R6 and §4).

create table if not exists ref.wards (
  ward_code   text primary key,
  ward_fi     text not null,
  ward_en     text not null,
  ward_type   text not null check (ward_type in ('in', 'out')),
  institution text not null check (institution in ('hospital', 'primary_care'))
);

create table if not exists ref.antibiotics (
  antibiotic_code text primary key,          -- WHONET code
  antibiotic      text not null,
  antibiotic_fi   text not null,
  class           text not null,
  reported_for    text not null check (reported_for in ('all', 'urine'))
);

create table if not exists ref.organisms (
  name        text primary key,               -- Latin name as in the LIS export
  short_name  text not null,
  whonet_code text not null,
  gram        text not null check (gram in ('positive', 'negative')),
  org_group   text not null                   -- 'Enterobacterales', 'Staphylococci', ...
);

-- EUCAST Expected Resistant Phenotypes v1.2. Matching AST rows are kept but flagged
-- is_intrinsic = true and excluded from every rate; the heatmap shows them as "IR".
create table if not exists ref.intrinsic_resistance (
  organism        text references ref.organisms (name),
  antibiotic_code text references ref.antibiotics (antibiotic_code),
  source          text not null,
  primary key (organism, antibiotic_code)
);

-- Which organisms a phenotype marker is reported for (agg.rates.antibiotic_code = marker).
create table if not exists ref.phenotypes (
  marker   text not null check (marker in ('ESBL', 'MRSA', 'VRE', 'CPE')),
  organism text not null references ref.organisms (name),
  primary key (marker, organism)
);

-- Anomaly engine thresholds, frozen here after tuning (BUILD_PLAN.md §7). Owned by detect.py.
create table if not exists ref.alert_rules (
  rule_key    text primary key,
  value       numeric not null,
  description text not null
);

-- Our organism + WHONET code + specimen -> benchmark antimicrobial group (BUILD_PLAN.md §3.3).
-- Mirrors pipeline/benchmarks/mapping.csv; antimicrobial_group uses its canonical snake_case names.
create table if not exists ref.benchmark_mapping (
  organism            text references ref.organisms (name),
  antibiotic_code     text not null,          -- WHONET code or phenotype marker
  specimen            text not null,          -- our specimen: 'urine' | 'blood' | 'wound' | 'all'
  antimicrobial_group text not null,
  specimen_scope      text not null check (specimen_scope in ('invasive', 'urine', 'all')),
  primary key (organism, antibiotic_code, specimen)
);

insert into ref.wards (ward_code, ward_fi, ward_en, ward_type, institution) values
  ('ED',    'Päivystys',              'Emergency department', 'out', 'hospital'),
  ('MED-A', 'Sisätaudit A',           'Internal medicine A',  'in',  'hospital'),
  ('MED-B', 'Sisätaudit B',           'Internal medicine B',  'in',  'hospital'),
  ('SURG',  'Kirurgia',               'Surgery',              'in',  'hospital'),
  ('URO',   'Urologia',               'Urology',              'in',  'hospital'),
  ('ICU',   'Teho-osasto',            'Intensive care unit',  'in',  'hospital'),
  ('GER',   'Geriatria',              'Geriatrics',           'in',  'hospital'),
  ('PHC-N', 'Terveysasema Pohjoinen', 'Health centre North',  'out', 'primary_care'),
  ('PHC-S', 'Terveysasema Etelä',     'Health centre South',  'out', 'primary_care')
on conflict do nothing;

insert into ref.antibiotics (antibiotic_code, antibiotic, antibiotic_fi, class, reported_for) values
  ('AMP', 'ampicillin',              'ampisilliini',                 'penicillins',            'all'),
  ('MEC', 'mecillinam',              'mesillinaami',                 'penicillins',            'urine'),
  ('TZP', 'piperacillin-tazobactam', 'piperasilliini-tatsobaktaami', 'penicillins + BLI',      'all'),
  ('FOX', 'cefoxitin (screen)',      'kefoksitiini (seulonta)',      'MRSA screen',            'all'),
  ('CXM', 'cefuroxime',              'kefuroksiimi',                 'cephalosporins 2nd gen', 'all'),
  ('CRO', 'ceftriaxone',             'keftriaksoni',                 'cephalosporins 3rd gen', 'all'),
  ('CAZ', 'ceftazidime',             'keftatsidiimi',                'cephalosporins 3rd gen', 'all'),
  ('MEM', 'meropenem',               'meropeneemi',                  'carbapenems',            'all'),
  ('CIP', 'ciprofloxacin',           'siprofloksasiini',             'fluoroquinolones',       'all'),
  ('TMP', 'trimethoprim',            'trimetopriimi',                'trimethoprim',           'urine'),
  ('NIT', 'nitrofurantoin',          'nitrofurantoiini',             'nitrofurans',            'urine'),
  ('VAN', 'vancomycin',              'vankomysiini',                 'glycopeptides',          'all'),
  ('CLI', 'clindamycin',             'klindamysiini',                'lincosamides',           'all')
on conflict do nothing;

insert into ref.organisms (name, short_name, whonet_code, gram, org_group) values
  ('Escherichia coli',             'E. coli',            'eco', 'negative', 'Enterobacterales'),
  ('Klebsiella pneumoniae',        'K. pneumoniae',      'kpn', 'negative', 'Enterobacterales'),
  ('Klebsiella oxytoca',           'K. oxytoca',         'kox', 'negative', 'Enterobacterales'),
  ('Proteus mirabilis',            'P. mirabilis',       'pmi', 'negative', 'Enterobacterales'),
  ('Citrobacter freundii',         'C. freundii',        'cfr', 'negative', 'Enterobacterales'),
  ('Pseudomonas aeruginosa',       'P. aeruginosa',      'pae', 'negative', 'Non-fermenters'),
  ('Staphylococcus aureus',        'S. aureus',          'sau', 'positive', 'Staphylococci'),
  ('Staphylococcus saprophyticus', 'S. saprophyticus',   'ssa', 'positive', 'Staphylococci'),
  ('Enterococcus faecalis',        'E. faecalis',        'efa', 'positive', 'Enterococci')
on conflict do nothing;

insert into ref.intrinsic_resistance (organism, antibiotic_code, source) values
  ('Klebsiella pneumoniae', 'AMP', 'EUCAST Expected Resistant Phenotypes v1.2'),
  ('Klebsiella oxytoca',    'AMP', 'EUCAST Expected Resistant Phenotypes v1.2'),
  ('Citrobacter freundii',  'AMP', 'EUCAST Expected Resistant Phenotypes v1.2'),
  ('Proteus mirabilis',     'NIT', 'EUCAST Expected Resistant Phenotypes v1.2')
on conflict do nothing;

insert into ref.phenotypes (marker, organism) values
  ('ESBL', 'Escherichia coli'), ('ESBL', 'Klebsiella pneumoniae'),
  ('MRSA', 'Staphylococcus aureus'),
  ('VRE',  'Enterococcus faecalis'),
  ('CPE',  'Escherichia coli'), ('CPE', 'Klebsiella pneumoniae'), ('CPE', 'Klebsiella oxytoca'),
  ('CPE',  'Proteus mirabilis'), ('CPE', 'Citrobacter freundii')
on conflict do nothing;

insert into ref.alert_rules (rule_key, value, description) values
  ('min_n',                30,    'Minimum first isolates in both windows before a rate test runs'),
  ('current_window_weeks', 4,     'Trailing current window (weeks t-3..t)'),
  ('baseline_window_weeks',52,    'Baseline: the 52 weeks before the current window'),
  ('rate_q_max',           0.05,  'Benjamini-Hochberg q-value threshold for rate signals'),
  ('rate_min_abs_pp',      5,     'Minimum absolute increase in percentage points'),
  ('rate_min_ratio',       1.5,   'Minimum relative increase (alternative to min_abs_pp)'),
  ('count_p_max',          0.01,  'Poisson upper-tail p threshold for count signals'),
  ('count_min_k',          3,     'Minimum count for a count signal'),
  ('resolve_after_weeks',  2,     'Episode resolves after this many consecutive quiet weeks')
on conflict do nothing;

insert into ref.benchmark_mapping (organism, antibiotic_code, specimen, antimicrobial_group, specimen_scope) values
  ('Escherichia coli', 'CRO', 'blood', 'third_generation_cephalosporins', 'invasive'),
  ('Escherichia coli', 'CIP', 'blood', 'fluoroquinolones', 'invasive'),
  ('Escherichia coli', 'AMP', 'blood', 'aminopenicillins', 'invasive'),
  ('Escherichia coli', 'MEM', 'blood', 'carbapenems', 'invasive'),
  ('Escherichia coli', 'CRO', 'urine', 'third_generation_cephalosporins', 'urine'),
  ('Escherichia coli', 'CIP', 'urine', 'fluoroquinolones', 'urine'),
  ('Escherichia coli', 'AMP', 'urine', 'aminopenicillins', 'urine'),
  ('Escherichia coli', 'MEC', 'urine', 'mecillinam', 'urine'),
  ('Escherichia coli', 'TMP', 'urine', 'trimethoprim', 'urine'),
  ('Escherichia coli', 'NIT', 'urine', 'nitrofurantoin', 'urine'),
  ('Klebsiella pneumoniae', 'CRO', 'blood', 'third_generation_cephalosporins', 'invasive'),
  ('Klebsiella pneumoniae', 'CIP', 'blood', 'fluoroquinolones', 'invasive'),
  ('Klebsiella pneumoniae', 'MEM', 'blood', 'carbapenems', 'invasive'),
  ('Klebsiella pneumoniae', 'CRO', 'urine', 'third_generation_cephalosporins', 'urine'),
  ('Klebsiella pneumoniae', 'CIP', 'urine', 'fluoroquinolones', 'urine'),
  ('Pseudomonas aeruginosa', 'TZP', 'blood', 'piperacillin_tazobactam', 'invasive'),
  ('Pseudomonas aeruginosa', 'CAZ', 'blood', 'ceftazidime', 'invasive'),
  ('Pseudomonas aeruginosa', 'CIP', 'blood', 'fluoroquinolones', 'invasive'),
  ('Pseudomonas aeruginosa', 'MEM', 'blood', 'carbapenems', 'invasive'),
  ('Staphylococcus aureus', 'FOX', 'blood', 'mrsa', 'invasive'),
  ('Staphylococcus aureus', 'MRSA', 'blood', 'mrsa', 'invasive'),
  ('Staphylococcus aureus', 'MRSA', 'all', 'mrsa', 'all')
on conflict do nothing;
