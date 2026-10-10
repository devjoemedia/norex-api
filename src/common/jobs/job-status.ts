// When each in-process background job last ran, for the system health page. In
// memory: it resets on restart (Render's free plan sleeps), which the page says.
export interface JobRun {
  at: string;
  ok: boolean;
  note?: string;
}

const runs = new Map<string, JobRun>();

export function recordJobRun(job: string, ok: boolean, note?: string): void {
  runs.set(job, { at: new Date().toISOString(), ok, note });
}

export function jobRuns(): Record<string, JobRun | null> {
  return {
    collections: runs.get('collections') ?? null,
    rollups: runs.get('rollups') ?? null,
  };
}
