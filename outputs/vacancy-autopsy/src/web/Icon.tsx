import type { ReactNode } from "react";

export function Icon({
  name,
  size = 20,
}: {
  name:
    | "arrow"
    | "search"
    | "file"
    | "check"
    | "clock"
    | "link"
    | "download"
    | "refresh"
    | "shield";
  size?: number;
}) {
  const paths: Record<typeof name, ReactNode> = {
    arrow: (
      <>
        <path d="M4 12h15m-6-6 6 6-6 6" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    link: (
      <>
        <path d="m10 13 4-4m-6 6-1 1a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m0 12a3.5 3.5 0 0 0 5 0l5-5a3.5 3.5 0 0 0-5-5l-1 1" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 8a8 8 0 1 0 0 8M20 3v6h-6" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v5c0 5-5 9-8 10-3-1-8-5-8-10V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
