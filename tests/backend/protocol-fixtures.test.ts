import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import { parseEnvelope } from "../../src/backend/protocol/envelope.js";

const repoRoot = process.cwd();
const schemaRoot = path.join(repoRoot, "docs", "protocols", "schemas");
const fixtureRoot = path.join(repoRoot, "tests", "fixtures", "protocol");

const schemaFiles = [
  "core.schema.json",
  "runtime.schema.json",
  "inspect.schema.json",
  "admin.schema.json",
] as const;

const fixtureMatrix = [
  { domain: "core", file: "auth_ok.legacy.json", wire: "legacy", type: "auth_ok" },
  { domain: "core", file: "auth_error.legacy.json", wire: "legacy", type: "auth_error" },
  { domain: "core", file: "error.legacy.json", wire: "legacy", type: "error" },
  { domain: "core", file: "pong.legacy.json", wire: "legacy", type: "pong" },
  { domain: "runtime", file: "workspace_state.legacy.json", wire: "legacy", type: "workspace_state" },
  { domain: "runtime", file: "workspace_state.envelope.json", wire: "envelope", type: "workspace_state" },
  { domain: "inspect", file: "request_inspect.legacy.json", wire: "legacy", type: "request_inspect" },
  { domain: "inspect", file: "request_inspect.envelope.json", wire: "envelope", type: "request_inspect" },
  { domain: "inspect", file: "inspect_snapshot.legacy.json", wire: "legacy", type: "inspect_snapshot" },
  { domain: "inspect", file: "inspect_snapshot.envelope.json", wire: "envelope", type: "inspect_snapshot" },
  { domain: "admin", file: "bandwidth_stats.legacy.json", wire: "legacy", type: "bandwidth_stats" },
  { domain: "admin", file: "bandwidth_stats.envelope.json", wire: "envelope", type: "bandwidth_stats" },
] as const;

describe("protocol schemas and golden fixtures", () => {
  it("ships domain schema files for core/runtime/inspect/admin", () => {
    for (const schemaFile of schemaFiles) {
      const schemaPath = path.join(schemaRoot, schemaFile);
      expect(fs.existsSync(schemaPath), `${schemaFile} should exist`).toBe(true);
    }
  });

  it("validates every fixture against its domain schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validators = new Map<string, ReturnType<Ajv2020["compile"]>>();

    for (const schemaFile of schemaFiles) {
      const schemaPath = path.join(schemaRoot, schemaFile);
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      validators.set(schemaFile.replace(".schema.json", ""), ajv.compile(schema));
    }

    for (const fixture of fixtureMatrix) {
      const fixturePath = path.join(fixtureRoot, fixture.domain, fixture.file);
      expect(fs.existsSync(fixturePath), `${fixturePath} should exist`).toBe(true);
      const payload = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
      if (fixture.wire === "envelope") {
        const validate = validators.get(fixture.domain);
        expect(validate, `${fixture.domain} validator should exist`).toBeTypeOf("function");
        const valid = validate!(payload);
        expect(valid, `${fixture.file} should satisfy ${fixture.domain}.schema.json`).toBe(true);
        continue;
      }

      const parsed = parseEnvelope(payload, {
        source: legacySourceFor(fixture.type),
      });
      expect(parsed, `${fixture.file} should be parseable`).not.toBeNull();
      const validate = validators.get("core");
      expect(validate, "core validator should exist").toBeTypeOf("function");
      const valid = validate!(parsed);
      expect(valid, `${fixture.file} should satisfy core.schema.json after parseEnvelope`).toBe(true);
    }
  });

  it("keeps envelope and legacy fixtures parseable through the TypeScript contract layer", () => {
    for (const fixture of fixtureMatrix) {
      const fixturePath = path.join(fixtureRoot, fixture.domain, fixture.file);
      const payload = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
      const envelope = parseEnvelope(payload, {
        allowLegacyFallback: fixture.wire === "legacy",
      });

      expect(envelope).not.toBeNull();
      if (fixture.wire === "envelope") {
        expect(envelope?.domain).toBe(fixture.domain);
      }
      expect(envelope?.type).toBe(fixture.type);
    }
  });
});

function legacySourceFor(type: string): "server" | "client" {
  return type === "request_inspect" ? "client" : "server";
}
