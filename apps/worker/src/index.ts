/**
 * Worker bootstrap stub.
 * Actual run orchestration will be implemented in MVP 1 tickets.
 */
export interface RunSearchProfileJob {
  searchProfileId: string;
  requestedAt: Date;
}

export async function runSearchProfileJob(_job: RunSearchProfileJob): Promise<void> {
  throw new Error("Not implemented: runSearchProfileJob");
}
