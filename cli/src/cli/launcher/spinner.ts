import net from "node:net"

/** How long to wait for killed processes to actually go away. */
const PROCESS_EXIT_WAIT_MS = 3000
/** How long to wait for a killed process to release the port. */
const PORT_RELEASE_WAIT_MS = 5000

/**
 * Native spinner - no external dependency.
 *
 * Writes on one line and clears it on stop, and stays silent when stdout is not a
 * TTY (piped, redirected, CI), so nothing has to guard its output.
 */
function createSpinner(text: string) {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
	let i = 0
	let interval: ReturnType<typeof setInterval> | null = null
	const currentText = text
	return {
		start() {
			if (process.stdout.isTTY) {
				process.stdout.write(`\r${frames[0]} ${currentText}`)
				interval = setInterval(() => {
					process.stdout.write(`\r${frames[i++ % frames.length]} ${currentText}`)
				}, 80)
			}
			return this
		},
		stop() {
			if (interval) {
				clearInterval(interval)
				interval = null
			}
			if (process.stdout.isTTY) {
				process.stdout.write("\r\x1b[K")
			}
		},
		succeed(msg: string) {
			this.stop()
			console.log(`✅ ${msg}`)
		},
		fail(msg: string) {
			this.stop()
			console.log(`❌ ${msg}`)
		},
	}
}

// Poll until the server accepts TCP connections on port, or timeout — avoids blind fixed waits.
function waitServerReady(port, { timeoutMs = 15000, intervalMs = 150 } = {}) {
	const deadline = Date.now() + timeoutMs
	return new Promise((resolve) => {
		const tryConnect = () => {
			const socket = net.connect({ host: "127.0.0.1", port }, () => {
				socket.destroy()
				resolve(true)
			})
			socket.on("error", () => {
				socket.destroy()
				if (Date.now() >= deadline) return resolve(false)
				setTimeout(tryConnect, intervalMs)
			})
		}
		tryConnect()
	})
}

export { createSpinner, PORT_RELEASE_WAIT_MS, PROCESS_EXIT_WAIT_MS, waitServerReady }
