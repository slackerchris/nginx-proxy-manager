import express from "express";
import internalBackup from "../internal/backup.js";
import errs from "../lib/error.js";
import jwtdecode from "../lib/express/jwt-decode.js";
import { debug, express as logger } from "../logger.js";

const router = express.Router({
	caseSensitive: true,
	strict: true,
	mergeParams: true,
});

/**
 * GET /api/backup
 *
 * Create and stream a backup archive. Admin only.
 * Returns a tar.gz file containing the database, nginx configs, and SSL certs.
 */
router
	.route("/")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.get(async (req, res, next) => {
		try {
			await internalBackup.create(res.locals.access, res);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

/**
 * POST /api/backup/restore
 *
 * Restore from an uploaded backup archive. Admin only.
 * Expects multipart form data with a 'backup' file field.
 * Returns restore metadata. A service restart is required after success.
 */
router
	.route("/restore")
	.options((_, res) => {
		res.sendStatus(204);
	})
	.all(jwtdecode())
	.post(async (req, res, next) => {
		try {
			if (!req.files || !req.files.backup) {
				throw new errs.ValidationError("No backup file provided");
			}
			// express-fileupload: file may be an array if the field is repeated
			const file = Array.isArray(req.files.backup)
				? req.files.backup[0]
				: req.files.backup;

			const result = await internalBackup.restore(
				res.locals.access,
				file.data,
			);
			res.status(200).send(result);
		} catch (err) {
			debug(logger, `${req.method.toUpperCase()} ${req.path}: ${err}`);
			next(err);
		}
	});

export default router;
