export interface Env {
  readonly handoffPort: number | undefined;
  readonly clientId: string | undefined;
}

export interface EnvReader {
  read(): Env;
}

export const defaultEnvReader: EnvReader = {
  read(): Env {
    const portStr = process.env.UNIFIEDAI_HANDOFF_PORT;
    const port = portStr ? Number.parseInt(portStr, 10) : Number.NaN;
    return {
      handoffPort: Number.isFinite(port) ? port : undefined,
      clientId: process.env.UNIFIEDAI_CLIENT_ID,
    };
  },
};
