// Performance indexes on usageHistory and requestDetails for query optimization.
export default {
  version: 2,
  name: "performance-indexes",
  up(db) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_provider_ts ON usageHistory(provider, timestamp DESC);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_model_ts ON usageHistory(model, timestamp DESC);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_conn_ts ON usageHistory(connectionId, timestamp DESC);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_api_key_ts ON usageHistory(apiKey, timestamp DESC);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_endpoint_ts ON usageHistory(endpoint, timestamp DESC);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_rd_status_ts ON requestDetails(status, timestamp DESC);");
  },
};
