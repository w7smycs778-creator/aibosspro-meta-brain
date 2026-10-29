// Runs once when the Next.js server starts; a bad config exits the process.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { refuseStartOnBadConfig } = await import("@/lib/startup");
  refuseStartOnBadConfig();
}
