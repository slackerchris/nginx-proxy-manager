import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import archiver from "archiver";
import { configGet, isSqlite } from "../lib/config.js";
import errs from "../lib/error.js";
import pjson from "../package.json" with { type: "json" };

const execFileAsync = promisify(execFile);

const DATA_DIR = "/data";

/**
 * Recursively copy a directory synchronously.
 * Used during restore to copy extracted dirs back into /data.
 */
function copyDirSync(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirSync(srcPath, destPath);
		} else {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}

const internalBackup = {
	/**
	 * Creates a backup archive and streams it directly to the Express response.
	 * Admin-only.
	 *
	 * Includes:
	 *   - SQLite database (if using SQLite)
	 *   - /data/nginx/ configs
	 *   - /data/letsencrypt/live/ and renewal/ (NOT accounts/)
	 *   - manifest.json
	 *
	 * @param  {Object}                    access
	 * @param  {import('express').Response} res
	 * @returns {Promise<void>}
	 */
	create: (access, res) => {
		return access.can("backup:create").then(() => {
			return new Promise((resolve, reject) => {
				const dbEngine = isSqlite()
					? "sqlite"
					: (configGet("database")?.engine || "unknown");
				const dbFile =
					process.env.DB_SQLITE_FILE || "/data/database.sqlite";

				const manifest = {
					version: pjson.version,
					created_at: new Date().toISOString(),
					db_engine: dbEngine,
					contents: [],
				};

				res.setHeader("Content-Type", "application/gzip");
				res.setHeader(
					"Content-Disposition",
					'attachment; filename="npm-backup.tar.gz"',
				);

				const archive = archiver("tar", { gzip: true });

				archive.on("error", (err) => {
					reject(
						new errs.InternalError(
							`Backup creation failed: ${err.message}`,
							err,
						),
					);
				});

				archive.pipe(res);

				// SQLite database
				if (isSqlite() && fs.existsSync(dbFile)) {
					archive.file(dbFile, { name: "database/database.sqlite" });
					manifest.contents.push("database");
				}

				// Nginx proxy configs
				const nginxDir = path.join(DATA_DIR, "nginx");
				if (fs.existsSync(nginxDir)) {
					archive.directory(nginxDir, "nginx");
					manifest.contents.push("nginx_config");
				}

				// Let's Encrypt — live and renewal only, never accounts/
				// (accounts/ is environment-specific and should not be restored across instances)
				const leLiveDir = path.join(DATA_DIR, "letsencrypt", "live");
				const leRenewalDir = path.join(
					DATA_DIR,
					"letsencrypt",
					"renewal",
				);
				const leRenewalHooksDir = path.join(
					DATA_DIR,
					"letsencrypt",
					"renewal-hooks",
				);

				if (fs.existsSync(leLiveDir)) {
					archive.directory(leLiveDir, "letsencrypt/live");
					manifest.contents.push("letsencrypt_live");
				}
				if (fs.existsSync(leRenewalDir)) {
					archive.directory(leRenewalDir, "letsencrypt/renewal");
					manifest.contents.push("letsencrypt_renewal");
				}
				if (fs.existsSync(leRenewalHooksDir)) {
					archive.directory(
						leRenewalHooksDir,
						"letsencrypt/renewal-hooks",
					);
				}

				// Manifest is appended last so contents list is complete
				archive.append(JSON.stringify(manifest, null, 2), {
					name: "manifest.json",
				});

				archive.finalize();

				res.on("finish", resolve);
				res.on("error", reject);
			});
		});
	},

	/**
	 * Restores a backup from an uploaded file buffer.
	 * Admin-only. Full restore only — no partial/merge support.
	 *
	 * Validates:
	 *   - Archive is a valid tar.gz
	 *   - No path traversal entries (zip-slip protection)
	 *   - manifest.json present with required fields
	 *   - DB engine matches current configuration
	 *
	 * After restore, a service restart is required.
	 *
	 * @param  {Object} access
	 * @param  {Buffer} fileBuffer
	 * @returns {Promise<Object>}
	 */
	restore: async (access, fileBuffer) => {
		await access.can("backup:create");

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-restore-"));
		const tmpArchive = path.join(tmpDir, "backup.tar.gz");
		const extractDir = path.join(tmpDir, "extracted");

		try {
			fs.mkdirSync(extractDir, { recursive: true });
			fs.writeFileSync(tmpArchive, fileBuffer);

			// List archive contents and validate for path traversal before extracting
			let listing;
			try {
				({ stdout: listing } = await execFileAsync("tar", [
					"-tzf",
					tmpArchive,
				]));
			} catch {
				throw new errs.ValidationError(
					"Invalid backup file: not a valid gzip archive",
				);
			}
			const entries = listing.split("\n").filter(Boolean);
			for (const entry of entries) {
				if (path.isAbsolute(entry) || entry.includes("../")) {
					throw new errs.ValidationError(
						"Invalid backup: archive contains unsafe file paths",
					);
				}
			}

			// Extract to isolated temp directory
			try {
				await execFileAsync("tar", ["-xzf", tmpArchive, "-C", extractDir]);
			} catch {
				throw new errs.ValidationError(
					"Invalid backup file: extraction failed",
				);
			}

			// Read and validate manifest
			const manifestPath = path.join(extractDir, "manifest.json");
			if (!fs.existsSync(manifestPath)) {
				throw new errs.ValidationError(
					"Invalid backup: manifest.json not found",
				);
			}

			let manifest;
			try {
				manifest = JSON.parse(
					fs.readFileSync(manifestPath, { encoding: "utf8" }),
				);
			} catch {
				throw new errs.ValidationError(
					"Invalid backup: manifest.json is corrupt or unreadable",
				);
			}

			if (
				!manifest.version ||
				!manifest.created_at ||
				!Array.isArray(manifest.contents)
			) {
				throw new errs.ValidationError(
					"Invalid backup: manifest.json is missing required fields",
				);
			}

			// Verify DB engine matches so we don't restore a MySQL backup onto a SQLite instance (or vice versa)
			const currentEngine = isSqlite()
				? "sqlite"
				: (configGet("database")?.engine || "unknown");
			if (manifest.db_engine !== currentEngine) {
				throw new errs.ValidationError(
					`Backup DB engine (${manifest.db_engine}) does not match current configuration (${currentEngine})`,
				);
			}

			// Restore: database
			if (manifest.contents.includes("database")) {
				const backupDb = path.join(
					extractDir,
					"database",
					"database.sqlite",
				);
				if (!fs.existsSync(backupDb)) {
					throw new errs.ValidationError(
						"Backup claims to contain database but database/database.sqlite is missing",
					);
				}
				const targetDb =
					process.env.DB_SQLITE_FILE || "/data/database.sqlite";
				fs.copyFileSync(backupDb, targetDb);
			}

			// Restore: nginx config
			if (manifest.contents.includes("nginx_config")) {
				const backupNginx = path.join(extractDir, "nginx");
				if (fs.existsSync(backupNginx)) {
					copyDirSync(backupNginx, path.join(DATA_DIR, "nginx"));
				}
			}

			// Restore: letsencrypt live certs
			if (manifest.contents.includes("letsencrypt_live")) {
				const src = path.join(extractDir, "letsencrypt", "live");
				if (fs.existsSync(src)) {
					copyDirSync(
						src,
						path.join(DATA_DIR, "letsencrypt", "live"),
					);
				}
			}

			// Restore: letsencrypt renewal configs
			if (manifest.contents.includes("letsencrypt_renewal")) {
				const src = path.join(extractDir, "letsencrypt", "renewal");
				if (fs.existsSync(src)) {
					copyDirSync(
						src,
						path.join(DATA_DIR, "letsencrypt", "renewal"),
					);
				}
			}

			return {
				restored_at: new Date().toISOString(),
				backup_created_at: manifest.created_at,
				backup_version: manifest.version,
				contents: manifest.contents,
				restart_required: true,
			};
		} finally {
			// Always clean up temp files regardless of success or failure
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	},
};

export default internalBackup;
