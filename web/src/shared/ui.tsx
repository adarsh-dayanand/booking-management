import { useEffect, useId, type ButtonHTMLAttributes, type ReactNode } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; small?: boolean };
export function Button({ variant = "primary", small, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("btn", `btn-${variant}`, small && "btn-sm", className)} {...rest} />;
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "success" | "warning"; children: ReactNode }) {
  if (!children) return null;
  return (
    <div className={cx("alert", `alert-${kind}`)} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "info"; children: ReactNode }) {
  return <span className={cx("badge", `badge-${tone}`)}>{children}</span>;
}

/** A labelled form control. The label wraps the control (so it is announced and clickable); the hint sits outside it so it
 *  doesn't become part of the control's accessible name. */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("field", className)}>
      <label>
        <span className="field-label">{label}</span>
        {children}
      </label>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Card({ title, actions, children, className }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" | "good" }) {
  return (
    <div className={cx("stat", tone && `stat-${tone}`)}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="muted" role="status">{label}</div>;
}

/** Accessible dialog: Esc and a backdrop click close it, and it is labelled by its title. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("modal", wide && "modal-wide")} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="modal-head">
          <h2 id={id}>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: { id: T; label: string }[]; active: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={t.id === active} className={cx("tab", t.id === active && "tab-active")} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The Neem mark and name, as on the marketing website, with the area (Consultant / Admin) underneath. */
export function Brand({ area }: { area: string }) {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 3.5C11.2 3.2 5 8 5 14.8c0 1.3.2 2.4.7 3.4L3 21.2l1.6 1.2 2.8-3.1c1.2.8 2.7 1.2 4.4 1.2C18.4 20.5 21 12.8 20.5 3.5Z" /></svg>
      </span>
      <span>Neem<small>{area}</small></span>
    </div>
  );
}

export function Shell({ area, nav, route, onNavigate, onLogout, children, account }: {
  area: string;
  nav: { id: string; label: string }[];
  route: string;
  onNavigate: (to: string) => void;
  onLogout: () => void;
  children: ReactNode;
  account?: ReactNode;
}) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand area={area} />
        <nav aria-label="Main">
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={cx("nav-link", route.split("/")[1] === n.id && "nav-active")} onClick={(e) => { e.preventDefault(); onNavigate(`/${n.id}`); }}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          {account && <div className="muted small">{account}</div>}
          <Button variant="ghost" small onClick={onLogout}>Log out</Button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

export function LoginLayout({ area, title, subtitle, children, alt }: { area: string; title: string; subtitle?: string; children: ReactNode; alt?: ReactNode }) {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <Brand area={area} />
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
        {alt && <div className="login-alt">{alt}</div>}
      </div>
    </div>
  );
}
