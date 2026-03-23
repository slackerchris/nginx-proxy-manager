import { IconAlertTriangle, IconDownload, IconUpload } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { createBackup, restoreBackup } from "src/api/backend";
import { Button } from "src/components";
import { T } from "src/locale";
import { showError, showSuccess } from "src/notifications";

export default function BackupSection() {
	const [isDownloading, setIsDownloading] = useState(false);
	const [isRestoring, setIsRestoring] = useState(false);
	const [restoreFile, setRestoreFile] = useState<File | null>(null);
	const [restoreConfirmed, setRestoreConfirmed] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleCreateBackup = async () => {
		setIsDownloading(true);
		try {
			await createBackup();
		} catch (err) {
			showError(err instanceof Error ? err.message : "Backup failed");
		} finally {
			setIsDownloading(false);
		}
	};

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0] ?? null;
		setRestoreFile(file);
		setRestoreConfirmed(false);
	};

	const handleRestore = async () => {
		if (!restoreFile || !restoreConfirmed) return;
		setIsRestoring(true);
		try {
			await restoreBackup(restoreFile);
			showSuccess("Restore complete. Please restart the service to apply changes.");
			setRestoreFile(null);
			setRestoreConfirmed(false);
			if (fileInputRef.current) fileInputRef.current.value = "";
		} catch (err) {
			showError(err instanceof Error ? err.message : "Restore failed");
		} finally {
			setIsRestoring(false);
		}
	};

	return (
		<div className="card mt-4">
			<div className="card-status-top bg-orange" />
			<div className="card-header">
				<h2 className="mt-1 mb-0">
					<T id="backup.title" />
				</h2>
			</div>
			<div className="card-body">
				<div className="row g-4">
					{/* Create Backup */}
					<div className="col-12 col-md-6">
						<h3 className="card-title">
							<T id="backup.create" />
						</h3>
						<p className="text-secondary">
							<T id="backup.create.description" />
						</p>
						<ul className="text-secondary small mb-3 ps-3">
							<li>
								<T id="backup.contents.database" />
							</li>
							<li>
								<T id="backup.contents.nginx" />
							</li>
							<li>
								<T id="backup.contents.certs" />
							</li>
						</ul>
						<Button
							color="azure"
							onClick={handleCreateBackup}
							isLoading={isDownloading}>
							<IconDownload width={16} className="me-1" />
							<T id="backup.create.button" />
						</Button>
					</div>

					{/* Restore from Backup */}
					<div className="col-12 col-md-6">
						<h3 className="card-title">
							<T id="backup.restore" />
						</h3>
						<div className="alert alert-warning d-flex align-items-start gap-2 mb-3">
							<IconAlertTriangle
								width={20}
								className="flex-shrink-0 mt-1"
							/>
							<span>
								<T id="backup.restore.warning" />
							</span>
						</div>
						<div className="mb-3">
							<input
								ref={fileInputRef}
								type="file"
								accept=".tar.gz,.tgz"
								className="form-control"
								onChange={handleFileChange}
							/>
						</div>
						{restoreFile && (
							<div className="mb-3">
								<label className="form-check">
									<input
										type="checkbox"
										className="form-check-input"
										checked={restoreConfirmed}
										onChange={(e) =>
											setRestoreConfirmed(
												e.target.checked,
											)
										}
									/>
									<span className="form-check-label text-danger fw-bold">
										<T id="backup.restore.confirm" />
									</span>
								</label>
							</div>
						)}
						<Button
							color="danger"
							onClick={handleRestore}
							isLoading={isRestoring}
							disabled={!restoreFile || !restoreConfirmed}>
							<IconUpload width={16} className="me-1" />
							<T id="backup.restore.button" />
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
