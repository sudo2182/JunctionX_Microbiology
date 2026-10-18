export function Section({
  title,
  subtitle,
  children,
  id,
  action,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  action?: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-6 rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-ink-2">{subtitle}</p>}
        </div>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="mt-1 max-w-3xl text-sm text-ink-2">{children}</p>}
    </div>
  );
}
