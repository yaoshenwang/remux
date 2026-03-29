import type { RuntimeV2Metadata } from "./types.js";

export interface RuntimeV2Contract {
  protocolVersion: string;
  controlWebsocketPath: string;
  terminalWebsocketPath: string;
}

export const EXPECTED_RUNTIME_V2_CONTRACT: RuntimeV2Contract = Object.freeze({
  protocolVersion: "2026-03-27-draft",
  controlWebsocketPath: "/v2/control",
  terminalWebsocketPath: "/v2/terminal",
});

export const runtimeV2ContractFromMetadata = (
  metadata: Pick<RuntimeV2Metadata, "protocolVersion" | "controlWebsocketPath" | "terminalWebsocketPath">,
): RuntimeV2Contract => ({
  protocolVersion: metadata.protocolVersion,
  controlWebsocketPath: metadata.controlWebsocketPath,
  terminalWebsocketPath: metadata.terminalWebsocketPath,
});

export const runtimeV2ContractMismatches = (
  contract: RuntimeV2Contract,
  expected: RuntimeV2Contract = EXPECTED_RUNTIME_V2_CONTRACT,
): string[] => {
  const mismatches: string[] = [];
  if (contract.protocolVersion !== expected.protocolVersion) {
    mismatches.push(`protocolVersion expected=${expected.protocolVersion} actual=${contract.protocolVersion}`);
  }
  if (contract.controlWebsocketPath !== expected.controlWebsocketPath) {
    mismatches.push(
      `controlWebsocketPath expected=${expected.controlWebsocketPath} actual=${contract.controlWebsocketPath}`,
    );
  }
  if (contract.terminalWebsocketPath !== expected.terminalWebsocketPath) {
    mismatches.push(
      `terminalWebsocketPath expected=${expected.terminalWebsocketPath} actual=${contract.terminalWebsocketPath}`,
    );
  }
  return mismatches;
};

export const describeRuntimeV2Contract = (contract: RuntimeV2Contract): string =>
  `protocol=${contract.protocolVersion} control=${contract.controlWebsocketPath} terminal=${contract.terminalWebsocketPath}`;

export const assertCompatibleRuntimeV2Metadata = (metadata: RuntimeV2Metadata): void => {
  const contract = runtimeV2ContractFromMetadata(metadata);
  const mismatches = runtimeV2ContractMismatches(contract);
  if (mismatches.length === 0) {
    return;
  }

  throw new Error(
    `runtime-v2 contract mismatch: expected ${describeRuntimeV2Contract(EXPECTED_RUNTIME_V2_CONTRACT)} but got ${describeRuntimeV2Contract(contract)} (${mismatches.join(
      ", ",
    )})`,
  );
};
