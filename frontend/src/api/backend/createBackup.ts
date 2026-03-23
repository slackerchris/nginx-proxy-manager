import * as api from "./base";

export async function createBackup(): Promise<void> {
	const date = new Date().toISOString().split("T")[0];
	await api.download({ url: "/backup" }, `npm-backup-${date}.tar.gz`);
}
