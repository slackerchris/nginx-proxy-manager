import * as api from "./base";

export async function restartService(): Promise<{ restarting: boolean }> {
	return api.post({ url: "/backup/restart" });
}
