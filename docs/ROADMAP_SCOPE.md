# Roadmap Scope

This document keeps the current roadmap honest. It separates immediate shipping work from optional follow-ons and longer-horizon research.

## v1 Must Ship

- Keep the public runtime substrate on Zellij.
- Harden the Node.js + TypeScript gateway.
- Improve Inspect, Live, and Control for web and mobile browser usage.
- Preserve current authentication, safety, and test gates.
- Build protocol, storage, and runtime boundaries that do not require a rewrite.

## v1.5 Optional

- Desktop host alpha work once it can launch the existing gateway cleanly.
- Device trust and pairing UX on top of the current gateway.
- Deeper review, artifact, and worktree flows.
- Adapter growth that still preserves the Zellij-era baseline.

## v2 / Research

- Rust sidecars, indexing workers, or bridge processes.
- Native mobile shells beyond thin-host or command-center experiments.
- Collaboration shell objects such as Topic, Run, Artifact, and Approval as first-class product layers.
- Team mode, permissions, and multi-operator coordination.

## Scope Rules

- Research lines do not block current shipping work.
- New proposals should say whether they belong to v1, v1.5, or research before implementation starts.
- If a task depends on replacing Zellij outright, it is not v1 work.

