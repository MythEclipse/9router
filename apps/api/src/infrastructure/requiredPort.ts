/**
 * Take a port the host must have supplied, or refuse to build the graph.
 *
 * A factory that invented a stand-in would start successfully and then do nothing — a
 * tunnel that reports success without touching a socket, an import that answers "0 imported"
 * without reading a file. Failing here instead puts the name of the missing port in front of
 * whoever wired the host, before any request is served.
 */
export function required<T>(ports: Readonly<Record<string, T | null | undefined>>, key: string): T {
	const value = ports[key]
	if (value == null) {
		throw new Error(`The use-case graph needs ${key}; this host did not supply it`)
	}
	return value
}
