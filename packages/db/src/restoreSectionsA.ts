/**
 * Restore sections: settings and providers.
 *
 * Extracted verbatim from restoreSections.ts.
 */

import { asArray, json, now, type SectionRestore } from "./restoreTypes.ts"

export const settingsSection: SectionRestore = {
	name: "settings",
	sectionKeys: ["settings"],
	restore(db, payload) {
		if (payload.settings === undefined) return
		db.run(`DELETE FROM settings`)
		db.run(
			`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
			[json(payload.settings)],
		)
	},
}

export const providersSection: SectionRestore = {
	// Providers, nodes and proxy pools restore together: a connection points at a
	// node by id, so restoring one without the others leaves dangling references.
	name: "providers",
	sectionKeys: ["providerConnections", "providerNodes", "proxyPools"],
	restore(db, payload) {
		if (payload.providerConnections !== undefined) {
			db.run(`DELETE FROM providerConnections`)
			for (const c of asArray<Record<string, unknown>>(payload.providerConnections)) {
				const {
					id,
					provider,
					authType,
					name,
					email,
					priority,
					isActive,
					createdAt,
					updatedAt,
					...rest
				} = c
				db.run(
					`INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						provider,
						authType || "oauth",
						name || null,
						email || null,
						priority || null,
						isActive === false ? 0 : 1,
						json(rest),
						createdAt || now(),
						updatedAt || now(),
					],
				)
			}
		}

		if (payload.providerNodes !== undefined) {
			db.run(`DELETE FROM providerNodes`)
			for (const n of asArray<Record<string, unknown>>(payload.providerNodes)) {
				const { id, type, name, createdAt, updatedAt, ...rest } = n
				db.run(
					`INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
					[id, type || null, name || null, json(rest), createdAt || now(), updatedAt || now()],
				)
			}
		}

		if (payload.proxyPools !== undefined) {
			db.run(`DELETE FROM proxyPools`)
			for (const p of asArray<Record<string, unknown>>(payload.proxyPools)) {
				const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p
				db.run(
					`INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
					[
						id,
						isActive === false ? 0 : 1,
						testStatus || "unknown",
						json(rest),
						createdAt || now(),
						updatedAt || now(),
					],
				)
			}
		}
	},
}
