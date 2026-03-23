import * as api from "./base";

export interface RestoreResult {
	restoredAt: string;
	backupCreatedAt: string;
	backupVersion: string;
	contents: string[];
	restartRequired: boolean;
}

export async function restoreBackup(file: File): Promise<RestoreResult> {
	const formData = new FormData();
	formData.append("backup", file);
	return api.post({ url: "/backup/restore", data: formData });
}
