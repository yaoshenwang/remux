"use client";

import Link from "next/link";
import posthog from "posthog-js";

export function NavLinks() {
  return (
    <>
      <Link
        href="/docs/getting-started"
        className="hover:text-foreground transition-colors"
      >
        Docs
      </Link>
      <Link
        href="/blog"
        className="hover:text-foreground transition-colors"
      >
        Blog
      </Link>
      <Link
        href="/docs/changelog"
        className="hover:text-foreground transition-colors"
      >
        Changelog
      </Link>
      <Link
        href="/community"
        className="hover:text-foreground transition-colors"
      >
        Community
      </Link>
      <a
        href="https://github.com/yaoshenwang/remux"
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => posthog.capture("remuxterm_github_clicked", { location: "navbar" })}
        className="hover:text-foreground transition-colors"
      >
        GitHub
      </a>
    </>
  );
}

