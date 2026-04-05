# Glossary

## Workspace

The full shared execution environment that Remux exposes remotely. In the current product, a workspace is anchored by the Node.js gateway, persisted device state, and one or more PTY-backed sessions.

## Session

A named logical workspace managed by the current Remux server instance.

## Tab

A PTY-backed terminal tab inside a session.

## Pane

A future split region or sub-surface within a tabbed session view. It is not the current web runtime primitive.

## Inspect

The readable history and catch-up surface for understanding workspace state without attaching directly to raw terminal I/O.

## Live

The direct terminal surface that carries raw shell input and output.

## Control

The structured navigation and mutation surface for sessions, tabs, devices, and workspace objects.

## Topic

A workspace object used to group related work, context, runs, artifacts, and review state around one thread of work.

## Run

A bounded execution object representing one command, agent, or automation attempt with state, inputs, outputs, and ownership.

## Artifact

A durable output object such as a diff, log bundle, snapshot, generated file set, or reviewable result.

## Approval

A user decision object used to gate risky or user-visible actions.

## Device

A trusted or untrusted client endpoint that connects to a Remux workspace, such as a browser, phone, tablet, or desktop host.

## Share

A permissioned access path to the current workspace. Today this is mostly token/password plus optional tunnel exposure. Future pairing and trust flows build on top of this.
