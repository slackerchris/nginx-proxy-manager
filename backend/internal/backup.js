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
const LE_DIR = "/etc/letsencrypt";

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
	 *   - /etc/letsencrypt/live/ and renewal/ (NOT accounts/)
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
				const leLiveDir = path.join(LE_DIR, "live");
				const leRenewalDir = path.join(LE_DIR, "renewal");
				const leRenewalHooksDir = path.join(LE_DIR, "renewal-hooks");

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

			// If the archive was packed with a single top-level wrapper directory
			// (e.g. tar -czf backup.tar.gz npm-backup-20230101/), strip it so all
			// probes work regardless of how the user packed the archive.
			const topLevelEntries = fs.readdirSync(extractDir, { withFileTypes: true });
			const probeRoot = (
				topLevelEntries.length === 1 && topLevelEntries[0].isDirectory()
					? path.join(extractDir, topLevelEntries[0].name)
					: extractDir
			);

			// Read and validate manifest — fall back to legacy auto-detect if absent
			const manifestPath = path.join(probeRoot, "manifest.json");
			let manifest = null;
			let isLegacy = false;

			if (fs.existsSync(manifestPath)) {
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
			} else {
				// Legacy backup (no manifest.json) — auto-detect from well-known paths.
				// Supports archives rooted at /data/, data/, or the contents directly.
				isLegacy = true;
				manifest = { version: "legacy", created_at: null, contents: [] };
			}

			const targetDb = process.env.DB_SQLITE_FILE || "/data/database.sqlite";

			if (isLegacy) {
				// Probe for the SQLite file in common legacy locations
				const dbCandidates = [
					path.join(probeRoot, "database.sqlite"),
					path.join(probeRoot, "database", "database.sqlite"),
					path.join(probeRoot, "data", "database.sqlite"),
				];
				const foundDb = dbCandidates.find((p) => fs.existsSync(p));
				if (foundDb) {
					fs.copyFileSync(foundDb, targetDb);
					manifest.contents.push("database");
				}

				// Probe for nginx config
				const nginxCandidates = [
					path.join(probeRoot, "nginx"),
					path.join(probeRoot, "data", "nginx"),
				];
				for (const src of nginxCandidates) {
					if (fs.existsSync(src)) {
						copyDirSync(src, path.join(DATA_DIR, "nginx"));
						manifest.contents.push("nginx_config");
						break;
					}
				}

				// Probe for letsencrypt live
				const leLiveCandidates = [
					path.join(probeRoot, "letsencrypt", "live"),
					path.join(probeRoot, "data", "letsencrypt", "live"),
				];
				for (const src of leLiveCandidates) {
					if (fs.existsSync(src)) {
						copyDirSync(src, path.join(LE_DIR, "live"));
						manifest.contents.push("letsencrypt_live");
						break;
					}
				}

				// Probe for letsencrypt renewal
				const leRenewalCandidates = [
					path.join(probeRoot, "letsencrypt", "renewal"),
					path.join(probeRoot, "data", "letsencrypt", "renewal"),
				];
				for (const src of leRenewalCandidates) {
					if (fs.existsSync(src)) {
						copyDirSync(src, path.join(LE_DIR, "renewal"));
						manifest.contents.push("letsencrypt_renewal");
						break;
					}
				}

				if (manifest.contents.length === 0) {
					throw new errs.ValidationError(
						"Could not find any recognisable data in this archive (no database, nginx, or letsencrypt directories found)",
					);
				}
			} else {
				// Restore: database
				if (manifest.contents.includes("database")) {
					const backupDb = path.join(probeRoot, "database", "database.sqlite");
					if (!fs.existsSync(backupDb)) {
						throw new errs.ValidationError(
							"Backup claims to contain database but database/database.sqlite is missing",
						);
					}
					fs.copyFileSync(backupDb, targetDb);
				}

				// Restore: nginx config
				if (manifest.contents.includes("nginx_config")) {
					const backupNginx = path.join(probeRoot, "nginx");
					if (fs.existsSync(backupNginx)) {
						copyDirSync(backupNginx, path.join(DATA_DIR, "nginx"));
					}
				}

				// Restore: letsencrypt live certs
				if (manifest.contents.includes("letsencrypt_live")) {
					const src = path.join(probeRoot, "letsencrypt", "live");
					if (fs.existsSync(src)) {
						copyDirSync(src, path.join(LE_DIR, "live"));
					}
				}

				// Restore: letsencrypt renewal configs
				if (manifest.contents.includes("letsencrypt_renewal")) {
					const src = path.join(probeRoot, "letsencrypt", "renewal");
					if (fs.existsSync(src)) {
						copyDirSync(src, path.join(LE_DIR, "renewal"));
					}
				}
			}

			return {
				restored_at: new Date().toISOString(),
				backup_created_at: manifest.created_at,
				backup_version: manifest.version,
				contents: manifest.contents,
				restart_required: true,
				legacy_import: isLegacy,
			};
		} finally {
			// Always clean up temp files regardless of success or failure
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	},
};

export default internalBackup;
