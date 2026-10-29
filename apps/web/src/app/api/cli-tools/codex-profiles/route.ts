import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	codexProfile,
	codexProfileFile,
	codexProfileToml,
	isValidCodexModel,
	isValidProfileName,
	normaliseProfileName,
	profileNameFromFile,
	readProfileModel,
} from "9router-api/domain/codex-profiles"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const getCodexDir = () => path.join(os.homedir(), ".codex")

// GET - List every custom profile under ~/.codex/*.config.toml
export async function GET() {
	try {
		const codexDir = getCodexDir()
		let files: string[]
		try {
			files = await fs.readdir(codexDir)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return NextResponse.json({ profiles: [] })
			}
			throw error
		}

		const profiles = await Promise.all(
			files
				.map((file) => profileNameFromFile(file))
				.filter((name): name is string => name !== null)
				.map(async (name) => {
					try {
						const content = await fs.readFile(path.join(codexDir, codexProfileFile(name)), "utf-8")
						return codexProfile(name, readProfileModel(content))
					} catch {
						// A profile whose file cannot be read is still a profile the operator made.
						return codexProfile(name, "")
					}
				}),
		)

		profiles.sort((a, b) => a.name.localeCompare(b.name))
		return NextResponse.json({ profiles })
	} catch (error) {
		console.error("Error reading codex profiles:", error)
		return NextResponse.json({ error: "Failed to read profiles" }, { status: 500 })
	}
}

// POST - Create or update a profile ~/.codex/<name>.config.toml
export async function POST(request: Request) {
	try {
		const body = (await request.json()) as { name?: unknown; model?: unknown }

		const cleanName = normaliseProfileName(body.name)
		if (!isValidProfileName(cleanName)) {
			return NextResponse.json(
				{
					error:
						"Profile name can only contain alphanumeric characters, dashes, underscores and cannot be 'config'",
				},
				{ status: 400 },
			)
		}

		const cleanModel = typeof body.model === "string" ? body.model.trim() : ""
		if (!isValidCodexModel(cleanModel)) {
			return NextResponse.json({ error: "Invalid model name" }, { status: 400 })
		}

		const codexDir = getCodexDir()
		await fs.mkdir(codexDir, { recursive: true })
		await fs.writeFile(
			path.join(codexDir, codexProfileFile(cleanName)),
			codexProfileToml(cleanName, cleanModel),
			"utf-8",
		)

		return NextResponse.json({ success: true, profile: codexProfile(cleanName, cleanModel) })
	} catch (error) {
		console.error("Error saving codex profile:", error)
		return NextResponse.json({ error: "Failed to save profile" }, { status: 500 })
	}
}

// DELETE - Remove a profile ~/.codex/<name>.config.toml
export async function DELETE(request: Request) {
	try {
		const body = (await request.json()) as { name?: unknown }
		const cleanName = normaliseProfileName(body.name)

		if (!isValidProfileName(cleanName)) {
			return NextResponse.json({ error: "Invalid profile name" }, { status: 400 })
		}

		try {
			await fs.unlink(path.join(getCodexDir(), codexProfileFile(cleanName)))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return NextResponse.json({ error: "Profile not found" }, { status: 404 })
			}
			throw error
		}

		return NextResponse.json({ success: true, message: `Profile ${cleanName} deleted` })
	} catch (error) {
		console.error("Error deleting codex profile:", error)
		return NextResponse.json({ error: "Failed to delete profile" }, { status: 500 })
	}
}
