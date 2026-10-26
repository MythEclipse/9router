function buildServerEnv({ baseEnv = process.env, port, host } = {}) {
  return {
    ...baseEnv,
    PORT: String(port),
    HOSTNAME: host,
  };
}


export { buildServerEnv };
