import type { Metadata } from "next";
import Link from "next/link";
import { absoluteUrl } from "../../site";

export const metadata: Metadata = {
  title: "Introducing remux",
  description:
    "A native macOS terminal built on Ghostty, designed for running multiple AI coding agents side by side.",
  keywords: [
    "remux",
    "terminal",
    "macOS",
    "Ghostty",
    "libghostty",
    "AI coding agents",
    "Claude Code",
    "vertical tabs",
    "split panes",
    "socket API",
  ],
  openGraph: {
    title: "Introducing remux",
    description:
      "A native macOS terminal built on Ghostty, designed for running multiple AI coding agents side by side.",
    type: "article",
    publishedTime: "2026-02-12T00:00:00Z",
    url: absoluteUrl("/blog/introducing-remux"),
  },
  twitter: {
    card: "summary",
    title: "Introducing remux",
    description:
      "A native macOS terminal built on Ghostty, designed for running multiple AI coding agents side by side.",
  },
  alternates: {
    canonical: absoluteUrl("/blog/introducing-remux"),
  },
};

export default function IntroducingRemuxPage() {
  return (
    <>
      <div className="mb-8">
        <Link
          href="/blog"
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back to blog
        </Link>
      </div>

      <h1>Introducing remux</h1>
      <time dateTime="2026-02-12" className="text-sm text-muted">February 12, 2026</time>

      <p className="mt-6">
        remux is a native macOS terminal application built on top of Ghostty,
        designed from the ground up for developers who run multiple AI coding
        agents simultaneously.
      </p>

      <h2>Why remux?</h2>
      <p>
        Modern development workflows often involve running several agents at
        once. Claude Code, Codex, and other tools each in their own
        terminal. Keeping track of which ones need attention and switching
        between them quickly is the problem remux solves.
      </p>

      <h2>Key features</h2>
      <ul>
        <li>
          <strong>Vertical tabs</strong> : see all your terminals at a
          glance in a sidebar
        </li>
        <li>
          <strong>Notification rings</strong> : tabs flash when an agent
          needs your input
        </li>
        <li>
          <strong>Split panes</strong> : horizontal and vertical splits
          within each workspace
        </li>
        <li>
          <strong>Socket API</strong> : programmatic control for creating
          tabs and sending input
        </li>
        <li>
          <strong>GPU-accelerated</strong> : powered by libghostty for
          smooth rendering
        </li>
      </ul>

      <h2>Get started</h2>
      <p>
        Install remux via Homebrew or download the DMG from the{" "}
        <Link href="/docs/getting-started">getting started guide</Link>.
      </p>
    </>
  );
}
