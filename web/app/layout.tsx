import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Jiang Clips Control Room",
  description: "Upload source videos, queue cloud processing jobs, and review generated clips.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <header className="global-nav-wrap">
          <nav className="global-nav">
            <Link className="brand-mark" href="/">
              Jiang Clips
            </Link>
            <div className="global-nav-links">
              <Link className="global-nav-link" href="/">
                Dashboard
              </Link>
              <Link className="global-nav-link" href="/settings">
                Settings
              </Link>
            </div>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
