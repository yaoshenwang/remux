const normalize = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const isExplicitRuntimeV2TargetConfigured = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(normalize(env.REMUXD_BASE_URL) || normalize(env.REMUXD_BIN));

export const isRuntimeV2Required = (env: NodeJS.ProcessEnv): boolean =>
  normalize(env.REMUX_RUNTIME_V2_REQUIRED) === "1" || isExplicitRuntimeV2TargetConfigured(env);

export const shouldAllowLegacyFallback = (env: NodeJS.ProcessEnv): boolean =>
  !isRuntimeV2Required(env);
