import type { Metadata } from "next";
import { CodeBlock } from "../../components/code-block";
import { Callout } from "../../components/callout";
import { DownloadButton } from "../../components/download-button";
import { repoUrl } from "../../site";

export const metadata: Metadata = {
  title: "Getting Started",
  description:
    "Install remux, the native macOS terminal for AI coding agents. DMG download, CLI setup, and auto-updates via Sparkle.",
};

export default function GettingStartedPage() {
  return (
    <>
      <h1>Getting Started</h1>
      <p>
        remux is a lightweight, native macOS terminal built on Ghostty for
        managing multiple AI coding agents. It features vertical tabs, a
        notification panel, and a socket-based control API.
      </p>

      <h2>Install</h2>

      <h3>DMG (recommended)</h3>
      <div className="my-4">
        <DownloadButton />
      </div>
      <p>
        Open the <code>.dmg</code> and drag remux to your Applications folder.
        remux auto-updates via Sparkle, so you only need to download once.
      </p>

      <h3>Homebrew</h3>
      <CodeBlock lang="bash">{`brew tap yaoshenwang/homebrew-tap
brew install --cask remux`}</CodeBlock>
      <p>To update later:</p>
      <CodeBlock lang="bash">{`brew upgrade --cask remux`}</CodeBlock>

      <Callout>
        On first launch, macOS may ask you to confirm opening an app from an
        identified developer. Click <strong>Open</strong> to proceed.
      </Callout>

      <h2>Verify installation</h2>
      <p>Open remux and you should see:</p>
      <ul>
        <li>A terminal window with a vertical tab sidebar on the left</li>
        <li>One initial workspace already open</li>
        <li>The Ghostty-powered terminal ready for input</li>
      </ul>

      <h2>CLI setup</h2>
      <p>
        remux includes a command-line tool for automation. Inside remux terminals
        it works automatically. To use the CLI from outside remux, create a
        symlink:
      </p>
      <CodeBlock lang="bash">{`sudo ln -sf "/Applications/remux.app/Contents/Resources/bin/remux" /usr/local/bin/remux`}</CodeBlock>
      <p>Then you can run commands like:</p>
      <CodeBlock lang="bash">{`remux list-workspaces
remux notify --title "Build Complete" --body "Your build finished"`}</CodeBlock>

      <h2>Auto-updates</h2>
      <p>
        remux checks for updates automatically via Sparkle. When an update is
        available you&apos;ll see an update pill in the titlebar. You can also
        check manually via <strong>remux → Check for Updates</strong> in the menu
        bar.
      </p>

      <h2>Session restore (current behavior)</h2>
      <p>After relaunch, remux restores layout and metadata only:</p>
      <ul>
        <li>Window, workspace, and pane layout</li>
        <li>Working directories</li>
        <li>Terminal scrollback (best effort)</li>
        <li>Browser URL and navigation history</li>
      </ul>
      <Callout>
        remux does not restore live process state yet. Active terminal app
        sessions such as Claude Code, tmux, and vim are not resumed after app
        restart.
      </Callout>

      <h2>Source of truth</h2>
      <p>
        The canonical release, changelog, and issue tracker for this branch are
        in the{" "}
        <a href={repoUrl} className="underline underline-offset-2 decoration-border hover:decoration-foreground transition-colors">
          GitHub repository
        </a>.
      </p>

      <h2>Requirements</h2>
      <ul>
        <li>macOS 14.0 or later</li>
        <li>Apple Silicon or Intel Mac</li>
      </ul>
    </>
  );
}
