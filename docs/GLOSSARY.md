# Glossary

## Workspace

The full shared execution environment that Remux exposes remotely. In the current product, a workspace is anchored by one Zellij session plus the gateway and web surfaces around it.

## Session

The top-level Zellij session targeted by the current Remux server instance.

## Tab

A Zellij tab inside the shared session.

## Pane

A Zellij pane inside a tab. Pane identity should be stable enough for inspect, focus, and control actions.

## Inspect

The readable history and catch-up surface for understanding workspace state without attaching directly to raw terminal I/O.

## Live

The direct terminal surface that carries raw shell input and output.

## Control

The structured navigation and mutation surface for tabs, panes, and session-level actions.

## Topic

A future product object used to group related work, context, runs, artifacts, and review state around one thread of work.

## Run

A future execution object representing one bounded agent or automation attempt with state, inputs, outputs, and ownership.

## Artifact

A future durable output object such as a diff, log bundle, generated file set, or reviewable result.

## Approval

A future user decision object used to gate risky or user-visible actions.

## Device

A trusted or untrusted client endpoint that connects to a Remux workspace, such as a browser, phone, tablet, or desktop host.

## Share

A permissioned access path to the current workspace. Today this is mostly token/password plus optional tunnel exposure. Future pairing and trust flows build on top of this.

