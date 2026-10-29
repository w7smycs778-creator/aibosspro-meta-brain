// Runs once when the Next.js server starts; a bad config exits the process,
// then half-finished turns from a previous process are resumed.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { refuseStartOnBadConfig, resumeAtStartup } = await import("@/lib/startup");
  refuseStartOnBadConfig();
  await resumeAtStartup();
}
