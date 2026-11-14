"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ICONS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  log: "M4 5h16M4 12h16M4 19h10",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
};

const LINKS = [
  { href: "/", label: "Dashboard", short: "Home", icon: ICONS.home },
  { href: "/log", label: "Send log", short: "Log", icon: ICONS.log },
  { href: "/settings", label: "Settings", short: "Settings", icon: ICONS.settings },
];

/** Inline links on desktop; fixed bottom tab bar on phones (see CSS). */
export function Nav() {
  const path = usePathname();
  return (
    <>
      <nav className="nav-inline" aria-label="Main">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="nav-link" aria-current={path === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      <nav className="tabbar" aria-label="Main">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="tab" aria-current={path === l.href ? "page" : undefined}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={l.icon} />
            </svg>
            <span>{l.short}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
