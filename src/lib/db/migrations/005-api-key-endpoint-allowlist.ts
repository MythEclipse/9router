const migration = {
  version: 5,
  name: "api key endpoint allowlist",
  up(db) {
    const columns = db.all("PRAGMA table_info(apiKeys)");
    if (!columns.some((column) => column.name === "allowedEndpoints")) {
      db.exec("ALTER TABLE apiKeys ADD COLUMN allowedEndpoints TEXT NOT NULL DEFAULT '[]'");
    }
  },
};

export default migration;
