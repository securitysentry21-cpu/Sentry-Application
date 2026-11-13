// The dashboard's icons: drawn here on one 24-unit grid with one stroke, so the set stays consistent
// and nothing is fetched or added as a dependency. Decorative only (aria-hidden): every icon sits
// beside, or stands in for, a text name that screen readers get.
import type { ReactNode } from 'react';

const PATHS = {
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </>
  ),
  live: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22" />
    </>
  ),
  alerts: (
    <>
      <path d="M6 10.5a6 6 0 0 1 12 0v4.2l1.6 2.3H4.4L6 14.7z" />
      <path d="M10 20a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  incidents: (
    <>
      <path d="M12 4 3 19.5h18z" />
      <path d="M12 10v4.2M12 17v.01" />
    </>
  ),
  shifts: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  patrols: (
    <>
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M8 18h5.5a3 3 0 0 0 0-6h-3a3 3 0 0 1 0-6H16" />
    </>
  ),
  guards: <path d="M12 3 5 5.8v5.4c0 4.4 3 8.2 7 9.8 4-1.6 7-5.4 7-9.8V5.8z" />,
  sites: (
    <>
      <path d="M12 21s6-5.2 6-10.5a6 6 0 1 0-12 0C6 15.8 12 21 12 21z" />
      <circle cx="12" cy="10.5" r="2.2" />
    </>
  ),
  reports: <path d="M5 20v-7M9.7 20V5M14.3 20v-9.5M19 20v-5" />,
  exports: (
    <>
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 15.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
    </>
  ),
  members: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
      <path d="M15.4 5.6a3 3 0 0 1 0 5.8M17 14.7c2 .5 3.2 2.1 3.5 4.8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20" />
      <circle cx="15" cy="7" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
    </>
  ),
  drills: (
    <>
      <path d="M6.5 17v-4.5a5.5 5.5 0 0 1 11 0V17" />
      <path d="M4.5 17h15v3h-15z" />
      <path d="M12 2.5v2M4.6 5.4 6 6.8M19.4 5.4 18 6.8" />
    </>
  ),
  audit: (
    <>
      <path d="M8.5 4.5h-2A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5h-2" />
      <rect x="8.5" y="3" width="7" height="3" rx="1" />
      <path d="M9 11h6M9 15h4" />
    </>
  ),
  notifications: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  open: <path d="M7 17 17 7M9 7h8v8" />,
  signOut: (
    <>
      <path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10" />
      <path d="M14 8l4 4-4 4M18 12H9.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
